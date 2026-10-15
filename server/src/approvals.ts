import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { bus } from "./events.ts";
import { HttpError } from "./store.ts";

export interface Approval {
  id: string;
  roleId: string;
  taskId?: string;
  tool: string;
  input: unknown;
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

const HISTORY = 500;

/**
 * Holds risky tool calls until a person approves them (API, Telegram button)
 * or they expire. Pending waits live in memory; after a restart the resumed
 * task re-requests approval for the same call.
 */
export class Approvals {
  private file: string;
  private timeoutMs: number;
  private waiters = new Map<string, (approved: boolean) => void>();
  private items: Approval[] = [];
  private loaded = false;

  constructor(dataDir: string, timeoutMs: number) {
    this.file = path.join(dataDir, "approvals.json");
    this.timeoutMs = timeoutMs;
  }

  private async load() {
    if (this.loaded) return;
    try {
      this.items = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.items = [];
    }
    // Waits from a previous process are gone; their tasks will ask again.
    for (const a of this.items) if (a.status === "pending") a.status = "expired";
    this.loaded = true;
  }

  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.items = this.items.slice(-HISTORY);
    await fs.writeFile(this.file, JSON.stringify(this.items, null, 1));
  }

  async list(status?: string): Promise<Approval[]> {
    await this.load();
    return status ? this.items.filter((a) => a.status === status) : this.items;
  }

  /** Resolves true when approved; false when denied, expired or aborted. */
  async request(req: Pick<Approval, "roleId" | "taskId" | "tool" | "input" | "reason">, signal?: AbortSignal): Promise<boolean> {
    await this.load();
    const approval: Approval = { id: randomUUID().slice(0, 8), ...req, status: "pending", createdAt: new Date().toISOString() };
    this.items.push(approval);
    await this.save();
    bus.publish({ type: "approval_requested", approvalId: approval.id, roleId: req.roleId, tool: req.tool, input: req.input, reason: req.reason });

    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(approval.id);
        resolve(approved);
      };
      const timer = setTimeout(() => this.settle(approval.id, "expired", "timeout").catch(() => {}), this.timeoutMs);
      const onAbort = () => this.settle(approval.id, "denied", "cancelled").catch(() => {});
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(approval.id, finish);
    });
  }

  async resolve(id: string, approved: boolean, by: string): Promise<Approval> {
    await this.load();
    const a = this.items.find((x) => x.id === id);
    if (!a) throw new HttpError(404, "approval not found");
    if (a.status !== "pending") throw new HttpError(409, `approval already ${a.status}`);
    return this.settle(id, approved ? "approved" : "denied", by);
  }

  private async settle(id: string, status: Approval["status"], by: string): Promise<Approval> {
    const a = this.items.find((x) => x.id === id)!;
    if (a.status !== "pending") return a;
    a.status = status;
    a.resolvedAt = new Date().toISOString();
    a.resolvedBy = by;
    await this.save();
    bus.publish({ type: "approval_resolved", approvalId: id, approved: status === "approved", by });
    this.waiters.get(id)?.(status === "approved");
    return a;
  }
}
