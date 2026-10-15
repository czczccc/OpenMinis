import fs from "node:fs/promises";
import path from "node:path";

export type Decision = "allow" | "ask" | "deny";

/**
 * Per-role permissions, stored as roles/<role>/policy.json.
 *
 * `tools` maps tool names (or prefixes ending in "*", e.g. "github__*") to a
 * decision and wins over every default below. Without an entry:
 *   - connector tools that declare themselves read-only are allowed,
 *     every other connector tool asks for approval;
 *   - bash commands matching `askBash` ask for approval;
 *   - everything else is allowed.
 */
export interface RolePolicy {
  tools: Record<string, Decision>;
  /** Connector ids this role may use, or "all". */
  connectors: string[] | "all";
  /** Outbound network for sandboxed commands (docker sandbox only). */
  network: "all" | "none";
  /** Hosts the browser may load (suffix match). Empty means any host. */
  browserHosts: string[];
  /** Regexes; a matching bash command needs approval. */
  askBash: string[];
}

export const DEFAULT_ASK_BASH = [
  String.raw`\bgit\s+push\b`,
  String.raw`\b(curl|wget|http)\b[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|--form|\s-F\s|--upload-file)`,
  String.raw`\b(ssh|scp|rsync|sftp)\b`,
  String.raw`\b(npm|pnpm|yarn|cargo|twine|gem)\s+publish\b`,
  String.raw`\b(sendmail|mail|mutt)\b`,
  String.raw`\brm\s+-[a-z]*r[a-z]*f?\s+(/|~)(\s|$)`,
  String.raw`\b(docker|kubectl|terraform)\b`,
  String.raw`\bgh\s+(pr|issue|release|repo)\s+(create|merge|close|delete|comment|edit)\b`,
];

export const DEFAULT_POLICY: RolePolicy = {
  tools: {},
  connectors: "all",
  network: "all",
  browserHosts: [],
  askBash: DEFAULT_ASK_BASH,
};

export async function loadPolicy(roleDir: string): Promise<RolePolicy> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(roleDir, "policy.json"), "utf8"));
    return normalizePolicy(raw);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function savePolicy(roleDir: string, raw: unknown): Promise<RolePolicy> {
  const policy = normalizePolicy(raw);
  await fs.writeFile(path.join(roleDir, "policy.json"), JSON.stringify(policy, null, 2));
  return policy;
}

export function normalizePolicy(raw: any): RolePolicy {
  const decisions = new Set(["allow", "ask", "deny"]);
  const tools: Record<string, Decision> = {};
  for (const [k, v] of Object.entries(raw?.tools ?? {})) {
    if (!decisions.has(v as string)) throw new Error(`tools.${k} must be allow, ask or deny`);
    tools[k] = v as Decision;
  }
  const askBash = Array.isArray(raw?.askBash) ? raw.askBash.map(String) : DEFAULT_ASK_BASH;
  for (const re of askBash) new RegExp(re); // throws on invalid patterns
  return {
    tools,
    connectors: Array.isArray(raw?.connectors) ? raw.connectors.map(String) : "all",
    network: raw?.network === "none" ? "none" : "all",
    browserHosts: Array.isArray(raw?.browserHosts) ? raw.browserHosts.map(String) : [],
    askBash,
  };
}

export interface ToolMeta {
  /** Comes from a connector (external system) rather than the built-ins. */
  connector?: string;
  readOnly?: boolean;
}

export function decide(policy: RolePolicy, tool: string, input: any, meta: ToolMeta = {}): { decision: Decision; reason: string } {
  const explicit = policy.tools[tool] ?? matchPrefix(policy.tools, tool);
  if (explicit) return { decision: explicit, reason: `policy for ${tool}` };
  if (meta.connector) {
    return meta.readOnly
      ? { decision: "allow", reason: "read-only connector tool" }
      : { decision: "ask", reason: `${meta.connector} can change data outside the server` };
  }
  if (tool === "bash") {
    const cmd = String(input?.command ?? "");
    const hit = policy.askBash.find((re) => new RegExp(re, "i").test(cmd));
    if (hit) return { decision: "ask", reason: `command matches /${hit}/` };
  }
  return { decision: "allow", reason: "default" };
}

function matchPrefix(rules: Record<string, Decision>, tool: string): Decision | undefined {
  let best: [number, Decision] | undefined;
  for (const [k, v] of Object.entries(rules)) {
    if (k.endsWith("*") && tool.startsWith(k.slice(0, -1)) && (!best || k.length > best[0])) best = [k.length, v];
  }
  return best?.[1];
}

export function hostAllowed(policy: RolePolicy, url: string): boolean {
  if (policy.browserHosts.length === 0) return true;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return true;
    host = u.hostname;
  } catch {
    return false;
  }
  return policy.browserHosts.some((h) => host === h || host.endsWith(`.${h}`));
}
