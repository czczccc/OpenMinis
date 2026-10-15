import { EventEmitter } from "node:events";

/** Everything observable that happens on the server, for SSE clients and notifiers. */
export type ServerEvent =
  | { type: "task_started"; taskId: string; roleId: string; sessionId: string; trigger: string }
  | { type: "task_finished"; taskId: string; roleId: string; status: string; text?: string; error?: string }
  | { type: "text"; taskId?: string; roleId: string; sessionId: string; text: string }
  | { type: "tool_call"; taskId?: string; roleId: string; sessionId: string; tool: string; input: unknown }
  | { type: "tool_result"; taskId?: string; roleId: string; sessionId: string; tool: string; isError: boolean }
  | { type: "approval_requested"; approvalId: string; roleId: string; tool: string; input: unknown; reason: string }
  | { type: "approval_resolved"; approvalId: string; approved: boolean; by: string }
  | { type: "channel_message"; channelId: string; from: string; text: string }
  | { type: "compacted"; roleId: string; sessionId: string; removedMessages: number };

class Bus extends EventEmitter {
  publish(e: ServerEvent) {
    this.emit("event", { at: new Date().toISOString(), ...e });
  }
}

export const bus = new Bus();
bus.setMaxListeners(1000);
