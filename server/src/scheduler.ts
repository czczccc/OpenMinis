import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Tasks } from "./tasks.ts";
import { HttpError, assertId, type Routine, type Store } from "./store.ts";

/** Fires routines on their cron schedule, in their own timezone, even with no client connected. */
export class Scheduler {
  private jobs = new Map<string, Cron>();

  private store: Store;
  private tasks: Tasks;

  constructor(store: Store, tasks: Tasks) {
    this.store = store;
    this.tasks = tasks;
  }

  async start() {
    for (const r of await this.store.loadRoutines()) this.schedule(r);
  }

  stop() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  list() {
    return this.store.loadRoutines();
  }

  async create(input: Partial<Routine>): Promise<Routine> {
    const routine: Routine = {
      id: randomUUID().slice(0, 8),
      roleId: assertId(String(input.roleId ?? "")),
      cron: String(input.cron ?? ""),
      timezone: input.timezone ?? "UTC",
      prompt: String(input.prompt ?? ""),
      enabled: input.enabled ?? true,
      notify: input.notify,
    };
    if (!routine.prompt) throw new HttpError(400, "prompt is required");
    try {
      new Cron(routine.cron, { timezone: routine.timezone, paused: true }).stop();
    } catch (e) {
      throw new HttpError(400, `invalid cron/timezone: ${(e as Error).message}`);
    }
    const all = await this.store.loadRoutines();
    all.push(routine);
    await this.store.saveRoutines(all);
    this.schedule(routine);
    return routine;
  }

  async remove(id: string) {
    const all = await this.store.loadRoutines();
    const next = all.filter((r) => r.id !== id);
    if (next.length === all.length) throw new HttpError(404, "routine not found");
    await this.store.saveRoutines(next);
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  async runNow(id: string) {
    const routine = (await this.store.loadRoutines()).find((r) => r.id === id);
    if (!routine) throw new HttpError(404, "routine not found");
    return this.fire(routine);
  }

  private schedule(r: Routine) {
    if (!r.enabled) return;
    this.jobs.set(r.id, new Cron(r.cron, { timezone: r.timezone, protect: true }, () => {
      this.fire(r).catch((e) => console.error(`routine ${r.id} failed:`, e));
    }));
  }

  private async fire(r: Routine) {
    const task = await this.tasks.create({
      kind: "role", roleId: r.roleId, sessionId: `routine-${r.id}`, prompt: r.prompt, trigger: `routine:${r.id}`, notify: r.notify,
    });
    const result = await this.tasks.wait(task.id);
    const all = await this.store.loadRoutines();
    const saved = all.find((x) => x.id === r.id);
    if (saved) {
      saved.lastRunAt = new Date().toISOString();
      saved.lastResult = (result.text ?? result.error ?? "").slice(0, 2000);
      await this.store.saveRoutines(all);
    }
    return result;
  }
}
