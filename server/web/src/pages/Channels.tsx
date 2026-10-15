import { Badge, Button, Card, Composer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input } from "@cz/design-system";
import { ArrowLeft, Hash, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, go, timeAgo, useApi, useEvents } from "../api";
import { Bubble, ChatFrame, Thinking } from "../chat";
import { Empty, ErrorNote, Loading, PageHeader, toast } from "../ui";

type ChannelMessage = { from: string; text: string; at: string; handoffTo?: string };
type Channel = { id: string; roles: string[]; messages: ChannelMessage[] };

export function ChannelsPage() {
  const { data: ids, error, reload } = useApi<string[]>("/channels");
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="频道"
        description="多个角色在一个群里协作：负责人先接，@角色 可以点名，角色之间会互相交接。"
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> 新建频道
          </Button>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!ids && !error && <Loading />}
      {ids?.length === 0 && <Empty>还没有频道。新建一个，把几个角色拉进来。</Empty>}
      <div className="grid gap-3 sm:grid-cols-2">
        {ids?.map((id) => <ChannelCard key={id} id={id} />)}
      </div>
      <NewChannel open={open} onOpenChange={setOpen} onCreated={(id) => { reload(); go(`channels/${id}`); }} />
    </>
  );
}

function ChannelCard({ id }: { id: string }) {
  const { data } = useApi<Channel>(`/channels/${encodeURIComponent(id)}`);
  const last = data?.messages.at(-1);
  return (
    <a href={`#/channels/${encodeURIComponent(id)}`} className="block">
      <Card interactive className="p-4">
        <div className="flex items-center gap-2">
          <Hash className="size-4 text-fg-subtle" />
          <span className="text-title-sm text-fg">{id}</span>
          <span className="ml-auto text-caption text-fg-subtle">{timeAgo(last?.at)}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {data?.roles.map((r, i) => (
            <Badge key={r} tone={i === 0 ? "accent" : "neutral"}>
              {r}
              {i === 0 ? " · 负责人" : ""}
            </Badge>
          ))}
        </div>
        {last && (
          <p className="mt-3 line-clamp-2 text-footnote text-fg-muted">
            {last.from === "user" ? "你" : last.from}：{last.text}
          </p>
        )}
      </Card>
    </a>
  );
}

function NewChannel({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [id, setId] = useState("");
  const [roles, setRoles] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const roleList = roles.split(/[\s,，]+/).map((r) => r.trim().toLowerCase()).filter(Boolean);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("/channels", { body: { id: id.trim().toLowerCase(), roles: roleList } });
              onOpenChange(false);
              onCreated(id.trim().toLowerCase());
              setId("");
              setRoles("");
              setError(undefined);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>新建频道</DialogTitle>
            <DialogDescription>角色不存在会自动创建。第一个角色是负责人，没点名的消息由它先接。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Field label="频道名" htmlFor="ch-id" hint="小写字母、数字、- 或 _">
              <Input id="ch-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="team" autoFocus />
            </Field>
            <Field label="角色" htmlFor="ch-roles" hint="用空格或逗号分隔" error={error}>
              <Input id="ch-roles" value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="lead dev ops" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={busy} disabled={!id.trim() || roleList.length === 0}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChannelPage({ id }: { id: string }) {
  const { data, error, setData, reload } = useApi<Channel>(`/channels/${encodeURIComponent(id)}`);
  const [draft, setDraft] = useState("");
  const [taskId, setTaskId] = useState<string>();
  const [working, setWorking] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);

  useEvents((e) => {
    if (e.type === "channel_message" && e.channelId === id) {
      setData((c) => (c ? { ...c, messages: [...c.messages, { from: e.from, text: e.text, at: e.at }] } : c));
      setWorking(undefined);
    }
    if ((e.type === "tool_call" || e.type === "text") && e.sessionId === `channel-${id}`) setWorking(e.roleId);
    if (e.type === "task_finished" && e.taskId === taskId) {
      setTaskId(undefined);
      setWorking(undefined);
      if (e.status !== "done") toast(e.status === "cancelled" ? "已停止" : `出错了：${e.error ?? e.status}`);
      reload();
    }
  }, [id, taskId]);

  useEffect(() => {
    scroller.current?.querySelector("[data-scroll]")?.scrollTo({ top: 1e9, behavior: "smooth" });
  }, [data?.messages.length, working]);

  const send = async () => {
    const text = draft.trim();
    setDraft("");
    try {
      const t = await api("/channels/" + encodeURIComponent(id) + "/messages", { body: { text, wait: false } });
      setTaskId(t.id);
      const mention = text.match(/^@([a-z0-9][a-z0-9_-]*)/);
      setWorking(mention?.[1] && data?.roles.includes(mention[1]) ? mention[1] : data?.roles[0]);
    } catch (e) {
      toast((e as Error).message);
      setDraft(text);
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;
  return (
    <div ref={scroller}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="返回频道列表" onClick={() => go("channels")}>
          <ArrowLeft />
        </Button>
        <h1 className="flex items-center gap-1.5 text-title text-fg">
          <Hash className="size-5 text-fg-subtle" />
          {id}
        </h1>
        <div className="flex flex-wrap gap-1">
          {data.roles.map((r, i) => (
            <a key={r} href={`#/roles/${encodeURIComponent(r)}`}>
              <Badge tone={i === 0 ? "accent" : "neutral"}>{r}</Badge>
            </a>
          ))}
        </div>
      </div>
      <ChatFrame
        composer={
          <Composer
            id="channel-composer"
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            running={Boolean(taskId)}
            onStop={() => taskId && api(`/tasks/${taskId}/cancel`, { method: "POST" }).catch((e) => toast(e.message))}
            placeholder={`发到 #${id}，用 @${data.roles[1] ?? data.roles[0]} 点名某个角色`}
          />
        }
      >
        {data.messages.length === 0 && <p className="m-auto text-body text-fg-subtle">说点什么，{data.roles[0]} 会先接手。</p>}
        {data.messages.map((m, i) =>
          m.from === "system" ? (
            <p key={i} className="self-center text-caption text-fg-subtle">
              {m.text}
            </p>
          ) : (
            <Bubble
              key={i}
              mine={m.from === "user"}
              who={m.from === "user" ? "你" : m.from}
              meta={m.handoffTo ? <Badge tone="info">交接给 {m.handoffTo}</Badge> : undefined}
            >
              {m.text}
            </Bubble>
          ),
        )}
        {working && <Thinking who={working} />}
      </ChatFrame>
    </div>
  );
}
