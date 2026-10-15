import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";

/** One Anthropic-compatible endpoint the agents can call. */
export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  /** Model for conversation summaries; defaults to `model`. */
  summaryModel?: string;
}

interface ProvidersFile {
  active?: string;
  providers: ProviderProfile[];
}

/** Built from ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / MINIS_MODEL; shown read-only. */
export const ENV_ID = "env";

/**
 * Saved provider profiles (providers.json) with one active, switched from the console
 * like CC Switch. The env-var profile is always listed and is the fallback.
 */
export class Provider {
  private file: string;
  private env: ProviderProfile;
  private data: ProvidersFile = { providers: [] };
  private cached?: { key: string; client: Anthropic };

  constructor(dataDir: string, env: { baseUrl?: string; apiKey?: string; model: string }) {
    this.file = path.join(dataDir, "providers.json");
    this.env = { id: ENV_ID, name: "环境变量", ...env };
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.data = { providers: [] };
      // The single-provider file written by the previous version.
      try {
        const old = JSON.parse(await fs.readFile(path.join(path.dirname(this.file), "provider.json"), "utf8"));
        if (old.baseUrl || old.apiKey || old.model) {
          this.data = { active: "default", providers: [{ id: "default", name: "默认", baseUrl: old.baseUrl, apiKey: old.apiKey, model: old.model || this.env.model }] };
          await this.save();
        }
      } catch {}
    }
  }

  private all(): ProviderProfile[] {
    return [this.env, ...this.data.providers];
  }

  private find(id: string) {
    const p = this.all().find((x) => x.id === id);
    if (!p) throw new Error(`没有这个供应商：${id}`);
    return p;
  }

  current(): ProviderProfile {
    return this.data.providers.find((p) => p.id === this.data.active) ?? this.env;
  }

  /** What the console shows: keys never leave the server, only their last 4 characters. */
  view() {
    const active = this.current().id;
    return {
      active,
      providers: this.all().map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl ?? "",
        model: p.model,
        summaryModel: p.summaryModel ?? "",
        hasKey: !!p.apiKey,
        keyHint: p.apiKey ? `…${p.apiKey.slice(-4)}` : "",
        readOnly: p.id === ENV_ID,
        active: p.id === active,
      })),
    };
  }

  /** Create or update; an empty apiKey keeps the saved one. */
  async upsert(id: string | undefined, input: Record<string, unknown>) {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    if (id === ENV_ID) throw new Error("环境变量里的供应商只能改 /etc/openminis.env");
    const existing = id ? this.data.providers.find((p) => p.id === id) : undefined;
    if (id && !existing) throw new Error(`没有这个供应商：${id}`);
    const name = str(input.name);
    const model = str(input.model);
    const baseUrl = str(input.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
    if (!name) throw new Error("名称不能为空");
    if (!model) throw new Error("模型不能为空");
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error("地址需要以 http:// 或 https:// 开头");
    const profile: ProviderProfile = {
      id: existing?.id ?? this.newId(),
      name,
      baseUrl: baseUrl || undefined,
      apiKey: str(input.apiKey) || existing?.apiKey,
      model,
      summaryModel: str(input.summaryModel) || undefined,
    };
    if (!profile.apiKey) throw new Error("API Key 不能为空");
    if (existing) Object.assign(existing, profile);
    else this.data.providers.push(profile);
    await this.save();
    return profile.id;
  }

  async remove(id: string) {
    if (id === ENV_ID) throw new Error("环境变量里的供应商不能删除");
    this.find(id);
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    if (this.data.active === id) this.data.active = undefined;
    await this.save();
  }

  async activate(id: string) {
    const p = this.find(id);
    if (!p.apiKey) throw new Error("这个供应商还没有 API Key");
    this.data.active = id === ENV_ID ? undefined : id;
    await this.save();
  }

  /** Send a one-word request and time it. */
  async test(id: string) {
    const p = this.find(id);
    const started = Date.now();
    try {
      const r = await this.clientFor(p).messages.create(
        { model: p.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] },
        { timeout: 30_000, maxRetries: 0 },
      );
      return { ok: true, ms: Date.now() - started, model: r.model };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: (e as Error).message.slice(0, 300) };
    }
  }

  client(): Anthropic {
    return this.clientFor(this.current());
  }

  private clientFor(p: ProviderProfile): Anthropic {
    if (!p.apiKey) throw new Error("还没设置模型 API key：在 设置 → 模型供应商 里添加");
    const key = `${p.baseUrl}|${p.apiKey}`;
    if (p.id === this.current().id && this.cached?.key === key) return this.cached.client;
    const client = new Anthropic({ apiKey: p.apiKey, baseURL: p.baseUrl || undefined, maxRetries: 5, timeout: 10 * 60 * 1000 });
    if (p.id === this.current().id) this.cached = { key, client };
    return client;
  }

  private newId() {
    let i = this.data.providers.length + 1;
    while (this.data.providers.some((p) => p.id === `p${i}`)) i++;
    return `p${i}`;
  }

  private async save() {
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
