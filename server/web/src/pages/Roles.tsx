import { Badge, Button, Card, Composer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "@cz/design-system";
import { ArrowLeft, Bot, MessageSquarePlus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, go, useApi, useEvents } from "../api";
import { ChatFrame, Thinking, Transcript } from "../chat";
import { Code, Empty, ErrorNote, Loading, PageHeader, toast } from "../ui";

export function RolesPage() {
  const { data: roles, error } = useApi<string[]>("/roles");
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="角色"
        description="每个角色是一位数字同事：有自己的人设、记忆、工作目录、浏览器和权限。"
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> 新建角色
          </Button>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!roles && !error && <Loading />}
      {roles?.length === 0 && <Empty>还没有角色。新建一个，比如 dev、ops 或 assistant。</Empty>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {roles?.map((r) => <RoleCard key={r} id={r} />)}
      </div>
      <NewRole open={open} onOpenChange={setOpen} />
    </>
  );
}

function RoleCard({ id }: { id: string }) {
  const { data: soul } = useApi<string>(`/roles/${encodeURIComponent(id)}/soul`);
  const meta = parseSoul(soul ?? "");
  return (
    <a href={`#/roles/${encodeURIComponent(id)}`} className="block">
      <Card interactive className="h-full p-4">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-full bg-accent-soft text-body text-accent-fg">{meta.emoji || <Bot className="size-4" />}</span>
          <div className="min-w-0">
            <div className="truncate text-title-sm text-fg">{meta.name || id}</div>
            <div className="text-caption text-fg-subtle">{id}</div>
          </div>
        </div>
        <p className="mt-3 line-clamp-3 text-footnote text-fg-muted">{meta.body || "未设置人设"}</p>
      </Card>
    </a>
  );
}

function parseSoul(md: string) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  const front = m?.[1] ?? "";
  const field = (k: string) => front.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { name: field("name"), emoji: field("emoji"), body: (m ? md.slice(m[0].length) : md).trim() };
}

function NewRole({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [job, setJob] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const rid = id.trim().toLowerCase();
            setBusy(true);
            try {
              const soul = `---\nname: ${name.trim() || rid}\nemoji: 🤖\n---\n${job.trim() || `You are ${name.trim() || rid}, an always-on digital coworker.`}\n`;
              await api(`/roles/${encodeURIComponent(rid)}/soul`, { method: "PUT", body: soul });
              onOpenChange(false);
              go(`roles/${rid}`);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>新建角色</DialogTitle>
            <DialogDescription>写清楚它负责什么、怎么工作，之后随时可以改。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Field label="ID" htmlFor="role-id" hint="小写字母、数字、- 或 _，比如 dev" error={error}>
              <Input id="role-id" value={id} onChange={(e) => setId(e.target.value)} autoFocus />
            </Field>
            <Field label="名字" htmlFor="role-name">
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="研发同事" />
            </Field>
            <Field label="岗位说明" htmlFor="role-job">
              <Textarea id="role-job" rows={5} value={job} onChange={(e) => setJob(e.target.value)} placeholder="你负责 OpenMinis 仓库的研发：修 bug、看 CI、提 PR……" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={busy} disabled={!id.trim()}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RolePage({ id, tab }: { id: string; tab?: string }) {
  const { data: soul } = useApi<string>(`/roles/${encodeURIComponent(id)}/soul`);
  const meta = parseSoul(soul ?? "");
  const current = tab ?? "chat";
  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="返回角色列表" onClick={() => go("roles")}>
          <ArrowLeft />
        </Button>
        <h1 className="text-title text-fg">{meta.emoji} {meta.name || id}</h1>
        <Badge>{id}</Badge>
      </div>
      <Tabs value={current} onValueChange={(v) => go(`roles/${encodeURIComponent(id)}/${v}`)}>
        <TabsList>
          <TabsTrigger value="chat">对话</TabsTrigger>
          <TabsTrigger value="persona">人设</TabsTrigger>
          <TabsTrigger value="memory">记忆</TabsTrigger>
          <TabsTrigger value="policy">权限</TabsTrigger>
        </TabsList>
        <TabsContent value="chat">{current === "chat" && <RoleChat id={id} />}</TabsContent>
        <TabsContent value="persona">{current === "persona" && <Persona id={id} />}</TabsContent>
        <TabsContent value="memory">{current === "memory" && <Memory id={id} />}</TabsContent>
        <TabsContent value="policy">{current === "policy" && <Policy id={id} />}</TabsContent>
      </Tabs>
    </>
  );
}

function RoleChat({ id }: { id: string }) {
  const enc = encodeURIComponent(id);
  const { data: sessions, reload: reloadSessions } = useApi<string[]>(`/roles/${enc}/sessions`);
  const [session, setSession] = useState<string>();
  const [fresh, setFresh] = useState(false);
  const active = session ?? (fresh ? undefined : sessions?.at(-1));
  const { data: messages, reload, setData } = useApi<any[]>(active ? `/roles/${enc}/sessions/${encodeURIComponent(active)}` : null, [active]);
  const [draft, setDraft] = useState("");
  const [taskId, setTaskId] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<number>(undefined);

  useEvents((e) => {
    if (e.roleId !== id) return;
    if ((e.type === "tool_call" || e.type === "tool_result" || e.type === "text") && e.sessionId === active) {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(reload, 150);
    }
    if (e.type === "task_finished" && e.taskId === taskId) {
      setTaskId(undefined);
      if (e.status !== "done") toast(e.status === "cancelled" ? "已停止" : `出错了：${e.error ?? e.status}`);
      reload();
      reloadSessions();
    }
  }, [id, active, taskId]);

  useEffect(() => {
    box.current?.querySelector("[data-scroll]")?.scrollTo({ top: 1e9, behavior: "smooth" });
  }, [messages?.length, taskId]);

  const send = async () => {
    const prompt = draft.trim();
    setDraft("");
    try {
      const t = await api(`/roles/${enc}/messages`, { body: { prompt, sessionId: active, wait: false } });
      setTaskId(t.id);
      if (!active) {
        setSession(t.sessionId);
        setFresh(false);
        reloadSessions();
      }
      setData((m) => [...(m ?? []), { role: "user", content: prompt }]);
    } catch (e) {
      toast((e as Error).message);
      setDraft(prompt);
    }
  };

  return (
    <div ref={box}>
      <ChatFrame
        header={
          <div className="mb-3 flex items-center gap-2">
            <select
              aria-label="会话"
              className="h-control-sm min-w-0 flex-1 rounded-control border border-line bg-surface px-2 text-footnote text-fg sm:flex-none"
              value={active ?? ""}
              onChange={(e) => {
                setSession(e.target.value || undefined);
                setFresh(!e.target.value);
              }}
            >
              {!active && <option value="">新对话</option>}
              {[...(sessions ?? [])].reverse().map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSession(undefined);
                setFresh(true);
              }}
            >
              <MessageSquarePlus /> 新对话
            </Button>
          </div>
        }
        composer={
          <Composer
            id="role-composer"
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            running={Boolean(taskId)}
            onStop={() => taskId && api(`/tasks/${taskId}/cancel`, { method: "POST" }).catch((e) => toast(e.message))}
            placeholder={`给 ${id} 派活……`}
          />
        }
      >
        {(!messages || messages.length === 0) && !taskId && <p className="m-auto text-body text-fg-subtle">新对话。它会在后台干活，你可以离开这个页面。</p>}
        {messages && <Transcript messages={messages} roleId={id} />}
        {taskId && <Thinking who={id} />}
      </ChatFrame>
    </div>
  );
}

function Persona({ id }: { id: string }) {
  const enc = encodeURIComponent(id);
  const { data, error } = useApi<string>(`/roles/${enc}/soul`);
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(data), [data]);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (text === undefined) return <Loading />;
  return (
    <Card className="grid gap-3 p-4">
      <Field label="SOUL.md" htmlFor="soul" hint="和 OpenMinis App 同样的格式：顶部 name / emoji，下面是岗位说明。">
        <Textarea id="soul" rows={16} className="font-mono text-footnote" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button
          loading={busy}
          disabled={text === data}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/roles/${enc}/soul`, { method: "PUT", body: text });
              toast("已保存");
            } catch (e) {
              toast((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </div>
    </Card>
  );
}

function Memory({ id }: { id: string }) {
  const { data, error } = useApi<string>(`/roles/${encodeURIComponent(id)}/memory`);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (data === undefined) return <Loading />;
  return data.trim() ? <Code>{data}</Code> : <Empty>还没有记忆。角色用 remember 工具记下的事会出现在这里。</Empty>;
}

function Policy({ id }: { id: string }) {
  const enc = encodeURIComponent(id);
  const { data, error } = useApi<unknown>(`/roles/${enc}/policy`);
  const [text, setText] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(data === undefined ? undefined : JSON.stringify(data, null, 2)), [data]);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (text === undefined) return <Loading />;
  return (
    <Card className="grid gap-3 p-4">
      <div className="grid gap-1 text-footnote text-fg-muted">
        <p><b className="text-fg">tools</b>：工具名（可用 github__* 前缀）→ allow 允许 / ask 需审批 / deny 禁止。</p>
        <p><b className="text-fg">connectors</b>：可用的连接器，"all" 或 ID 列表。<b className="text-fg">network</b>：命令能否联网（all / none，仅 Docker 沙盒）。</p>
        <p><b className="text-fg">browserHosts</b>：浏览器只能访问的网站，空表示不限。<b className="text-fg">askBash</b>：匹配到就需要审批的命令（正则）。</p>
      </div>
      <Field label="policy.json" htmlFor="policy" error={err}>
        <Textarea id="policy" rows={18} className="font-mono text-footnote" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const saved = await api(`/roles/${enc}/policy`, { method: "PUT", body: JSON.parse(text) });
              setText(JSON.stringify(saved, null, 2));
              setErr(undefined);
              toast("权限已保存");
            } catch (e) {
              setErr(e instanceof SyntaxError ? "JSON 格式不对" : (e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </div>
    </Card>
  );
}
