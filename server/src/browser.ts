import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { hostAllowed, type RolePolicy } from "./policy.ts";
import type { ToolOutput } from "./tools.ts";

export const BROWSER_TOOL: Anthropic.Tool = {
  name: "browser",
  description: [
    "Control your own Chromium browser (logins and cookies persist between runs).",
    "Actions: navigate {url}; snapshot (page text + numbered interactive elements);",
    "click {ref|selector}; type {ref|selector, text, submit?}; press {key}; select {ref|selector, value};",
    "scroll {direction: up|down}; back; screenshot (returns an image); tabs; switch_tab {index}; close_tab.",
    "Use snapshot to get element refs before clicking or typing.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "snapshot", "click", "type", "press", "select", "scroll", "back", "screenshot", "tabs", "switch_tab", "close_tab"],
      },
      url: { type: "string" },
      ref: { type: "number", description: "Element number from the last snapshot" },
      selector: { type: "string", description: "CSS selector, when there is no ref" },
      text: { type: "string" },
      submit: { type: "boolean", description: "Press Enter after typing" },
      key: { type: "string", description: "e.g. Enter, Escape, ArrowDown" },
      value: { type: "string" },
      direction: { type: "string", enum: ["up", "down"] },
      index: { type: "number" },
    },
    required: ["action"],
  },
};

const IDLE_CLOSE_MS = 10 * 60 * 1000;
const MAX_PAGE_TEXT = 8000;

interface Session {
  context: BrowserContext;
  page: Page;
  policy: RolePolicy;
  idleTimer?: NodeJS.Timeout;
}

/**
 * One persistent Chromium profile per role, launched on first use and closed
 * after 10 idle minutes. Pages run inside Chromium's own sandbox; the role's
 * `browserHosts` policy blocks every request to other hosts. Each state
 * changing action is saved as a screenshot under recordings/ (action recording).
 */
export class BrowserPool {
  private sessions = new Map<string, Promise<Session>>();
  private executablePath?: string;
  private record: boolean;

  constructor(executablePath: string | undefined, record: boolean) {
    this.executablePath = executablePath;
    this.record = record;
  }

  async execute(roleId: string, roleDir: string, policy: RolePolicy, input: Record<string, any>): Promise<ToolOutput> {
    const s = await this.session(roleId, roleDir, policy);
    s.policy = policy;
    this.touch(roleId, s);
    const page = s.page;
    const target = () => {
      if (input.ref !== undefined) return page.locator(`[data-minis-ref="${Number(input.ref)}"]`).first();
      if (input.selector) return page.locator(String(input.selector)).first();
      throw new Error("ref or selector is required");
    };

    switch (input.action) {
      case "navigate": {
        const url = String(input.url ?? "");
        if (!/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://");
        if (!hostAllowed(policy, url)) throw new Error(`host not allowed by this role's policy: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        await this.recordStep(roleDir, page, "navigate");
        return snapshot(page);
      }
      case "snapshot":
        return snapshot(page);
      case "click":
        await target().click({ timeout: 15_000 });
        await settle(page);
        await this.recordStep(roleDir, page, "click");
        return snapshot(page);
      case "type": {
        const el = target();
        await el.fill(String(input.text ?? ""), { timeout: 15_000 });
        if (input.submit) await el.press("Enter");
        await settle(page);
        await this.recordStep(roleDir, page, "type");
        return input.submit ? snapshot(page) : "typed";
      }
      case "press":
        await page.keyboard.press(String(input.key ?? "Enter"));
        await settle(page);
        await this.recordStep(roleDir, page, "press");
        return snapshot(page);
      case "select":
        await target().selectOption(String(input.value ?? ""), { timeout: 15_000 });
        await this.recordStep(roleDir, page, "select");
        return "selected";
      case "scroll":
        await page.mouse.wheel(0, input.direction === "up" ? -800 : 800);
        await page.waitForTimeout(300);
        return snapshot(page);
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        return snapshot(page);
      case "screenshot": {
        const png = await page.screenshot({ type: "png" });
        return [
          { type: "text", text: `${await page.title()} — ${page.url()}` },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
        ];
      }
      case "tabs":
        return s.context.pages().map((p, i) => `${i}${p === page ? " *" : ""} ${p.url()}`).join("\n");
      case "switch_tab": {
        const p = s.context.pages()[Number(input.index)];
        if (!p) throw new Error("no such tab");
        s.page = p;
        await p.bringToFront();
        return snapshot(p);
      }
      case "close_tab": {
        if (s.context.pages().length === 1) return "cannot close the last tab";
        await page.close();
        s.page = s.context.pages().at(-1)!;
        return snapshot(s.page);
      }
      default:
        throw new Error(`unknown browser action ${input.action}`);
    }
  }

  private session(roleId: string, roleDir: string, policy: RolePolicy): Promise<Session> {
    let s = this.sessions.get(roleId);
    if (!s) {
      s = this.launch(roleDir, policy);
      this.sessions.set(roleId, s);
      s.catch(() => this.sessions.delete(roleId));
    }
    return s;
  }

  private async launch(roleDir: string, policy: RolePolicy): Promise<Session> {
    const context = await chromium.launchPersistentContext(path.join(roleDir, "browser-profile"), {
      executablePath: this.executablePath,
      headless: true,
      viewport: { width: 1280, height: 900 },
      // Chromium refuses its sandbox as root; run the server as a normal user in production.
      chromiumSandbox: process.getuid?.() !== 0,
    });
    const session: Session = { context, page: context.pages()[0] ?? (await context.newPage()), policy };
    await context.route("**/*", (route) =>
      hostAllowed(session.policy, route.request().url()) ? route.continue() : route.abort("blockedbyclient"),
    );
    context.on("page", (p) => {
      session.page = p; // follow popups / target=_blank
    });
    return session;
  }

  private touch(roleId: string, s: Session) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => this.close(roleId), IDLE_CLOSE_MS);
    s.idleTimer.unref();
  }

  async close(roleId: string) {
    const s = this.sessions.get(roleId);
    this.sessions.delete(roleId);
    if (s) await (await s).context.close().catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((r) => this.close(r)));
  }

  private async recordStep(roleDir: string, page: Page, action: string) {
    if (!this.record) return;
    const now = new Date();
    const dir = path.join(roleDir, "recordings", now.toISOString().slice(0, 10));
    await fs.mkdir(dir, { recursive: true });
    const name = `${now.toISOString().replace(/[:.]/g, "-")}-${action}.png`;
    await page.screenshot({ path: path.join(dir, name), type: "png" }).catch(() => {});
  }
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

/** Page text plus numbered interactive elements the model can refer to. */
async function snapshot(page: Page): Promise<string> {
  const data = await page.evaluate((maxText) => {
    const sel = "a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true]";
    document.querySelectorAll("[data-minis-ref]").forEach((el) => el.removeAttribute("data-minis-ref"));
    const lines: string[] = [];
    let n = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
      if (n >= 250) break;
      n++;
      el.setAttribute("data-minis-ref", String(n));
      const input = el as HTMLInputElement;
      const label = (
        el.getAttribute("aria-label") || input.placeholder || el.innerText || input.value || el.getAttribute("title") || el.getAttribute("name") || ""
      ).replace(/\s+/g, " ").trim().slice(0, 80);
      const kind = el.tagName.toLowerCase() + (input.type && el.tagName === "INPUT" ? `:${input.type}` : "");
      const extra = el.tagName === "A" ? ` -> ${(el as HTMLAnchorElement).href.slice(0, 120)}` : "";
      lines.push(`[${n}] ${kind} "${label}"${extra}`);
    }
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, maxText);
    return { title: document.title, url: location.href, text, elements: lines.join("\n") };
  }, MAX_PAGE_TEXT);
  return `# ${data.title}\n${data.url}\n\n## Text\n${data.text}\n\n## Interactive elements\n${data.elements || "(none)"}`;
}
