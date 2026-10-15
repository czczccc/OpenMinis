import { Card, cn, StreamingText, ThinkingText, ToolCall } from "@cz/design-system";
import type { ReactNode } from "react";

/** One chat bubble. */
export function Bubble({ who, mine, children, meta }: { who?: ReactNode; mine?: boolean; children: ReactNode; meta?: ReactNode }) {
  return (
    <div className={cn("flex bubble-width flex-col gap-1", mine ? "self-end items-end" : "self-start items-start")}>
      {(who || meta) && (
        <div className="flex items-center gap-2 px-1 text-caption text-fg-subtle">
          {who && <span className="font-medium text-fg-muted">{who}</span>}
          {meta}
        </div>
      )}
      <div
        className={cn(
          "rounded-card px-3.5 py-2.5 text-body whitespace-pre-wrap break-words",
          mine ? "bg-accent text-on-accent" : "border border-line-subtle bg-surface text-fg shadow-xs",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function Thinking({ who }: { who: string }) {
  return (
    <div className="self-start px-1 text-body">
      <ThinkingText>{who} 正在处理…</ThinkingText>
    </div>
  );
}

type Block = { type: string; [k: string]: any };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

/**
 * Render a role session (Anthropic message format): user prompts, assistant
 * text, and tool calls paired with their results.
 */
export function Transcript({ messages, roleId, liveText }: { messages: Msg[]; roleId: string; liveText?: string }) {
  const results = new Map<string, Block>();
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  }
  const out: ReactNode[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") {
      const texts = typeof m.content === "string" ? [m.content] : m.content.filter((b) => b.type === "text").map((b) => b.text as string);
      for (const [j, t] of texts.entries()) {
        out.push(
          <Bubble key={`${i}-${j}`} mine who="你">
            {t}
          </Bubble>,
        );
      }
      return;
    }
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    blocks.forEach((b, j) => {
      if (b.type === "text" && b.text.trim()) {
        out.push(
          <Bubble key={`${i}-${j}`} who={roleId}>
            {b.text}
          </Bubble>,
        );
      } else if (b.type === "tool_use") {
        const r = results.get(b.id);
        out.push(
          <ToolCall
            key={`${i}-${j}`}
            className="bubble-width w-full self-start"
            name={b.name}
            summary={summarize(b.name, b.input)}
            status={!r ? "running" : r.is_error ? "error" : "done"}
            input={b.input}
            output={r ? resultText(r.content) : undefined}
          />,
        );
      }
    });
  });
  if (liveText) {
    out.push(
      <Bubble key="live" who={roleId}>
        <StreamingText text={liveText} />
      </Bubble>,
    );
  }
  return <>{out}</>;
}

function summarize(name: string, input: any): string {
  if (!input) return "";
  if (name === "bash") return String(input.command ?? "");
  if (name === "browser") return [input.action, input.url ?? input.text ?? (input.ref !== undefined ? `#${input.ref}` : "")].filter(Boolean).join(" ");
  if (name === "handoff") return `→ ${input.role}`;
  return String(input.path ?? input.note ?? "");
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return JSON.stringify(content);
}

export function ChatFrame({ children, composer, header }: { children: ReactNode; composer: ReactNode; header?: ReactNode }) {
  return (
    <div className="flex chat-height min-h-96 flex-col">
      {header}
      <Card className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-canvas p-3 shadow-none md:p-4" data-scroll>
        {children}
      </Card>
      <div className="pt-3">{composer}</div>
    </div>
  );
}
