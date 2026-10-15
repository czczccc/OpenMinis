import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AgentRuntime } from "./agent.ts";
import type { Config } from "./config.ts";
import type { Scheduler } from "./scheduler.ts";
import { HttpError, assertId, type Store } from "./store.ts";

/**
 * REST API (all routes need `Authorization: Bearer $MINIS_API_TOKEN`):
 *   GET    /health
 *   GET    /roles
 *   GET    /roles/:role/soul            PUT (text body) to replace
 *   GET    /roles/:role/memory
 *   GET    /roles/:role/sessions
 *   GET    /roles/:role/sessions/:id
 *   POST   /roles/:role/messages        {prompt, sessionId?}
 *   GET    /routines                    POST {roleId, cron, timezone, prompt}
 *   DELETE /routines/:id
 *   POST   /routines/:id/run
 *   GET    /audit?limit=100
 */
export function createServer(config: Config, store: Store, agent: AgentRuntime, scheduler: Scheduler) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if (!authorized(req, config.apiToken)) throw new HttpError(401, "unauthorized");
      const m = req.method ?? "GET";

      if (parts[0] === "roles") {
        if (parts.length === 1 && m === "GET") return send(res, 200, await store.listRoles());
        const roleId = assertId(parts[1] ?? "");
        await store.ensureRole(roleId);
        const sub = parts[2];
        if (sub === "soul" && m === "GET") return sendText(res, await store.readSoul(roleId));
        if (sub === "soul" && m === "PUT") {
          await store.writeSoul(roleId, await readBody(req));
          await store.audit({ roleId, event: "soul_updated" });
          return send(res, 200, { ok: true });
        }
        if (sub === "memory" && m === "GET") return sendText(res, await store.readMemory(roleId));
        if (sub === "sessions" && m === "GET") {
          if (parts[3]) return send(res, 200, await store.loadSession(roleId, assertId(parts[3])));
          return send(res, 200, await store.listSessions(roleId));
        }
        if (sub === "messages" && m === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (!body.prompt) throw new HttpError(400, "prompt is required");
          const sessionId = body.sessionId ? assertId(body.sessionId) : randomUUID().slice(0, 8);
          return send(res, 200, await agent.run(roleId, sessionId, String(body.prompt), "api"));
        }
      }

      if (parts[0] === "routines") {
        if (parts.length === 1 && m === "GET") return send(res, 200, await scheduler.list());
        if (parts.length === 1 && m === "POST") {
          return send(res, 201, await scheduler.create(JSON.parse((await readBody(req)) || "{}")));
        }
        if (parts.length === 2 && m === "DELETE") {
          await scheduler.remove(parts[1]);
          return send(res, 200, { ok: true });
        }
        if (parts.length === 3 && parts[2] === "run" && m === "POST") {
          return send(res, 200, await scheduler.runNow(parts[1]));
        }
      }

      if (parts[0] === "audit" && m === "GET") {
        return send(res, 200, await store.readAudit(Number(url.searchParams.get("limit") ?? 100)));
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: (e as Error).message });
    }
  });
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? "");
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
