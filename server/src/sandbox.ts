import { spawn } from "node:child_process";
import type { Config } from "./config.ts";

export interface ExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 30_000;

/**
 * Runs shell commands for a role. "local" runs directly in the role's
 * workspace on the host (for trusted single-user setups); "docker" runs each
 * command in a throwaway container with only the workspace mounted.
 */
export function runShell(
  config: Config,
  workspace: string,
  command: string,
  timeoutMs = 120_000,
): Promise<ExecResult> {
  const [bin, args] =
    config.sandbox === "docker"
      ? ["docker", ["run", "--rm", "-i", "-v", `${workspace}:/workspace`, "-w", "/workspace",
          "--memory", "1g", "--cpus", "1", config.dockerImage, "sh", "-c", command]]
      : ["bash", ["-c", command]];

  return new Promise((resolve) => {
    const child = spawn(bin, args as string[], { cwd: workspace, env: sandboxEnv(), detached: true });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (output.length >= MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + "\n[output truncated]";
      resolve({ exitCode, output, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: String(err), timedOut: false });
    });
  });
}

/** Never leak server secrets (API keys, the API token) into agent commands. */
function sandboxEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, LANG, TZ } = process.env;
  return { PATH, HOME, LANG, TZ };
}
