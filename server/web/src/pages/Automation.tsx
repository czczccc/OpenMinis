import { Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Textarea } from "@cz/design-system";
import { Copy, GitBranch, Play, Plus, Trash2, Webhook } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, timeAgo, useApi } from "../api";
import { Code, Empty, ErrorNote, IconButton, Loading, PageHeader, Section, toast } from "../ui";

type Routine = { id: string; roleId: string; cron: string; timezone: string; prompt: string; notify?: string[]; lastRunAt?: string; lastResult?: string };
type Trigger = { id: string; kind: "github" | "webhook"; roleId?: string; channelId?: string; secret: string; events?: string[]; prompt: string; notify?: string[]; url: string };

const list = (s: string) => s.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);

export function AutomationPage() {
  return (
    <>
      <PageHeader title="自动化" description="不用你开口也会干活：按时间表，或者在 GitHub、监控等外部事件发生时。" />
      <Routines />
      <Triggers />
    </>
  );
}

function Routines() {
  const { data, error, reload } = useApi<Routine[]>("/routines");
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string>();
  return (
    <Section
      title="定时任务"
      actions={
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <Plus /> 新建
        </Button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data?.length === 0 && <Empty>还没有定时任务。比如每个工作日 9 点让 dev 检查 CI。</Empty>}
      <div className="grid gap-3">
        {data?.map((r) => (
          <Card key={r.id} className="grid gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{r.roleId}</Badge>
              <code className="font-mono text-footnote text-fg">{r.cron}</code>
              <span className="text-caption text-fg-subtle">{r.timezone}</span>
              {r.notify?.map((n) => <Badge key={n}>→ {n}</Badge>)}
              <span className="ml-auto flex gap-1">
                <IconButton
                  label="立即运行"
                  disabled={running === r.id}
                  onClick={async () => {
                    setRunning(r.id);
                    toast("已开始运行");
                    try {
                      await api(`/routines/${r.id}/run`, { method: "POST" });
                      reload();
                    } catch (e) {
                      toast((e as Error).message);
                    } finally {
                      setRunning(undefined);
                    }
                  }}
                >
                  <Play />
                </IconButton>
                <IconButton
                  label="删除"
                  onClick={async () => {
                    if (!confirm("删除这个定时任务？")) return;
                    await api(`/routines/${r.id}`, { method: "DELETE" }).catch((e) => toast(e.message));
                    reload();
                  }}
                >
                  <Trash2 />
                </IconButton>
              </span>
            </div>
            <p className="text-body text-fg">{r.prompt}</p>
            {r.lastRunAt && (
              <p className="line-clamp-2 text-footnote text-fg-muted">
                上次 {timeAgo(r.lastRunAt)}：{r.lastResult}
              </p>
            )}
          </Card>
        ))}
      </div>
      <NewRoutine open={open} onOpenChange={setOpen} onCreated={reload} />
    </Section>
  );
}

function NewRoutine({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [form, setForm] = useState({ roleId: "", cron: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai", prompt: "", notify: "" });
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建定时任务"
      description="cron 五段式：分 时 日 月 周。0 9 * * 1-5 是工作日早上 9 点。"
      disabled={!form.roleId || !form.prompt}
      onSubmit={async () => {
        try {
          await api("/routines", { body: { ...form, roleId: form.roleId.trim().toLowerCase(), notify: list(form.notify) } });
          onCreated();
          onOpenChange(false);
          setError(undefined);
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <Field label="角色" htmlFor="rt-role">
        <Input id="rt-role" value={form.roleId} onChange={set("roleId")} placeholder="dev" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="cron" htmlFor="rt-cron" error={error}>
          <Input id="rt-cron" className="font-mono" value={form.cron} onChange={set("cron")} />
        </Field>
        <Field label="时区" htmlFor="rt-tz">
          <Input id="rt-tz" value={form.timezone} onChange={set("timezone")} />
        </Field>
      </div>
      <Field label="要做的事" htmlFor="rt-prompt">
        <Textarea id="rt-prompt" rows={4} value={form.prompt} onChange={set("prompt")} placeholder="检查昨晚的 CI，有失败就找出原因" />
      </Field>
      <Field label="结果发到" htmlFor="rt-notify" hint="通知渠道 ID，在设置里配置，可留空">
        <Input id="rt-notify" value={form.notify} onChange={set("notify")} placeholder="tg" />
      </Field>
    </FormDialog>
  );
}

function Triggers() {
  const { data, error, reload } = useApi<Trigger[]>("/triggers");
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string>();
  return (
    <Section
      title="事件触发"
      actions={
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <Plus /> 新建
        </Button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data?.length === 0 && <Empty>还没有触发器。比如 CI 失败时让 dev 去查原因。</Empty>}
      <div className="grid gap-3">
        {data?.map((t) => {
          const url = t.url.startsWith("/") ? `${location.origin}${t.url}` : t.url;
          return (
            <Card key={t.id} className="grid gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                {t.kind === "github" ? <GitBranch className="size-4 text-fg-muted" /> : <Webhook className="size-4 text-fg-muted" />}
                <Badge tone="accent">{t.roleId ?? `#${t.channelId}`}</Badge>
                {t.events?.map((e) => (
                  <Badge key={e}>{e}</Badge>
                ))}
                {t.notify?.map((n) => <Badge key={n}>→ {n}</Badge>)}
                <span className="ml-auto">
                  <IconButton
                    label="删除"
                    onClick={async () => {
                      if (!confirm("删除这个触发器？")) return;
                      await api(`/triggers/${t.id}`, { method: "DELETE" }).catch((e) => toast(e.message));
                      reload();
                    }}
                  >
                    <Trash2 />
                  </IconButton>
                </span>
              </div>
              <p className="line-clamp-2 text-body text-fg">{t.prompt}</p>
              <CopyRow label="地址" value={url} />
              {shown === t.id ? (
                <CopyRow label="密钥" value={t.secret} />
              ) : (
                <Button variant="link" size="sm" className="justify-self-start" onClick={() => setShown(t.id)}>
                  显示密钥
                </Button>
              )}
            </Card>
          );
        })}
      </div>
      <NewTrigger open={open} onOpenChange={setOpen} onCreated={(id) => { reload(); setShown(id); }} />
    </Section>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-caption text-fg-subtle">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-sm bg-sunken px-2 py-1 font-mono text-footnote text-fg-muted">{value}</code>
      <IconButton
        label={`复制${label}`}
        onClick={() =>
          navigator.clipboard.writeText(value).then(
            () => toast("已复制"),
            () => toast("复制失败"),
          )
        }
      >
        <Copy />
      </IconButton>
    </div>
  );
}

function NewTrigger({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ kind: "github", target: "role", targetId: "", events: "workflow_run.failure issues.opened", prompt: "GitHub 事件 {{event}}，仓库 {{repository.full_name}}。看看发生了什么，需要的话修复。\n\n{{payload}}", notify: "" });
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建触发器"
      description="创建后会给出地址和密钥。GitHub：仓库 Settings → Webhooks，内容类型选 application/json。"
      disabled={!form.targetId || !form.prompt}
      onSubmit={async () => {
        try {
          const id = form.targetId.trim().toLowerCase();
          const t = await api("/triggers", {
            body: {
              kind: form.kind,
              ...(form.target === "role" ? { roleId: id } : { channelId: id }),
              events: form.kind === "github" ? list(form.events) : undefined,
              prompt: form.prompt,
              notify: list(form.notify),
            },
          });
          onCreated(t.id);
          onOpenChange(false);
          setError(undefined);
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="类型" htmlFor="tg-kind">
          <Select id="tg-kind" value={form.kind} onChange={set("kind")}>
            <option value="github">GitHub</option>
            <option value="webhook">通用 Webhook</option>
          </Select>
        </Field>
        <Field label="交给" htmlFor="tg-target">
          <Select id="tg-target" value={form.target} onChange={set("target")}>
            <option value="role">角色</option>
            <option value="channel">频道</option>
          </Select>
        </Field>
      </div>
      <Field label={form.target === "role" ? "角色 ID" : "频道 ID"} htmlFor="tg-id" error={error}>
        <Input id="tg-id" value={form.targetId} onChange={set("targetId")} placeholder={form.target === "role" ? "dev" : "team"} />
      </Field>
      {form.kind === "github" && (
        <Field label="事件" htmlFor="tg-events" hint="如 workflow_run.failure、issues.opened、pull_request，留空表示全部">
          <Input id="tg-events" className="font-mono" value={form.events} onChange={set("events")} />
        </Field>
      )}
      <Field label="提示词" htmlFor="tg-prompt" hint="可用 {{event}}、{{payload}}、{{字段.路径}}">
        <Textarea id="tg-prompt" rows={5} value={form.prompt} onChange={set("prompt")} />
      </Field>
      <Field label="结果发到" htmlFor="tg-notify" hint="通知渠道 ID，可留空">
        <Input id="tg-notify" value={form.notify} onChange={set("notify")} placeholder="tg" />
      </Field>
    </FormDialog>
  );
}

export function Select(props: React.ComponentProps<"select">) {
  return <select {...props} className="h-control-md w-full rounded-control border border-line bg-surface px-2.5 text-body text-fg outline-none focus-visible:shadow-ring" />;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  disabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onSubmit: () => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onSubmit();
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="grid gap-4 py-4">{children}</div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={busy} disabled={disabled}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { Code };
