import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.ts";
import type { Message, Store } from "./store.ts";
import { TOOL_DEFS, executeTool } from "./tools.ts";

export interface RunResult {
  sessionId: string;
  text: string;
  turns: number;
  stopReason: string | null;
}

/**
 * The agent loop: model call → run requested tools → feed results back,
 * until the model stops asking for tools or the turn budget runs out.
 * Runs on the same (role, session) are serialised.
 */
export class AgentRuntime {
  private client = new Anthropic();
  private locks = new Map<string, Promise<unknown>>();

  private config: Config;
  private store: Store;

  constructor(config: Config, store: Store) {
    this.config = config;
    this.store = store;
  }

  run(roleId: string, sessionId: string, prompt: string, trigger: string): Promise<RunResult> {
    const key = `${roleId}/${sessionId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runUnlocked(roleId, sessionId, prompt, trigger));
    this.locks.set(key, next);
    next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {});
    return next;
  }

  private async runUnlocked(roleId: string, sessionId: string, prompt: string, trigger: string): Promise<RunResult> {
    await this.store.ensureRole(roleId);
    const messages: Message[] = await this.store.loadSession(roleId, sessionId);
    messages.push({ role: "user", content: prompt });
    await this.store.audit({ roleId, sessionId, event: "run_start", trigger, prompt: prompt.slice(0, 500) });

    const system = await this.systemPrompt(roleId);
    let turns = 0;
    let stopReason: string | null = null;
    let text = "";

    while (turns < this.config.maxTurns) {
      turns++;
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 16_000,
        system,
        tools: TOOL_DEFS,
        messages,
      });
      messages.push({ role: "assistant", content: response.content });
      stopReason = response.stop_reason;
      text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const r = await executeTool({ config: this.config, store: this.store, roleId }, use.name, use.input as any);
        await this.store.audit({ roleId, sessionId, event: "tool", tool: use.name, input: use.input, isError: r.isError });
        results.push({ type: "tool_result", tool_use_id: use.id, content: r.content, is_error: r.isError });
      }
      messages.push({ role: "user", content: results });
      await this.store.saveSession(roleId, sessionId, messages);
    }

    if (stopReason === "tool_use") text ||= `[stopped after ${turns} turns]`;
    await this.store.saveSession(roleId, sessionId, messages);
    await this.store.audit({ roleId, sessionId, event: "run_end", turns, stopReason });
    return { sessionId, text, turns, stopReason };
  }

  private async systemPrompt(roleId: string): Promise<string> {
    const soul = stripFrontmatter(await this.store.readSoul(roleId));
    const memory = (await this.store.readMemory(roleId)).trim();
    return [
      soul.trim(),
      `Current time: ${new Date().toISOString()}. Your workspace is your current directory; files there persist between runs.`,
      memory ? `# Your memory\n${memory}` : "",
    ].filter(Boolean).join("\n\n");
  }
}

export function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}
