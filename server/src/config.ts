import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  apiToken: string;
  model: string;
  maxTurns: number;
  sandbox: "local" | "docker";
  dockerImage: string;
}

export function loadConfig(env = process.env): Config {
  const apiToken = env.MINIS_API_TOKEN ?? "";
  if (!apiToken) throw new Error("MINIS_API_TOKEN is required");
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
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
  };
}
