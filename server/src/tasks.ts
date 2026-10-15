import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime } from "./agent.ts";
import type { Channels } from "./channels.ts";
import { bus } from "./events.ts";
import type { Notifiers } from "./notify.ts";
import { HttpError, assertId } from "./store.ts";

export interface Task {
  id: string;
  kind: "role" | "channel";
  roleId?: string;
  channelId?: string;
  sessionId?: string;
  prompt: string;
  trigger: string;
  /** Notifier ids that get the result. */
  notify?: string[];
  status: "running" | "done" | "failed" | "cancelled" | "interrupted";
  text?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export type TaskSpec = Pick<Task, "kind" | "roleId" | "channelId" | "sessionId" | "prompt" | "trigger" | "notify">;

const HISTORY = 1000;

/**
 * Background work. Every message, routine, webhook and chat message becomes a
 * task: it runs without a client attached, can be listed, followed over
 * /events, cancelled, and is resumed after a server restart.
 */
export class Tasks {
  private file: string;
  private items: Task[] = [];
  private running = new Map<string, { abort: AbortController; done: Promise<Task> }>();
  private agent: AgentRuntime;
  private channels: Channels;
  private notifiers?: Notifiers;
  private saving: Promise<void> = Promise.resolve();

  constructor(dataDir: string, agent: AgentRuntime, channels: Channels) {
    this.file = path.join(dataDir, "tasks.json");
    this.agent = agent;
    this.channels = channels;
  }

  setNotifiers(n: Notifiers) {
    this.notifiers = n;
  }

  /** Load history and pick up tasks that were running when the server stopped. */
  async start() {
    try {
      this.items = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.items = [];
    }
    for (const t of this.items.filter((t) => t.status === "running")) {
      if (t.kind === "role") this.launch(t, true);
      else {
        // A channel post may have been mid-handoff; its transcript shows where it stopped.
        t.status = "interrupted";
        t.error = "server restarted during this channel task";
      }
    }
    await this.save();
  }

  list(filter: { status?: string; roleId?: string } = {}): Task[] {
    return this.items
      .filter((t) => (!filter.status || t.status === filter.status) && (!filter.roleId || t.roleId === filter.roleId))
      .slice(-200)
      .reverse();
  }

  get(id: string): Task {
    const t = this.items.find((x) => x.id === id);
    if (!t) throw new HttpError(404, "task not found");
    return t;
  }

  async create(spec: TaskSpec): Promise<Task> {
    if (spec.kind === "role") assertId(spec.roleId ?? "");
    else assertId(spec.channelId ?? "");
    const task: Task = {
      id: randomUUID().slice(0, 12),
      ...spec,
      sessionId: spec.kind === "role" ? assertId(spec.sessionId ?? randomUUID().slice(0, 8)) : undefined,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    this.items.push(task);
    await this.save();
    this.launch(task, false);
    return task;
  }

  /** Resolves when the task has finished (in any state). */
  wait(id: string): Promise<Task> {
    return this.running.get(id)?.done ?? Promise.resolve(this.get(id));
  }

  async cancel(id: string): Promise<Task> {
    const t = this.get(id);
    const r = this.running.get(id);
    if (!r) throw new HttpError(409, `task is ${t.status}`);
    r.abort.abort();
    return r.done;
  }

  private launch(task: Task, resume: boolean) {
    const abort = new AbortController();
    bus.publish({ type: "task_started", taskId: task.id, roleId: task.roleId ?? task.channelId ?? "", sessionId: task.sessionId ?? "", trigger: task.trigger });
    const done = (async () => {
      try {
        if (task.kind === "role") {
          const r = await this.agent.run(task.roleId!, task.sessionId!, resume ? null : task.prompt, task.trigger, { signal: abort.signal, taskId: task.id });
          task.text = r.text;
        } else {
          const msgs = await this.channels.post(task.channelId!, task.prompt, abort.signal);
          task.text = msgs.slice(1).map((m) => `[${m.from}] ${m.text}`).join("\n\n");
        }
        task.status = "done";
      } catch (e) {
        task.status = abort.signal.aborted ? "cancelled" : "failed";
        task.error = (e as Error).message;
      }
      task.finishedAt = new Date().toISOString();
      this.running.delete(task.id);
      await this.save();
      bus.publish({ type: "task_finished", taskId: task.id, roleId: task.roleId ?? task.channelId ?? "", status: task.status, text: task.text, error: task.error });
      if (task.notify?.length && this.notifiers) {
        const who = task.roleId ?? `#${task.channelId}`;
        const body = task.status === "done" ? task.text || "(no reply)" : `${task.status}: ${task.error}`;
        await this.notifiers.send(task.notify, `${who}: ${body}`).catch((e) => console.error("notify failed:", e));
      }
      return task;
    })();
    this.running.set(task.id, { abort, done });
  }

  private save() {
    const write = async () => {
      this.items = this.items.slice(-HISTORY);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.items, null, 1));
      await fs.rename(tmp, this.file);
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }
}
