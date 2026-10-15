import fs from "node:fs/promises";
import path from "node:path";
import type { Approvals } from "./approvals.ts";
import { bus, type ServerEvent } from "./events.ts";
import type { Tasks } from "./tasks.ts";

/**
 * Where results and approval requests are sent (data/notifiers.json).
 * Telegram is two-way: messages in the configured chat start tasks for
 * `inbound`, and approval requests come with Approve / Deny buttons.
 */
export type NotifierConfig =
  | { id: string; kind: "telegram"; botToken: string; chatId: string; approvals?: boolean; inbound?: { roleId?: string; channelId?: string } }
  | { id: string; kind: "slack"; webhookUrl: string; approvals?: boolean }
  | { id: string; kind: "webhook"; url: string; approvals?: boolean };

const TELEGRAM_LIMIT = 4000;

export class Notifiers {
  private file: string;
  private configs: NotifierConfig[] = [];
  private approvals: Approvals;
  private tasks: Tasks;
  private pollers = new Map<string, AbortController>();
  private telegramApi: string;

  constructor(dataDir: string, approvals: Approvals, tasks: Tasks, telegramApi = "https://api.telegram.org") {
    this.file = path.join(dataDir, "notifiers.json");
    this.approvals = approvals;
    this.tasks = tasks;
    this.telegramApi = telegramApi;
    bus.on("event", (e: ServerEvent) => {
      if (e.type === "approval_requested") this.announceApproval(e).catch((err) => console.error("approval notify failed:", err));
    });
  }

  async start() {
    try {
      this.configs = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.configs = [];
    }
    this.restartPollers();
  }

  stop() {
    for (const p of this.pollers.values()) p.abort();
    this.pollers.clear();
  }

  list() {
    return this.configs;
  }

  async write(configs: NotifierConfig[]) {
    for (const c of configs) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(c.id ?? "")) throw new Error(`invalid notifier id: ${c.id}`);
      if (!["telegram", "slack", "webhook"].includes(c.kind)) throw new Error(`${c.id}: unknown kind`);
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(configs, null, 2));
    this.configs = configs;
    this.restartPollers();
  }

  async send(ids: string[], text: string) {
    await Promise.all(this.configs.filter((c) => ids.includes(c.id)).map((c) => this.deliver(c, text)));
  }

  private async deliver(c: NotifierConfig, text: string, extra: Record<string, unknown> = {}) {
    if (c.kind === "telegram") {
      for (let i = 0; i < text.length || i === 0; i += TELEGRAM_LIMIT) {
        await this.telegram(c, "sendMessage", { chat_id: c.chatId, text: text.slice(i, i + TELEGRAM_LIMIT), ...extra });
      }
    } else if (c.kind === "slack") {
      await post(c.webhookUrl, { text });
    } else {
      await post(c.url, { text, ...extra });
    }
  }

  private async announceApproval(e: Extract<ServerEvent, { type: "approval_requested" }>) {
    const text = `🔐 ${e.roleId} wants to run ${e.tool}\n${e.reason}\n\n${JSON.stringify(e.input, null, 1).slice(0, 1500)}\n\nApproval id: ${e.approvalId}`;
    for (const c of this.configs.filter((x) => x.approvals)) {
      const extra = c.kind === "telegram"
        ? { reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `ap:${e.approvalId}:1` }, { text: "Deny", callback_data: `ap:${e.approvalId}:0` }]] } }
        : c.kind === "webhook" ? { approvalId: e.approvalId } : {};
      await this.deliver(c, text, extra).catch((err) => console.error(`notifier ${c.id}:`, err));
    }
  }

  private restartPollers() {
    this.stop();
    for (const c of this.configs) {
      if (c.kind !== "telegram" || !c.botToken) continue;
      const abort = new AbortController();
      this.pollers.set(c.id, abort);
      this.poll(c, abort.signal).catch((e) => console.error(`telegram ${c.id} poller stopped:`, e));
    }
  }

  private async poll(c: Extract<NotifierConfig, { kind: "telegram" }>, signal: AbortSignal) {
    let offset = 0;
    while (!signal.aborted) {
      let updates: any[] = [];
      try {
        updates = await this.telegram(c, "getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, signal);
      } catch {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        await this.handleUpdate(c, u).catch((e) => console.error("telegram update failed:", e));
      }
    }
  }

  private async handleUpdate(c: Extract<NotifierConfig, { kind: "telegram" }>, u: any) {
    // Only the configured chat may talk to the agents or approve actions.
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.message?.chat?.id) !== String(c.chatId)) return;
      const [, id, yes] = String(q.data ?? "").split(":");
      let answer = "";
      try {
        const a = await this.approvals.resolve(id, yes === "1", `telegram:${q.from?.username ?? q.from?.id}`);
        answer = a.status;
      } catch (e) {
        answer = (e as Error).message;
      }
      await this.telegram(c, "answerCallbackQuery", { callback_query_id: q.id, text: answer });
      return;
    }
    const m = u.message;
    if (!m?.text || String(m.chat?.id) !== String(c.chatId) || !c.inbound) return;
    const spec = c.inbound.channelId
      ? { kind: "channel" as const, channelId: c.inbound.channelId }
      : { kind: "role" as const, roleId: c.inbound.roleId, sessionId: `telegram-${c.id}` };
    await this.tasks.create({ ...spec, prompt: m.text, trigger: `telegram:${c.id}`, notify: [c.id] });
  }

  private async telegram(c: { botToken: string }, method: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${this.telegramApi}/bot${c.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
    return json.result;
  }
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${new URL(url).host} → ${res.status}`);
}
