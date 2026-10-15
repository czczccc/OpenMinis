import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.ts";
import { runShell } from "./sandbox.ts";
import type { Store } from "./store.ts";

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command in your workspace (persistent across runs). Returns combined stdout/stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_seconds: { type: "number", description: "Default 120, max 600" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a text file from your workspace.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in your workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "remember",
    description: "Save a durable fact to your long-term memory. It is shown to you at the start of every future run.",
    input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
];

export interface ToolContext {
  config: Config;
  store: Store;
  roleId: string;
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, any>,
): Promise<{ content: string; isError: boolean }> {
  const workspace = ctx.store.workspace(ctx.roleId);
  try {
    switch (name) {
      case "bash": {
        const timeout = Math.min(Number(input.timeout_seconds ?? 120), 600) * 1000;
        const r = await runShell(ctx.config, workspace, String(input.command), timeout);
        const status = r.timedOut ? "timed out" : `exit ${r.exitCode}`;
        return { content: `[${status}]\n${r.output}`, isError: r.exitCode !== 0 };
      }
      case "read_file":
        return { content: await fs.readFile(resolveInside(workspace, input.path), "utf8"), isError: false };
      case "write_file": {
        const file = resolveInside(workspace, input.path);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, String(input.content));
        return { content: `wrote ${input.path}`, isError: false };
      }
      case "remember":
        await ctx.store.appendMemory(ctx.roleId, String(input.note));
        return { content: "saved", isError: false };
      default:
        return { content: `unknown tool ${name}`, isError: true };
    }
  } catch (e) {
    return { content: String(e instanceof Error ? e.message : e), isError: true };
  }
}

export function resolveInside(root: string, p: string): string {
  const resolved = path.resolve(root, String(p));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return resolved;
}
