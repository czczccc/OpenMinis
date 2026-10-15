import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";

/** Which Anthropic-compatible endpoint, key and model the agents call. */
export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

/**
 * The model provider, set from the console and saved in provider.json.
 * Fields left empty there fall back to ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / MINIS_MODEL.
 */
export class Provider {
  private file: string;
  private env: ProviderConfig;
  private saved: Partial<ProviderConfig> = {};
  private cached?: { key: string; client: Anthropic };

  constructor(dataDir: string, env: ProviderConfig) {
    this.file = path.join(dataDir, "provider.json");
    this.env = env;
  }

  async load() {
    try {
      this.saved = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.saved = {};
    }
  }

  current(): ProviderConfig {
    return {
      baseUrl: this.saved.baseUrl || this.env.baseUrl,
      apiKey: this.saved.apiKey || this.env.apiKey,
      model: this.saved.model || this.env.model,
    };
  }

  /** What the console shows: the key is never sent back, only whether one is set. */
  view() {
    const c = this.current();
    return {
      baseUrl: c.baseUrl ?? "",
      model: c.model,
      hasKey: !!c.apiKey,
      keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : "",
      defaults: { baseUrl: this.env.baseUrl ?? "", model: this.env.model },
    };
  }

  /** An empty apiKey keeps the current one. */
  async write(input: { baseUrl?: unknown; apiKey?: unknown; model?: unknown }) {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const baseUrl = str(input.baseUrl).replace(/\/+$/, "");
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error("地址需要以 http:// 或 https:// 开头");
    const next: Partial<ProviderConfig> = {
      baseUrl: baseUrl || undefined,
      apiKey: str(input.apiKey) || this.saved.apiKey,
      model: str(input.model) || undefined,
    };
    await fs.writeFile(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    this.saved = next;
  }

  client(): Anthropic {
    const c = this.current();
    if (!c.apiKey) throw new Error("还没设置模型 API key：在 设置 → 模型供应商 里填写");
    const key = `${c.baseUrl}|${c.apiKey}`;
    if (this.cached?.key !== key) {
      this.cached = { key, client: new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl || undefined, maxRetries: 5, timeout: 10 * 60 * 1000 }) };
    }
    return this.cached.client;
  }
}
