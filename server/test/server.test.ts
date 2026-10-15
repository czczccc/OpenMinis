import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { captureServer, fakeAnthropic, testConfig, text, toolResultsText, toolUse, until } from "./helpers.ts";

const api = await fakeAnthropic();
const site = await captureServer();
process.env.ANTHROPIC_API_KEY = "test";
process.env.ANTHROPIC_BASE_URL = api.url;
const { createApp } = await import("../src/app.ts");

const auth = { authorization: "Bearer secret", "content-type": "application/json" };
let app: Awaited<ReturnType<typeof createApp>>;
let base = "";

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, { method, headers: auth, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text() };
};

before(async () => {
  const config = await testConfig();
  await fs.writeFile(path.join(config.dataDir, "connectors.json"), JSON.stringify([
    { id: "mail", type: "stdio", command: process.execPath, args: [path.join(import.meta.dirname, "fixtures/mcp-server.ts")] },
  ]));
  app = await createApp(config);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
});

after(async () => {
  await app.stop();
  api.close();
  site.close();
});

describe("core", () => {
  test("serves the web console without a token, or explains how to build it", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    if (res.status === 200) assert.match(body, /<div id="root">/);
    else assert.match(body, /npm run build/);
    assert.equal((await fetch(`${base}/assets/..%2F..%2Fpackage.json`)).status, 401);
  });

  test("rejects requests without the token", async () => {
    assert.equal((await fetch(`${base}/roles`)).status, 401);
  });

  test("runs a tool call, persists the session and records usage", async () => {
    api.script.push(toolUse("bash", { command: "echo hi > out.txt && cat out.txt" }), text("all done"));
    const r = await call("POST", "/roles/dev/messages", { prompt: "hello", sessionId: "s1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "done");
    assert.equal(r.body.text, "all done");
    assert.equal(await fs.readFile(path.join(app.store.workspace("dev"), "out.txt"), "utf8"), "hi\n");
    assert.equal((await call("GET", "/roles/dev/sessions/s1")).body.length, 4);
    const usage = (await call("GET", "/usage")).body;
    assert.ok(Object.values(usage).some((d: any) => d.dev?.requests >= 2));
  });

  test("keeps roles' memory and files apart and blocks path escapes", async () => {
    const { resolveInside } = await import("../src/tools.ts");
    await app.store.ensureRole("a");
    await app.store.ensureRole("b");
    await app.store.appendMemory("a", "likes tea");
    assert.match(await app.store.readMemory("a"), /likes tea/);
    assert.equal(await app.store.readMemory("b"), "");
    assert.throws(() => resolveInside(app.store.workspace("a"), "../../b/MEMORY.md"));
    assert.equal((await call("GET", "/roles/..%2Fx/soul")).status, 400);
  });
});

describe("background tasks and events", () => {
  test("wait=false returns at once; the task finishes in the background and streams events", async () => {
    const events: string[] = [];
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/events?token=secret`, { signal: ctrl.signal });
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          events.push(dec.decode(value));
        }
      } catch {}
    })();

    api.script.push(toolUse("bash", { command: "sleep 0.3; echo slow" }), text("finished later"));
    const r = await call("POST", "/roles/dev/messages", { prompt: "slow job", wait: false });
    assert.equal(r.status, 202);
    assert.equal(r.body.status, "running");
    const done = await until(async () => {
      const t = (await call("GET", `/tasks/${r.body.id}`)).body;
      return t.status === "done" && t;
    });
    assert.equal(done.text, "finished later");
    await until(async () => events.join("").includes("task_finished"));
    const all = events.join("");
    for (const type of ["task_started", "tool_call", "tool_result", "text", "task_finished"]) assert.match(all, new RegExp(`event: ${type}`));
    ctrl.abort();
    await pump;
  });

  test("cancels a running task", async () => {
    api.script.push(toolUse("bash", { command: "sleep 5" }));
    const r = await call("POST", "/roles/dev/messages", { prompt: "long", sessionId: "cancel-me", wait: false });
    await until(async () => (await call("GET", "/audit?limit=5")).body.some((e: any) => e.event === "run_start" && e.taskId === r.body.id));
    const c = await call("POST", `/tasks/${r.body.id}/cancel`);
    assert.equal(c.body.status, "cancelled");
    // The session is still usable afterwards (the dangling tool call gets a "cancelled" result).
    const next = await call("POST", "/roles/dev/messages", { prompt: "again", sessionId: "cancel-me" });
    assert.equal(next.body.status, "done");
  });
});

describe("approvals and policy", () => {
  test("a risky command waits for approval and runs once approved", async () => {
    api.script.push(toolUse("bash", { command: "git push origin main 2>&1 || echo pushed-attempt" }), text("ok"));
    const r = await call("POST", "/roles/dev/messages", { prompt: "ship it", wait: false });
    const pending = await until(async () => (await call("GET", "/approvals?status=pending")).body[0]);
    assert.equal(pending.tool, "bash");
    assert.match(pending.reason, /git/);
    assert.equal((await call("GET", `/tasks/${r.body.id}`)).body.status, "running");
    assert.equal((await call("POST", `/approvals/${pending.id}`, { approve: true })).body.status, "approved");
    const t = await until(async () => {
      const x = (await call("GET", `/tasks/${r.body.id}`)).body;
      return x.status === "done" && x;
    });
    assert.equal(t.text, "ok");
    assert.match(toolResultsText(api.requests), /pushed-attempt/);
    assert.equal((await call("POST", `/approvals/${pending.id}`, { approve: false })).status, 409);
  });

  test("a denied action is reported back to the model", async () => {
    api.script.push(toolUse("bash", { command: "ssh prod 'rm -rf /srv'" }), text("understood"));
    const r = await call("POST", "/roles/dev/messages", { prompt: "clean prod", wait: false });
    const pending = await until(async () => (await call("GET", "/approvals?status=pending")).body[0]);
    await call("POST", `/approvals/${pending.id}`, { approve: false });
    await until(async () => (await call("GET", `/tasks/${r.body.id}`)).body.status === "done");
    assert.match(toolResultsText(api.requests), /declined this action/);
  });

  test("policy can deny tools outright and validates input", async () => {
    assert.equal((await call("PUT", "/roles/locked/policy", { tools: { bash: "nope" } })).status, 400);
    const p = await call("PUT", "/roles/locked/policy", { tools: { bash: "deny", "mail__*": "deny" }, network: "none" });
    assert.equal(p.status, 200);
    assert.equal(p.body.network, "none");
    await call("POST", "/roles/locked/messages", { prompt: "hi" });
    const names: string[] = api.requests.at(-1).tools.map((t: any) => t.name);
    assert.ok(!names.includes("bash"));
    assert.ok(!names.some((n) => n.startsWith("mail__")));
    assert.ok(names.includes("read_file"));
  });

  test("policy can require approval for any tool", async () => {
    await call("PUT", "/roles/careful/policy", { tools: { write_file: "ask" } });
    api.script.push(toolUse("write_file", { path: "x.txt", content: "x" }));
    const r = await call("POST", "/roles/careful/messages", { prompt: "write", wait: false });
    const pending = await until(async () => (await call("GET", "/approvals?status=pending")).body.find((a: any) => a.roleId === "careful"));
    await call("POST", `/approvals/${pending.id}`, { approve: true });
    await until(async () => (await call("GET", `/tasks/${r.body.id}`)).body.status === "done");
    assert.equal(await fs.readFile(path.join(app.store.workspace("careful"), "x.txt"), "utf8"), "x");
  });
});

describe("browser", () => {
  test("navigates, snapshots, clicks by ref and records screenshots", async () => {
    api.script.push(
      toolUse("browser", { action: "navigate", url: site.url }),
      toolUse("browser", { action: "type", ref: 1, text: "shoes" }),
      toolUse("browser", { action: "click", ref: 2 }),
      toolUse("browser", { action: "screenshot" }),
      text("bought"),
    );
    const r = await call("POST", "/roles/shopper/messages", { prompt: "buy" });
    assert.equal(r.body.status, "done", r.body.error);
    const results = toolResultsText(api.requests.slice(-5));
    assert.match(results, /Test Shop/);
    assert.match(results, /\[1\] input:text \\"Search\\"/);
    assert.match(results, /\[2\] button \\"Buy now\\"/);
    assert.match(results, /Clicked!/);
    assert.match(results, /image\/png/);
    const days = await fs.readdir(path.join(app.store.roleDir("shopper"), "recordings"));
    const shots = await fs.readdir(path.join(app.store.roleDir("shopper"), "recordings", days[0]));
    assert.ok(shots.length >= 3);
  });

  test("blocks hosts outside the role's browserHosts", async () => {
    await call("PUT", "/roles/scoped/policy", { browserHosts: ["example.com"] });
    api.script.push(toolUse("browser", { action: "navigate", url: site.url }), text("blocked"));
    await call("POST", "/roles/scoped/messages", { prompt: "go" });
    assert.match(toolResultsText(api.requests.slice(-2)), /host not allowed/);
  });
});

describe("connectors", () => {
  test("lists MCP tools with read-only flags", async () => {
    const s = (await call("GET", "/connectors")).body.status;
    const mail = s.find((c: any) => c.id === "mail");
    assert.equal(mail.connected, true, mail.error);
    assert.deepEqual(mail.tools.map((t: any) => [t.name, t.readOnly]).sort(), [["mail__list_inbox", true], ["mail__send_email", false]]);
  });

  test("read-only tools run directly; write tools need approval", async () => {
    api.script.push(toolUse("mail__list_inbox", {}), toolUse("mail__send_email", { to: "boss@example.com", body: "hi" }), text("emailed"));
    const r = await call("POST", "/roles/assistant/messages", { prompt: "check mail and reply", wait: false });
    const pending = await until(async () => (await call("GET", "/approvals?status=pending")).body.find((a: any) => a.tool === "mail__send_email"));
    assert.match(toolResultsText(api.requests), /invoice from ACME/);
    await call("POST", `/approvals/${pending.id}`, { approve: true });
    await until(async () => (await call("GET", `/tasks/${r.body.id}`)).body.status === "done");
    assert.match(toolResultsText(api.requests), /sent to boss@example.com/);
  });
});

describe("model providers", () => {
  test("add, test, switch and delete without ever returning a key", async () => {
    const start = await call("GET", "/providers");
    assert.equal(start.body.active, "env");
    assert.equal((await call("POST", "/providers", { name: "x", baseUrl: "ftp://x", apiKey: "k", model: "m" })).status, 400);
    assert.equal((await call("POST", "/providers", { name: "x", model: "m" })).status, 400);

    const added = await call("POST", "/providers", { name: "Proxy", baseUrl: `${api.url}/v1/`, apiKey: "secret-key-1234", model: "proxy-model" });
    assert.equal(added.status, 200);
    const p = added.body.providers.find((x: any) => x.name === "Proxy");
    assert.equal(p.baseUrl, api.url);
    assert.equal(p.keyHint, "…1234");
    assert.ok(!JSON.stringify(added.body).includes("secret-key"));

    const tested = await call("POST", `/providers/${p.id}/test`);
    assert.equal(tested.body.ok, true);
    assert.equal(api.requests.at(-1).model, "proxy-model");

    assert.equal((await call("POST", `/providers/${p.id}/activate`)).body.active, p.id);
    await call("PUT", `/providers/${p.id}`, { name: "Proxy 2", baseUrl: api.url, apiKey: "", model: "proxy-model-2" });
    const after = (await call("GET", "/providers")).body.providers.find((x: any) => x.id === p.id);
    assert.equal(after.name, "Proxy 2");
    assert.equal(after.hasKey, true);

    assert.equal((await call("DELETE", "/providers/env")).status, 400);
    assert.equal((await call("DELETE", `/providers/${p.id}`)).body.active, "env");
  });
});

describe("triggers and notifiers", () => {
  test("sends results and approval requests to a webhook notifier", async () => {
    await call("PUT", "/notifiers", [{ id: "hook", kind: "webhook", url: `${site.url}/notify`, approvals: true }]);
    await call("POST", "/roles/dev/messages", { prompt: "report", notify: ["hook"] });
    await until(async () => site.received.some((r) => r.path === "/notify" && /dev: done/.test(r.body.text)));
    api.script.push(toolUse("bash", { command: "git push" }));
    const r = await call("POST", "/roles/dev/messages", { prompt: "push", wait: false });
    const note = await until(async () => site.received.find((x) => x.body?.approvalId));
    await call("POST", `/approvals/${note.body.approvalId}`, { approve: false });
    await until(async () => (await call("GET", `/tasks/${r.body.id}`)).body.status === "done");
  });

  test("a GitHub CI failure starts the role with a rendered prompt", async () => {
    const t = (await call("POST", "/triggers", {
      kind: "github", roleId: "dev", events: ["workflow_run.failure"],
      prompt: "CI failed on {{workflow_run.head_branch}} ({{event}}). Investigate.",
    })).body;
    assert.match(t.url, new RegExp(`/hooks/${t.id}$`));
    const send = (payload: unknown, secret = t.secret, event = "workflow_run") => {
      const raw = JSON.stringify(payload);
      const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
      return fetch(`${base}/hooks/${t.id}`, { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": sig }, body: raw });
    };
    assert.equal((await send({ action: "completed", workflow_run: { conclusion: "failure", head_branch: "main" } }, "wrong")).status, 401);
    assert.deepEqual(await (await send({ action: "completed", workflow_run: { conclusion: "success", head_branch: "main" } })).json(), { ignored: true });
    const res = await send({ action: "completed", workflow_run: { conclusion: "failure", head_branch: "main" } });
    assert.equal(res.status, 202);
    const { taskId } = await res.json();
    const task = await until(async () => {
      const x = (await call("GET", `/tasks/${taskId}`)).body;
      return x.status === "done" && x;
    });
    assert.equal(task.prompt, "CI failed on main (workflow_run.failure). Investigate.");
  });

  test("a generic webhook needs its secret", async () => {
    const t = (await call("POST", "/triggers", { kind: "webhook", roleId: "ops", prompt: "Alert: {{alert.name}}" })).body;
    assert.equal((await fetch(`${base}/hooks/${t.id}`, { method: "POST", body: "{}" })).status, 401);
    const ok = await fetch(`${base}/hooks/${t.id}`, { method: "POST", headers: { "x-minis-secret": t.secret }, body: JSON.stringify({ alert: { name: "disk full" } }) });
    assert.equal(ok.status, 202);
    const { taskId } = await ok.json();
    assert.equal((await call("GET", `/tasks/${taskId}`)).body.prompt, "Alert: disk full");
  });

  test("routines fire through tasks and keep the last result", async () => {
    assert.equal((await call("POST", "/routines", { roleId: "dev", cron: "nope", prompt: "x" })).status, 400);
    const r = (await call("POST", "/routines", { roleId: "ops", cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "check" })).body;
    assert.equal((await call("POST", `/routines/${r.id}/run`)).body.text, "done");
    assert.equal((await call("GET", "/routines")).body.find((x: any) => x.id === r.id).lastResult, "done");
    assert.equal((await call("DELETE", `/routines/${r.id}`)).status, 200);
  });
});

describe("channels", () => {
  test("lead answers, then hands off to another role", async () => {
    assert.equal((await call("POST", "/channels", { id: "team", roles: ["lead", "dev"] })).status, 201);
    api.script.push(toolUse("handoff", { role: "dev", note: "fix the bug" }), text("passing to dev"), text("bug fixed"));
    const r = await call("POST", "/channels/team/messages", { text: "please fix the login bug" });
    assert.equal(r.body.status, "done");
    const ch = (await call("GET", "/channels/team")).body;
    assert.deepEqual(ch.messages.map((m: any) => m.from), ["user", "lead", "dev"]);
    assert.equal(ch.messages[1].handoffTo, "dev");
    assert.equal(ch.messages[2].text, "bug fixed");
    assert.ok(api.requests.at(-1).tools.some((t: any) => t.name === "handoff"));
  });

  test("@role addresses a role; duplicate channels are rejected", async () => {
    api.script.push(text("dev here"));
    await call("POST", "/channels/team/messages", { text: "@dev status?" });
    assert.equal((await call("GET", "/channels/team")).body.messages.at(-1).from, "dev");
    assert.equal((await call("POST", "/channels", { id: "team", roles: ["x"] })).status, 409);
  });
});

describe("long-running reliability", () => {
  test("compacts a long session into a summary", async () => {
    const config = await testConfig({ compactAtTokens: 3000, browser: false });
    const small = await createApp(config);
    try {
      for (let i = 0; i < 4; i++) await small.agent.run("writer", "long", `chunk ${i} ` + "x".repeat(5000), "test");
      const session = await small.store.loadSession("writer", "long");
      assert.match(JSON.stringify(session[0]), /Summary of the earlier conversation/);
      assert.match(JSON.stringify(session[0]), /SUMMARY/);
      const archived = await fs.readdir(path.join(small.store.roleDir("writer"), "sessions", "archive"));
      assert.ok(archived.length >= 1);
    } finally {
      await small.stop();
    }
  });

  test("resumes a task that was running when the server stopped", async () => {
    const config = await testConfig({ browser: false });
    const store = new (await import("../src/store.ts")).Store(config.dataDir);
    await store.ensureRole("dev");
    await store.saveSession("dev", "r1", [
      { role: "user", content: "make a file" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "resumed.txt", content: "yes" } }] },
    ]);
    await fs.writeFile(path.join(config.dataDir, "tasks.json"), JSON.stringify([
      { id: "old", kind: "role", roleId: "dev", sessionId: "r1", prompt: "make a file", trigger: "api", status: "running", createdAt: new Date().toISOString() },
    ]));
    api.script.push(text("resumed and done"));
    const restarted = await createApp(config);
    try {
      const t = await restarted.tasks.wait("old");
      assert.equal(t.status, "done");
      assert.equal(t.text, "resumed and done");
      assert.equal(await fs.readFile(path.join(store.workspace("dev"), "resumed.txt"), "utf8"), "yes");
    } finally {
      await restarted.stop();
    }
  });
});
