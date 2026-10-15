import Anthropic from "@anthropic-ai/sdk";
import type { Approvals } from "./approvals.ts";
import { BROWSER_TOOL, type BrowserPool } from "./browser.ts";
import type { Config } from "./config.ts";
import type { Connectors, ConnectorTool } from "./connectors.ts";
import { bus } from "./events.ts";
import { decide, loadPolicy, type RolePolicy, type ToolMeta } from "./policy.ts";
import type { Provider } from "./provider.ts";
import type { Message, Store } from "./store.ts";
import { TOOL_DEFS, executeTool, type ToolOutput } from "./tools.ts";

/** Extra tools a caller (e.g. a channel) adds to one run. */
export interface ExtraTools {
  defs: Anthropic.Tool[];
  handle(name: string, input: Record<string, any>): Promise<{ content: ToolOutput; isError: boolean }>;
}

export interface RunOptions {
  extra?: ExtraTools;
  signal?: AbortSignal;
  taskId?: string;
}

export interface RunResult {
  sessionId: string;
  text: string;
  turns: number;
  stopReason: string | null;
}

export interface AgentDeps {
  approvals: Approvals;
  browser?: BrowserPool;
  connectors?: Connectors;
  provider: Provider;
}

const KEEP_RECENT = 12;

/**
 * The agent loop: model call → run requested tools → feed results back,
 * until the model stops asking for tools or the turn budget runs out.
 *
 * Every tool call passes the role's policy (allow / ask / deny); "ask" waits
 * for a person in the approval gateway. The session is saved after every step,
 * so a run interrupted by a restart can be resumed from where it stopped.
 * Runs on the same (role, session) are serialised.
 */
export class AgentRuntime {
  private locks = new Map<string, Promise<unknown>>();
  private config: Config;
  private store: Store;
  private deps: AgentDeps;

  constructor(config: Config, store: Store, deps: AgentDeps) {
    this.config = config;
    this.store = store;
    this.deps = deps;
  }

  /** Send `prompt` to the session, or pass null to resume an interrupted run. */
  run(roleId: string, sessionId: string, prompt: string | null, trigger: string, opts: RunOptions = {}): Promise<RunResult> {
    const key = `${roleId}/${sessionId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runUnlocked(roleId, sessionId, prompt, trigger, opts));
    this.locks.set(key, next);
    next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {});
    return next;
  }

  private async runUnlocked(
    roleId: string,
    sessionId: string,
    prompt: string | null,
    trigger: string,
    opts: RunOptions,
  ): Promise<RunResult> {
    await this.store.ensureRole(roleId);
    const policy = await loadPolicy(this.store.roleDir(roleId));
    let messages: Message[] = await this.store.loadSession(roleId, sessionId);
    if (prompt !== null) {
      // A run cancelled mid-tool-call leaves tool_use blocks without results;
      // answer them so the conversation stays valid.
      const dangling = pendingToolUses(messages.at(-1));
      messages.push({
        role: "user",
        content: dangling.length
          ? [
              ...dangling.map((u): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: u.id, content: "cancelled", is_error: true })),
              { type: "text", text: prompt },
            ]
          : prompt,
      });
    }
    await this.store.audit({ roleId, sessionId, taskId: opts.taskId, event: prompt === null ? "run_resume" : "run_start", trigger, prompt: prompt?.slice(0, 500) });

    const tools = this.toolsFor(policy, opts.extra);
    const system = await this.systemPrompt(roleId);
    const emitBase = { taskId: opts.taskId, roleId, sessionId };
    let turns = 0;
    let stopReason: string | null = null;
    let text = lastAssistantText(messages);

    while (true) {
      opts.signal?.throwIfAborted();
      const last = messages.at(-1);
      if (!last) break;

      if (last.role === "assistant") {
        const uses = pendingToolUses(last);
        if (uses.length === 0) break;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
          opts.signal?.throwIfAborted();
          bus.publish({ type: "tool_call", ...emitBase, tool: use.name, input: use.input });
          const r = await this.callTool(roleId, policy, tools, use, opts);
          bus.publish({ type: "tool_result", ...emitBase, tool: use.name, isError: r.isError });
          await this.store.audit({ roleId, sessionId, taskId: opts.taskId, event: "tool", tool: use.name, input: use.input, isError: r.isError, decision: r.decision });
          results.push({ type: "tool_result", tool_use_id: use.id, content: r.content, is_error: r.isError });
        }
        messages.push({ role: "user", content: results });
        await this.store.saveSession(roleId, sessionId, messages);
        continue;
      }

      if (turns >= this.config.maxTurns) {
        stopReason = "max_turns";
        text ||= `[stopped after ${turns} turns]`;
        break;
      }
      messages = await this.maybeCompact(roleId, sessionId, system, messages, opts.signal);
      turns++;
      const response = await this.deps.provider.client().messages.create(
        { model: this.deps.provider.current().model, max_tokens: 16_000, system, tools: tools.defs, messages },
        { signal: opts.signal },
      );
      await this.store.addUsage(roleId, this.deps.provider.current().model, response.usage);
      messages.push({ role: "assistant", content: response.content });
      await this.store.saveSession(roleId, sessionId, messages);
      stopReason = response.stop_reason;
      const t = blocksText(response.content);
      if (t) {
        text = t;
        bus.publish({ type: "text", ...emitBase, text: t });
      }
    }

    await this.store.audit({ roleId, sessionId, taskId: opts.taskId, event: "run_end", turns, stopReason });
    return { sessionId, text, turns, stopReason };
  }

  private toolsFor(policy: RolePolicy, extra?: ExtraTools) {
    const connectorTools = this.deps.connectors?.tools(policy.connectors) ?? [];
    const defs = [
      ...TOOL_DEFS,
      ...(this.deps.browser ? [BROWSER_TOOL] : []),
      ...connectorTools.map((t) => t.def),
      ...(extra?.defs ?? []),
    ].filter((d) => policyDenies(policy, d.name) === false);
    return { defs, connectorTools, extra };
  }

  private async callTool(
    roleId: string,
    policy: RolePolicy,
    tools: ReturnType<AgentRuntime["toolsFor"]>,
    use: Anthropic.ToolUseBlock,
    opts: RunOptions,
  ): Promise<{ content: ToolOutput; isError: boolean; decision: string }> {
    const input = (use.input ?? {}) as Record<string, any>;
    const connectorTool: ConnectorTool | undefined = tools.connectorTools.find((t) => t.def.name === use.name);
    const meta: ToolMeta = connectorTool ? { connector: connectorTool.connector, readOnly: connectorTool.readOnly } : {};
    const { decision, reason } = decide(policy, use.name, input, meta);

    if (decision === "deny") {
      return { content: `Not allowed by this role's policy (${reason}).`, isError: true, decision };
    }
    if (decision === "ask") {
      const approved = await this.deps.approvals.request({ roleId, taskId: opts.taskId, tool: use.name, input, reason }, opts.signal);
      if (!approved) {
        return { content: "A person declined this action (or it expired). Do not retry it; continue without it or explain what you needed.", isError: true, decision: "denied" };
      }
    }

    try {
      if (tools.extra?.defs.some((d) => d.name === use.name)) return { ...(await tools.extra.handle(use.name, input)), decision };
      if (connectorTool) return { ...(await this.deps.connectors!.call(connectorTool, input)), decision };
      if (use.name === BROWSER_TOOL.name && this.deps.browser) {
        const content = await this.deps.browser.execute(roleId, this.store.roleDir(roleId), policy, input);
        return { content, isError: false, decision };
      }
      return { ...(await executeTool({ config: this.config, store: this.store, roleId, policy, signal: opts.signal }, use.name, input)), decision };
    } catch (e) {
      return { content: String(e instanceof Error ? e.message : e), isError: true, decision };
    }
  }

  /**
   * When the session grows past the configured size, replace older messages
   * with a model-written summary, keeping the recent ones verbatim. The cut is
   * always at a plain user message so tool calls stay paired with results.
   */
  private async maybeCompact(roleId: string, sessionId: string, system: string, messages: Message[], signal?: AbortSignal): Promise<Message[]> {
    if (estimateTokens(messages) < this.config.compactAtTokens) return messages;
    let cut = -1;
    for (let i = messages.length - KEEP_RECENT; i > 0; i--) {
      if (isPlainUser(messages[i])) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) {
      for (let i = Math.max(1, messages.length - KEEP_RECENT); i < messages.length - 1; i++) {
        if (isPlainUser(messages[i])) {
          cut = i;
          break;
        }
      }
    }
    if (cut <= 0) return messages;

    const old = messages.slice(0, cut);
    const transcript = old.map(renderForSummary).join("\n\n").slice(-400_000);
    const response = await this.deps.provider.client().messages.create(
      {
        model: this.deps.provider.current().model,
        max_tokens: 4000,
        system,
        messages: [{
          role: "user",
          content:
            "Summarise this earlier part of your work so you can continue without it: the goals, decisions, " +
            "facts learned, files and URLs involved, what is done and what is still pending. Be specific and concise.\n\n" +
            transcript,
        }],
      },
      { signal },
    );
    await this.store.addUsage(roleId, this.deps.provider.current().model, response.usage);
    const summary = blocksText(response.content);
    const first = messages[cut];
    const compacted: Message[] = [
      { role: "user", content: `[Summary of the earlier conversation]\n${summary}\n\n[Next message]\n${plainText(first)}` },
      ...messages.slice(cut + 1),
    ];
    await this.store.archiveSession(roleId, sessionId, old);
    await this.store.saveSession(roleId, sessionId, compacted);
    await this.store.audit({ roleId, sessionId, event: "compacted", removed: cut });
    bus.publish({ type: "compacted", roleId, sessionId, removedMessages: cut });
    return compacted;
  }

  private async systemPrompt(roleId: string): Promise<string> {
    const soul = stripFrontmatter(await this.store.readSoul(roleId));
    const memory = (await this.store.readMemory(roleId)).trim();
    return [
      soul.trim(),
      `Current time: ${new Date().toISOString()}. Your workspace is your current directory; files there persist between runs.`,
      "Some actions (pushing code, sending messages, writing to connected apps) wait for a person's approval; if one is declined, do not retry it.",
      memory ? `# Your memory\n${memory}` : "",
    ].filter(Boolean).join("\n\n");
  }
}

export function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}

function policyDenies(policy: RolePolicy, tool: string): boolean {
  return decide(policy, tool, {}, {}).decision === "deny";
}

function pendingToolUses(m: Message | undefined): Anthropic.ToolUseBlock[] {
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return [];
  return m.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
}

function blocksText(content: Anthropic.ContentBlock[]): string {
  return content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const t = blocksText(m.content as Anthropic.ContentBlock[]);
      if (t) return t;
    }
  }
  return "";
}

function isPlainUser(m: Message): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return m.content.every((b) => b.type === "text");
}

function plainText(m: Message): string {
  return typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

function renderForSummary(m: Message): string {
  if (typeof m.content === "string") return `[${m.role}] ${m.content}`;
  return m.content.map((b: any) => {
    if (b.type === "text") return `[${m.role}] ${b.text}`;
    if (b.type === "tool_use") return `[tool call] ${b.name} ${JSON.stringify(b.input).slice(0, 2000)}`;
    if (b.type === "tool_result") {
      const c = typeof b.content === "string" ? b.content : (b.content ?? []).map((x: any) => x.text ?? `[${x.type}]`).join(" ");
      return `[tool result] ${String(c).slice(0, 3000)}`;
    }
    return `[${b.type}]`;
  }).join("\n");
}

/** Rough size check (~4 characters per token); images count as a fixed cost. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += JSON.stringify(m.content, (k, v) => (k === "data" && typeof v === "string" ? "x".repeat(6000) : v)).length;
  }
  return Math.ceil(chars / 4);
}
