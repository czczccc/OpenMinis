import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export type Message = Anthropic.MessageParam;

export interface Routine {
  id: string;
  roleId: string;
  /** Cron expression, e.g. "0 9 * * 1-5". */
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  /** Notifier ids that receive the result. */
  notify?: string[];
  lastRunAt?: string;
  lastResult?: string;
}

const DEFAULT_SOUL = `---
name: Minis
emoji: 🤖
---
You are Minis, an always-on digital coworker running on a cloud Linux machine.
Work autonomously with your tools, keep notes in memory, and report results concisely.
`;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, `invalid id: ${id}`);
  return id;
}

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * File-based persistence. Layout under dataDir:
 *   roles/<role>/SOUL.md          persona (same format as the mobile apps)
 *   roles/<role>/MEMORY.md        long-term memory, private to the role
 *   roles/<role>/workspace/       sandbox working directory
 *   roles/<role>/sessions/<id>.json
 *   routines.json
 *   audit.jsonl
 */
export class Store {
  dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  roleDir(roleId: string) {
    return path.join(this.dataDir, "roles", assertId(roleId));
  }

  workspace(roleId: string) {
    return path.join(this.roleDir(roleId), "workspace");
  }

  async ensureRole(roleId: string): Promise<void> {
    const dir = this.roleDir(roleId);
    await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
    await fs.mkdir(path.join(dir, "workspace"), { recursive: true });
    await writeIfMissing(path.join(dir, "SOUL.md"), DEFAULT_SOUL);
    await writeIfMissing(path.join(dir, "MEMORY.md"), "");
  }

  async listRoles(): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(this.dataDir, "roles"))).filter((n) => ID_RE.test(n));
    } catch {
      return [];
    }
  }

  readSoul(roleId: string) {
    return fs.readFile(path.join(this.roleDir(roleId), "SOUL.md"), "utf8");
  }

  writeSoul(roleId: string, text: string) {
    return fs.writeFile(path.join(this.roleDir(roleId), "SOUL.md"), text);
  }

  readMemory(roleId: string) {
    return fs.readFile(path.join(this.roleDir(roleId), "MEMORY.md"), "utf8");
  }

  appendMemory(roleId: string, note: string) {
    const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.replace(/\n+/g, " ").trim()}\n`;
    return fs.appendFile(path.join(this.roleDir(roleId), "MEMORY.md"), line);
  }

  async loadSession(roleId: string, sessionId: string): Promise<Message[]> {
    try {
      return JSON.parse(await fs.readFile(this.sessionPath(roleId, sessionId), "utf8"));
    } catch {
      return [];
    }
  }

  async saveSession(roleId: string, sessionId: string, messages: Message[]) {
    await atomicWrite(this.sessionPath(roleId, sessionId), JSON.stringify(messages, null, 1));
  }

  async listSessions(roleId: string): Promise<string[]> {
    const files = await fs.readdir(path.join(this.roleDir(roleId), "sessions")).catch(() => []);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  }

  private sessionPath(roleId: string, sessionId: string) {
    return path.join(this.roleDir(roleId), "sessions", `${assertId(sessionId)}.json`);
  }

  /** Keep compacted-away messages on disk for reference. */
  async archiveSession(roleId: string, sessionId: string, messages: Message[]) {
    const dir = path.join(this.roleDir(roleId), "sessions", "archive");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${assertId(sessionId)}-${Date.now()}.json`), JSON.stringify(messages));
  }

  /** Token usage per day and role, in usage.json. */
  async addUsage(roleId: string, model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
    const file = path.join(this.dataDir, "usage.json");
    const day = new Date().toISOString().slice(0, 10);
    const run = async () => {
      let all: Record<string, Record<string, any>> = {};
      try {
        all = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {}
      const row = ((all[day] ??= {})[roleId] ??= { model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      row.requests++;
      row.input += usage.input_tokens ?? 0;
      row.output += usage.output_tokens ?? 0;
      row.cacheRead += usage.cache_read_input_tokens ?? 0;
      row.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      await atomicWrite(file, JSON.stringify(all, null, 1));
    };
    this.usageQueue = this.usageQueue.then(run, run);
    await this.usageQueue;
  }

  private usageQueue: Promise<void> = Promise.resolve();

  async readUsage(): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dataDir, "usage.json"), "utf8"));
    } catch {
      return {};
    }
  }

  async loadRoutines(): Promise<Routine[]> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dataDir, "routines.json"), "utf8"));
    } catch {
      return [];
    }
  }

  async saveRoutines(routines: Routine[]) {
    await fs.mkdir(this.dataDir, { recursive: true });
    await atomicWrite(path.join(this.dataDir, "routines.json"), JSON.stringify(routines, null, 2));
  }

  async audit(entry: Record<string, unknown>) {
    await fs.mkdir(this.dataDir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    await fs.appendFile(path.join(this.dataDir, "audit.jsonl"), line);
  }

  async readAudit(limit: number): Promise<unknown[]> {
    const text = await fs.readFile(path.join(this.dataDir, "audit.jsonl"), "utf8").catch(() => "");
    return text.trim().split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  }
}

async function writeIfMissing(file: string, content: string) {
  await fs.writeFile(file, content, { flag: "wx" }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
}

async function atomicWrite(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}
