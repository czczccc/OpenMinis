import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolOutput } from "./tools.ts";

/**
 * An MCP server the agents can use: email, calendar, GitHub, databases...
 * Stored in data/connectors.json.
 */
export interface ConnectorConfig {
  id: string;
  /** "stdio" launches `command args` on the server; "http" connects to a Streamable HTTP endpoint. */
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Tools to treat as read-only even if the server does not say so. */
  readOnlyTools?: string[];
  /** Hide tools entirely. */
  disabledTools?: string[];
  enabled?: boolean;
}

export interface ConnectorTool {
  def: Anthropic.Tool;
  connector: string;
  remoteName: string;
  readOnly: boolean;
}

interface Live {
  config: ConnectorConfig;
  client: Client;
  tools: ConnectorTool[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class Connectors {
  private file: string;
  private live = new Map<string, Live>();
  private errors = new Map<string, string>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "connectors.json");
  }

  async readConfig(): Promise<ConnectorConfig[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  async writeConfig(configs: ConnectorConfig[]) {
    for (const c of configs) {
      if (!ID_RE.test(c.id ?? "")) throw new Error(`invalid connector id: ${c.id}`);
      if (c.type === "stdio" && !c.command) throw new Error(`${c.id}: command is required`);
      if (c.type === "http" && !c.url) throw new Error(`${c.id}: url is required`);
      if (c.type !== "stdio" && c.type !== "http") throw new Error(`${c.id}: type must be stdio or http`);
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(configs, null, 2));
    await this.reload();
  }

  /** (Re)connect every enabled connector. Failures are kept per connector, not fatal. */
  async reload() {
    await this.closeAll();
    for (const c of await this.readConfig()) {
      if (c.enabled === false) continue;
      try {
        this.live.set(c.id, await connect(c));
        this.errors.delete(c.id);
      } catch (e) {
        this.errors.set(c.id, (e as Error).message);
        console.error(`connector ${c.id} failed:`, (e as Error).message);
      }
    }
  }

  status() {
    return [...new Set([...this.live.keys(), ...this.errors.keys()])].map((id) => ({
      id,
      connected: this.live.has(id),
      error: this.errors.get(id),
      tools: this.live.get(id)?.tools.map((t) => ({ name: t.def.name, readOnly: t.readOnly })) ?? [],
    }));
  }

  /** Tools visible to a role, given the connector ids its policy allows. */
  tools(allowed: string[] | "all"): ConnectorTool[] {
    const out: ConnectorTool[] = [];
    for (const [id, l] of this.live) if (allowed === "all" || allowed.includes(id)) out.push(...l.tools);
    return out;
  }

  async call(tool: ConnectorTool, input: Record<string, unknown>): Promise<{ content: ToolOutput; isError: boolean }> {
    const l = this.live.get(tool.connector);
    if (!l) return { content: `connector ${tool.connector} is not connected`, isError: true };
    const r: any = await l.client.callTool({ name: tool.remoteName, arguments: input });
    const blocks: Exclude<ToolOutput, string> = [];
    for (const c of r.content ?? []) {
      if (c.type === "text") blocks.push({ type: "text", text: c.text });
      else if (c.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType)) {
        blocks.push({ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } });
      } else if (c.type === "resource" && c.resource?.text) blocks.push({ type: "text", text: c.resource.text });
      else blocks.push({ type: "text", text: JSON.stringify(c).slice(0, 4000) });
    }
    if (r.structuredContent && blocks.length === 0) blocks.push({ type: "text", text: JSON.stringify(r.structuredContent) });
    return { content: blocks.length ? blocks : "(no content)", isError: Boolean(r.isError) };
  }

  async closeAll() {
    await Promise.all([...this.live.values()].map((l) => l.client.close().catch(() => {})));
    this.live.clear();
  }
}

async function connect(c: ConnectorConfig): Promise<Live> {
  const client = new Client({ name: "openminis-server", version: "0.1.0" });
  const transport =
    c.type === "stdio"
      ? new StdioClientTransport({
          command: c.command!,
          args: c.args ?? [],
          // Only the connector's own env plus basics; never the server's secrets.
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(c.env ?? {}) },
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers: c.headers ?? {} } });
  await client.connect(transport);
  const tools: ConnectorTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const t of page.tools) {
      if (c.disabledTools?.includes(t.name)) continue;
      const name = `${c.id}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      tools.push({
        connector: c.id,
        remoteName: t.name,
        readOnly: t.annotations?.readOnlyHint === true || (c.readOnlyTools ?? []).includes(t.name),
        def: {
          name,
          description: `[${c.id}] ${t.description ?? t.name}`.slice(0, 1024),
          input_schema: (t.inputSchema as Anthropic.Tool.InputSchema) ?? { type: "object" },
        },
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { config: c, client, tools };
}
