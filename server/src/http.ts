import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Approvals } from "./approvals.ts";
import type { Channels } from "./channels.ts";
import type { Config } from "./config.ts";
import type { Connectors } from "./connectors.ts";
import { bus, type ServerEvent } from "./events.ts";
import type { Notifiers } from "./notify.ts";
import { loadPolicy, savePolicy } from "./policy.ts";
import type { Scheduler } from "./scheduler.ts";
import { HttpError, assertId, type Store } from "./store.ts";
import type { Tasks } from "./tasks.ts";
import type { Triggers } from "./triggers.ts";

export interface Services {
  config: Config;
  store: Store;
  scheduler: Scheduler;
  channels: Channels;
  tasks: Tasks;
  approvals: Approvals;
  connectors: Connectors;
  notifiers: Notifiers;
  triggers: Triggers;
}

/**
 * REST API. Everything except /health and /hooks/:id needs
 * `Authorization: Bearer $MINIS_API_TOKEN` (or ?token= for /events).
 *
 *   GET    /health
 *   GET    /events                         Server-Sent Events stream of everything happening
 *
 *   GET    /roles
 *   GET    /roles/:role/soul               PUT (text body) to replace
 *   GET    /roles/:role/memory
 *   GET    /roles/:role/policy             PUT (JSON) to replace
 *   GET    /roles/:role/sessions
 *   GET    /roles/:role/sessions/:id
 *   POST   /roles/:role/messages           {prompt, sessionId?, wait?=true, notify?}
 *
 *   GET    /tasks?status=&role=            GET /tasks/:id   POST /tasks/:id/cancel
 *
 *   GET    /channels                       POST {id, roles: [lead, ...]}
 *   GET    /channels/:id
 *   POST   /channels/:id/messages          {text, wait?=true, notify?}  ("@role ..." addresses a role)
 *
 *   GET    /approvals?status=pending       POST /approvals/:id {approve: true|false}
 *
 *   GET    /routines                       POST {roleId, cron, timezone, prompt, notify?}
 *   DELETE /routines/:id                   POST /routines/:id/run
 *
 *   GET    /triggers                       POST {kind: webhook|github, roleId|channelId, prompt, events?, notify?}
 *   DELETE /triggers/:id
 *   POST   /hooks/:id                      inbound webhook (verified by the trigger's secret)
 *
 *   GET    /connectors                     PUT [ConnectorConfig]   (MCP servers)
 *   GET    /notifiers                      PUT [NotifierConfig]    (Telegram, Slack, webhook)
 *   GET    /usage                          token usage per day and role
 *   GET    /audit?limit=100
 */
export function createServer(s: Services) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const m = req.method ?? "GET";
      if (url.pathname === "/health") return send(res, 200, { ok: true });

      if (parts[0] === "hooks" && parts.length === 2 && m === "POST") {
        const task = await s.triggers.receive(parts[1], req.headers, await readBody(req, 5_000_000));
        return send(res, 202, task ? { taskId: task.id } : { ignored: true });
      }

      if (!authorized(req, url, s.config.apiToken)) throw new HttpError(401, "unauthorized");
      const body = async () => JSON.parse((await readBody(req)) || "{}");

      if (url.pathname === "/events" && m === "GET") return streamEvents(req, res);

      if (parts[0] === "roles") {
        if (parts.length === 1 && m === "GET") return send(res, 200, await s.store.listRoles());
        const roleId = assertId(parts[1] ?? "");
        await s.store.ensureRole(roleId);
        const sub = parts[2];
        const dir = s.store.roleDir(roleId);
        if (sub === "soul" && m === "GET") return sendText(res, await s.store.readSoul(roleId));
        if (sub === "soul" && m === "PUT") {
          await s.store.writeSoul(roleId, await readBody(req));
          await s.store.audit({ roleId, event: "soul_updated" });
          return send(res, 200, { ok: true });
        }
        if (sub === "memory" && m === "GET") return sendText(res, await s.store.readMemory(roleId));
        if (sub === "policy" && m === "GET") return send(res, 200, await loadPolicy(dir));
        if (sub === "policy" && m === "PUT") {
          try {
            const p = await savePolicy(dir, await body());
            await s.store.audit({ roleId, event: "policy_updated", policy: p });
            return send(res, 200, p);
          } catch (e) {
            throw e instanceof SyntaxError ? e : new HttpError(400, (e as Error).message);
          }
        }
        if (sub === "sessions" && m === "GET") {
          if (parts[3]) return send(res, 200, await s.store.loadSession(roleId, assertId(parts[3])));
          return send(res, 200, await s.store.listSessions(roleId));
        }
        if (sub === "messages" && m === "POST") {
          const b = await body();
          if (!b.prompt) throw new HttpError(400, "prompt is required");
          const task = await s.tasks.create({ kind: "role", roleId, sessionId: b.sessionId, prompt: String(b.prompt), trigger: "api", notify: b.notify });
          return sendTask(res, s.tasks, task.id, b.wait !== false);
        }
      }

      if (parts[0] === "tasks") {
        if (parts.length === 1 && m === "GET") {
          return send(res, 200, s.tasks.list({ status: url.searchParams.get("status") ?? undefined, roleId: url.searchParams.get("role") ?? undefined }));
        }
        if (parts.length === 2 && m === "GET") return send(res, 200, s.tasks.get(parts[1]));
        if (parts.length === 3 && parts[2] === "cancel" && m === "POST") return send(res, 200, await s.tasks.cancel(parts[1]));
      }

      if (parts[0] === "channels") {
        if (parts.length === 1 && m === "GET") return send(res, 200, await s.channels.list());
        if (parts.length === 1 && m === "POST") return send(res, 201, await s.channels.create(await body()));
        if (parts.length === 2 && m === "GET") return send(res, 200, await s.channels.get(parts[1]));
        if (parts.length === 3 && parts[2] === "messages" && m === "POST") {
          const b = await body();
          if (!b.text) throw new HttpError(400, "text is required");
          await s.channels.get(parts[1]);
          const task = await s.tasks.create({ kind: "channel", channelId: parts[1], prompt: String(b.text), trigger: "api", notify: b.notify });
          return sendTask(res, s.tasks, task.id, b.wait !== false);
        }
      }

      if (parts[0] === "approvals") {
        if (parts.length === 1 && m === "GET") return send(res, 200, await s.approvals.list(url.searchParams.get("status") ?? undefined));
        if (parts.length === 2 && m === "POST") {
          const b = await body();
          if (typeof b.approve !== "boolean") throw new HttpError(400, "approve must be true or false");
          return send(res, 200, await s.approvals.resolve(parts[1], b.approve, "api"));
        }
      }

      if (parts[0] === "routines") {
        if (parts.length === 1 && m === "GET") return send(res, 200, await s.scheduler.list());
        if (parts.length === 1 && m === "POST") return send(res, 201, await s.scheduler.create(await body()));
        if (parts.length === 2 && m === "DELETE") {
          await s.scheduler.remove(parts[1]);
          return send(res, 200, { ok: true });
        }
        if (parts.length === 3 && parts[2] === "run" && m === "POST") return send(res, 200, await s.scheduler.runNow(parts[1]));
      }

      if (parts[0] === "triggers") {
        if (parts.length === 1 && m === "GET") return send(res, 200, (await s.triggers.list()).map((t) => withUrl(s.config, t)));
        if (parts.length === 1 && m === "POST") return send(res, 201, withUrl(s.config, await s.triggers.create(await body())));
        if (parts.length === 2 && m === "DELETE") {
          await s.triggers.remove(parts[1]);
          return send(res, 200, { ok: true });
        }
      }

      if (parts[0] === "connectors" && parts.length === 1) {
        if (m === "GET") return send(res, 200, { config: await s.connectors.readConfig(), status: s.connectors.status() });
        if (m === "PUT") {
          const b = await body();
          try {
            await s.connectors.writeConfig(Array.isArray(b) ? b : []);
          } catch (e) {
            throw new HttpError(400, (e as Error).message);
          }
          await s.store.audit({ event: "connectors_updated", ids: (Array.isArray(b) ? b : []).map((c: any) => c.id) });
          return send(res, 200, s.connectors.status());
        }
      }

      if (parts[0] === "notifiers" && parts.length === 1) {
        if (m === "GET") return send(res, 200, s.notifiers.list());
        if (m === "PUT") {
          const b = await body();
          try {
            await s.notifiers.write(Array.isArray(b) ? b : []);
          } catch (e) {
            throw new HttpError(400, (e as Error).message);
          }
          await s.store.audit({ event: "notifiers_updated" });
          return send(res, 200, { ok: true });
        }
      }

      if (parts[0] === "usage" && m === "GET") return send(res, 200, await s.store.readUsage());
      if (parts[0] === "audit" && m === "GET") {
        return send(res, 200, await s.store.readAudit(Number(url.searchParams.get("limit") ?? 100)));
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
      else res.end();
    }
  });
}

function withUrl(config: Config, t: { id: string }) {
  return { ...t, url: `${config.publicUrl ?? ""}/hooks/${t.id}` };
}

async function sendTask(res: http.ServerResponse, tasks: Tasks, id: string, wait: boolean) {
  if (!wait) return send(res, 202, tasks.get(id));
  const t = await tasks.wait(id);
  send(res, t.status === "failed" ? 500 : 200, t);
}

function streamEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const onEvent = (e: ServerEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  bus.on("event", onEvent);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("event", onEvent);
  });
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const query = url.pathname === "/events" ? url.searchParams.get("token") : null;
  const given = Buffer.from(query !== null ? `Bearer ${query}` : header);
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, "body too large");
  }
  return body;
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
}

function sendText(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(text);
}
