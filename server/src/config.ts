import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  apiToken: string;
  model: string;
  maxTurns: number;
  sandbox: "local" | "docker";
  dockerImage: string;
  /** Summarise older messages once a session passes this many (estimated) tokens. */
  compactAtTokens: number;
  approvalTimeoutMs: number;
  browser: boolean;
  chromiumPath?: string;
  recordBrowser: boolean;
  /** Public base URL, used to show webhook addresses. */
  publicUrl?: string;
}

export function loadConfig(env = process.env): Config {
  const apiToken = env.MINIS_API_TOKEN ?? "";
  if (!apiToken) throw new Error("MINIS_API_TOKEN is required");
  const sandbox = env.MINIS_SANDBOX ?? "local";
  if (sandbox !== "local" && sandbox !== "docker") {
    throw new Error(`MINIS_SANDBOX must be "local" or "docker", got "${sandbox}"`);
  }
  return {
    port: Number(env.PORT ?? 8787),
    dataDir: path.resolve(env.MINIS_DATA_DIR ?? "data"),
    apiToken,
    model: env.MINIS_MODEL ?? "claude-sonnet-5-5",
    maxTurns: Number(env.MINIS_MAX_TURNS ?? 40),
    sandbox,
    dockerImage: env.MINIS_DOCKER_IMAGE ?? "alpine:3.20",
    compactAtTokens: Number(env.MINIS_COMPACT_AT_TOKENS ?? 120_000),
    approvalTimeoutMs: Number(env.MINIS_APPROVAL_TIMEOUT_MINUTES ?? 24 * 60) * 60_000,
    browser: env.MINIS_BROWSER !== "off",
    chromiumPath: env.MINIS_CHROMIUM_PATH || undefined,
    recordBrowser: env.MINIS_RECORD_BROWSER !== "off",
    publicUrl: env.MINIS_PUBLIC_URL?.replace(/\/$/, ""),
  };
}
