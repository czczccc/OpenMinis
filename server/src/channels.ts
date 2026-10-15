import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentRuntime } from "./agent.ts";
import { bus } from "./events.ts";
import { HttpError, assertId, type Store } from "./store.ts";

export interface Channel {
  id: string;
  /** Roles in the channel; the first one is the lead that answers unaddressed messages. */
  roles: string[];
}

export interface ChannelMessage {
  from: string; // "user" or a role id
  text: string;
  at: string;
  handoffTo?: string;
}

/** How many role-to-role handoffs one user message may trigger. */
const MAX_HOPS = 6;
const TRANSCRIPT_TAIL = 30;

const HANDOFF_TOOL: Anthropic.Tool = {
  name: "handoff",
  description:
    "Hand the work to another role in this channel. Your note is posted to the channel and that role continues from it. " +
    "Use it when the next step belongs to someone else's job; finish your own part first.",
  input_schema: {
    type: "object",
    properties: {
      role: { type: "string", description: "Role id to hand off to" },
      note: { type: "string", description: "What you did and exactly what they should do next" },
    },
    required: ["role", "note"],
  },
};

/**
 * Group chats of several roles. Each role keeps its own memory and its own
 * session per channel; they share only what is posted to the channel.
 */
export class Channels {
  private store: Store;
  private agent: AgentRuntime;
  /** Posts to one channel run one at a time so the transcript stays ordered. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(store: Store, agent: AgentRuntime) {
    this.store = store;
    this.agent = agent;
  }

  private dir() {
    return path.join(this.store.dataDir, "channels");
  }

  private file(id: string) {
    return path.join(this.dir(), `${assertId(id)}.json`);
  }

  async create(input: Partial<Channel>): Promise<Channel> {
    const id = assertId(String(input.id ?? ""));
    const roles = (input.roles ?? []).map((r) => assertId(String(r)));
    if (roles.length === 0) throw new HttpError(400, "roles must not be empty");
    await fs.mkdir(this.dir(), { recursive: true });
    for (const r of roles) await this.store.ensureRole(r);
    const channel = { id, roles: [...new Set(roles)] };
    await fs.writeFile(this.file(id), JSON.stringify({ ...channel, messages: [] }, null, 1), { flag: "wx" }).catch((e) => {
      if (e.code === "EEXIST") throw new HttpError(409, "channel exists");
      throw e;
    });
    return channel;
  }

  async list(): Promise<string[]> {
    const files = await fs.readdir(this.dir()).catch(() => []);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  }

  async get(id: string): Promise<Channel & { messages: ChannelMessage[] }> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), "utf8"));
    } catch {
      throw new HttpError(404, "channel not found");
    }
  }

  private async append(id: string, msg: ChannelMessage) {
    const ch = await this.get(id);
    ch.messages.push(msg);
    bus.publish({ type: "channel_message", channelId: id, from: msg.from, text: msg.text });
    const tmp = `${this.file(id)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(ch, null, 1));
    await fs.rename(tmp, this.file(id));
  }

  /**
   * Post a user message. "@role" at the start addresses a role; otherwise the
   * lead answers. Roles may then hand off to each other up to MAX_HOPS times.
   * Returns the messages produced by this post.
   */
  post(id: string, text: string, signal?: AbortSignal): Promise<ChannelMessage[]> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.postUnlocked(id, text, signal));
    this.queues.set(id, next);
    next.finally(() => {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }).catch(() => {});
    return next;
  }

  private async postUnlocked(id: string, text: string, signal?: AbortSignal): Promise<ChannelMessage[]> {
    const ch = await this.get(id);
    const mention = text.match(/^@([a-z0-9][a-z0-9_-]*)\b/);
    let target = mention && ch.roles.includes(mention[1]) ? mention[1] : ch.roles[0];
    const produced: ChannelMessage[] = [];
    const userMsg = { from: "user", text, at: new Date().toISOString() };
    await this.append(id, userMsg);
    produced.push(userMsg);

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      let handoff: { role: string; note: string } | undefined;
      const extra = {
        defs: [HANDOFF_TOOL],
        handle: async (_name: string, input: Record<string, any>) => {
          const role = String(input.role);
          if (!ch.roles.includes(role) || role === target) {
            return { content: `cannot hand off to "${role}"; roles here: ${ch.roles.join(", ")}`, isError: true };
          }
          if (handoff) return { content: "already handed off this turn", isError: true };
          handoff = { role, note: String(input.note) };
          return { content: `handed off to ${role}; end your turn now`, isError: false };
        },
      };
      const prompt = await this.prompt(id, target);
      const result = await this.agent.run(target, `channel-${id}`, prompt, `channel:${id}`, { extra, signal });
      const msg: ChannelMessage = {
        from: target,
        text: handoff ? `${result.text}\n\n→ @${handoff.role}: ${handoff.note}`.trim() : result.text,
        at: new Date().toISOString(),
        handoffTo: handoff?.role,
      };
      await this.append(id, msg);
      produced.push(msg);
      if (!handoff) break;
      await this.store.audit({ channel: id, event: "handoff", from: target, to: handoff.role });
      if (hop === MAX_HOPS) {
        const stop = { from: "system", text: `handoff limit (${MAX_HOPS}) reached`, at: new Date().toISOString() };
        await this.append(id, stop);
        produced.push(stop);
        break;
      }
      target = handoff.role;
    }
    return produced;
  }

  /** What a role sees: the channel members and the recent transcript. */
  private async prompt(id: string, roleId: string): Promise<string> {
    const ch = await this.get(id);
    // The role's channel session already holds everything up to its last
    // reply, so only send what was posted since then.
    let lastOwn = -1;
    ch.messages.forEach((m, i) => {
      if (m.from === roleId) lastOwn = i;
    });
    const tail = ch.messages.slice(Math.max(lastOwn + 1, ch.messages.length - TRANSCRIPT_TAIL))
      .map((m) => `[${m.from}] ${m.text}`)
      .join("\n\n");
    return [
      `You are "${roleId}" in channel #${id} with roles: ${ch.roles.join(", ")}.`,
      `New channel messages since your last reply (newest last):\n\n${tail}`,
      `Reply to the latest message as ${roleId}. Your reply is posted to the channel.`,
    ].join("\n\n");
  }
}
