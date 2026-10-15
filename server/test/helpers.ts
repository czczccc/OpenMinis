import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config.ts";

export interface FakeReply {
  content: unknown[];
  stop?: string;
}

/**
 * Fake Anthropic Messages API. Replies come from `script` in order; when it
 * is empty the model just says "done". Summary requests (no tools) always get
 * "SUMMARY" without using the script.
 */
export async function fakeAnthropic() {
  const script: FakeReply[] = [];
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    const reply: FakeReply = !body.tools
      ? { content: [{ type: "text", text: "SUMMARY" }] }
      : (script.shift() ?? { content: [{ type: "text", text: "done" }] });
    const stop = reply.stop ?? (reply.content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: "msg", type: "message", role: "assistant", model: "fake", content: reply.content,
      stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { url, script, requests, close: () => server.close() };
}

export function toolUse(name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2)}`): FakeReply {
  return { content: [{ type: "tool_use", id, name, input }] };
}

export function text(t: string): FakeReply {
  return { content: [{ type: "text", text: t }] };
}

/** Capture POST bodies sent to a local endpoint (webhook notifier target). */
export async function captureServer() {
  const received: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received.push({ path: req.url, body: raw ? JSON.parse(raw) : null, headers: req.headers });
    res.writeHead(200, { "content-type": "text/html" }).end(
      req.method === "GET"
        ? `<html><head><title>Test Shop</title></head><body><h1>Welcome</h1><input placeholder="Search"><button onclick="document.querySelector('h1').innerText='Clicked!'">Buy now</button></body></html>`
        : "ok",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, received, close: () => server.close() };
}

export async function testConfig(overrides: Partial<Config> = {}): Promise<Config> {
  return {
    port: 0,
    dataDir: await fs.mkdtemp(path.join(os.tmpdir(), "minis-")),
    apiToken: "secret",
    model: "fake-model",
    maxTurns: 20,
    sandbox: "local",
    dockerImage: "alpine",
    compactAtTokens: 1_000_000,
    approvalTimeoutMs: 60_000,
    browser: true,
    chromiumPath: process.env.MINIS_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    recordBrowser: true,
    ...overrides,
  };
}

export async function until<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting");
}

/** Everything the model was sent as tool results, as one string. */
export function toolResultsText(requests: any[]): string {
  return JSON.stringify(requests.flatMap((r) => r.messages.flatMap((m: any) =>
    Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : [])));
}
