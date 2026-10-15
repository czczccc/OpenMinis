import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError, assertId } from "./store.ts";
import type { Task, Tasks } from "./tasks.ts";

/**
 * Inbound events that start work: generic webhooks and GitHub webhooks
 * (issues, pull requests, CI failures...). Stored in data/triggers.json and
 * received at POST /hooks/<id>.
 */
export interface Trigger {
  id: string;
  kind: "webhook" | "github";
  roleId?: string;
  channelId?: string;
  /** Shared secret. GitHub: the webhook secret (checked via X-Hub-Signature-256). Webhook: send it as X-Minis-Secret or sign with HMAC. */
  secret: string;
  /**
   * GitHub event filter, e.g. ["issues.opened", "pull_request", "workflow_run.failure", "check_run.failure"].
   * "event" matches any action; "event.action" matches one; for workflow_run / check_run / check_suite
   * the suffix may also be the conclusion. Empty means everything except ping.
   */
  events?: string[];
  /** Prompt template: {{event}}, {{payload}} (JSON) and {{a.b.c}} paths into the payload. */
  prompt: string;
  notify?: string[];
  enabled?: boolean;
}

const MAX_PAYLOAD_IN_PROMPT = 20_000;

export class Triggers {
  private file: string;
  private tasks: Tasks;

  constructor(dataDir: string, tasks: Tasks) {
    this.file = path.join(dataDir, "triggers.json");
    this.tasks = tasks;
  }

  async list(): Promise<Trigger[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  private async save(all: Trigger[]) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(all, null, 2));
  }

  async create(input: Partial<Trigger>): Promise<Trigger> {
    if (input.kind !== "webhook" && input.kind !== "github") throw new HttpError(400, "kind must be webhook or github");
    if (!input.prompt) throw new HttpError(400, "prompt is required");
    if (!input.roleId === !input.channelId) throw new HttpError(400, "set exactly one of roleId or channelId");
    const t: Trigger = {
      id: randomUUID().slice(0, 8),
      kind: input.kind,
      roleId: input.roleId ? assertId(input.roleId) : undefined,
      channelId: input.channelId ? assertId(input.channelId) : undefined,
      secret: input.secret || randomBytes(24).toString("hex"),
      events: input.events,
      prompt: input.prompt,
      notify: input.notify,
      enabled: input.enabled ?? true,
    };
    const all = await this.list();
    all.push(t);
    await this.save(all);
    return t;
  }

  async remove(id: string) {
    const all = await this.list();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) throw new HttpError(404, "trigger not found");
    await this.save(next);
  }

  /** Verify and dispatch an incoming hook. Returns the task, or null when filtered out. */
  async receive(id: string, headers: Record<string, string | string[] | undefined>, raw: string): Promise<Task | null> {
    const t = (await this.list()).find((x) => x.id === id);
    if (!t || t.enabled === false) throw new HttpError(404, "trigger not found");
    if (!verify(t, headers, raw)) throw new HttpError(401, "bad signature");

    let payload: any;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { body: raw };
    }
    let event = "webhook";
    if (t.kind === "github") {
      const name = String(headers["x-github-event"] ?? "");
      if (name === "ping") return null;
      const keys = githubKeys(name, payload);
      if (t.events?.length && !t.events.some((e) => keys.includes(e))) return null;
      event = keys.at(-1)!;
    }
    const prompt = render(t.prompt, event, payload);
    return this.tasks.create({
      kind: t.roleId ? "role" : "channel",
      roleId: t.roleId,
      channelId: t.channelId,
      sessionId: t.roleId ? `trigger-${t.id}` : undefined,
      prompt,
      trigger: `${t.kind}:${t.id}:${event}`,
      notify: t.notify,
    });
  }
}

function header(h: Record<string, string | string[] | undefined>, name: string): string {
  const v = h[name];
  return Array.isArray(v) ? v[0] : (v ?? "");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function verify(t: Trigger, h: Record<string, string | string[] | undefined>, raw: string): boolean {
  const sig = header(h, "x-hub-signature-256");
  if (sig) return safeEqual(sig, "sha256=" + createHmac("sha256", t.secret).update(raw).digest("hex"));
  if (t.kind === "github") return false;
  const plain = header(h, "x-minis-secret");
  return plain !== "" && safeEqual(plain, t.secret);
}

/** All filter keys an event matches, most specific last. */
export function githubKeys(name: string, p: any): string[] {
  const keys = [name];
  if (p?.action) keys.push(`${name}.${p.action}`);
  const conclusion = p?.workflow_run?.conclusion ?? p?.check_run?.conclusion ?? p?.check_suite?.conclusion;
  if (conclusion) keys.push(`${name}.${conclusion}`);
  return keys;
}

export function render(template: string, event: string, payload: unknown): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key === "event") return event;
    if (key === "payload") return JSON.stringify(payload, null, 1).slice(0, MAX_PAYLOAD_IN_PROMPT);
    let v: any = payload;
    for (const part of key.split(".")) v = v?.[part];
    return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}
