import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Fake Anthropic API: first call asks for a bash tool, second call answers with text.
let calls = 0;
const fakeApi = http.createServer(async (req, res) => {
  for await (const _ of req);
  calls++;
  const content = calls % 2 === 1
    ? [{ type: "tool_use", id: `tu_${calls}`, name: "bash", input: { command: "echo hi > out.txt && cat out.txt" } }]
    : [{ type: "text", text: "done" }];
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "msg", type: "message", role: "assistant", model: "fake", content,
    stop_reason: calls % 2 === 1 ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
});

let base = "";
let dataDir = "";
let server: http.Server;
let scheduler: { stop(): void };
const auth = { authorization: "Bearer secret", "content-type": "application/json" };

before(async () => {
  await new Promise<void>((r) => fakeApi.listen(0, r));
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "minis-"));
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "test",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(fakeApi.address() as any).port}`,
    MINIS_API_TOKEN: "secret",
    MINIS_DATA_DIR: dataDir,
  });
  const { loadConfig } = await import("../src/config.ts");
  const { Store } = await import("../src/store.ts");
  const { AgentRuntime } = await import("../src/agent.ts");
  const { Scheduler } = await import("../src/scheduler.ts");
  const { createServer } = await import("../src/http.ts");
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const agent = new AgentRuntime(config, store);
  const s = new Scheduler(store, agent);
  scheduler = s;
  await s.start();
  server = createServer(config, store, agent, s);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  scheduler.stop();
  server.close();
  fakeApi.close();
});

test("rejects requests without the token", async () => {
  assert.equal((await fetch(`${base}/roles`)).status, 401);
});

test("runs the agent loop with a tool call and persists the session", async () => {
  const res = await fetch(`${base}/roles/dev/messages`, {
    method: "POST", headers: auth, body: JSON.stringify({ prompt: "hello", sessionId: "s1" }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.text, "done");
  assert.equal(body.turns, 2);
  assert.equal(await fs.readFile(path.join(dataDir, "roles/dev/workspace/out.txt"), "utf8"), "hi\n");
  const session = await (await fetch(`${base}/roles/dev/sessions/s1`, { headers: auth })).json();
  assert.equal(session.length, 4);
});

test("creates, runs and deletes a routine", async () => {
  const bad = await fetch(`${base}/routines`, {
    method: "POST", headers: auth, body: JSON.stringify({ roleId: "dev", cron: "nope", prompt: "x" }),
  });
  assert.equal(bad.status, 400);
  const created = await (await fetch(`${base}/routines`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ roleId: "ops", cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "check" }),
  })).json();
  const run = await (await fetch(`${base}/routines/${created.id}/run`, { method: "POST", headers: auth })).json();
  assert.equal(run.text, "done");
  const [saved] = await (await fetch(`${base}/routines`, { headers: auth })).json();
  assert.equal(saved.lastResult, "done");
  assert.equal((await fetch(`${base}/routines/${created.id}`, { method: "DELETE", headers: auth })).status, 200);
});

test("keeps roles' memory and files separate and blocks path escapes", async () => {
  const { Store } = await import("../src/store.ts");
  const { resolveInside } = await import("../src/tools.ts");
  const store = new Store(dataDir);
  await store.ensureRole("a");
  await store.ensureRole("b");
  await store.appendMemory("a", "likes tea");
  assert.match(await store.readMemory("a"), /likes tea/);
  assert.equal(await store.readMemory("b"), "");
  assert.throws(() => resolveInside(store.workspace("a"), "../../b/MEMORY.md"));
  assert.equal((await fetch(`${base}/roles/..%2Fx/soul`, { headers: auth })).status, 400);
});

test("writes an audit trail", async () => {
  const audit = await (await fetch(`${base}/audit`, { headers: auth })).json();
  assert.ok(audit.some((e: any) => e.event === "tool" && e.tool === "bash"));
});
