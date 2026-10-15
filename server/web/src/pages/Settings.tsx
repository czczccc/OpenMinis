import { Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, StatusDot, Textarea } from "@cz/design-system";
import { useEffect, useState } from "react";
import { api, timeAgo, useApi } from "../api";
import { Empty, ErrorNote, Loading, PageHeader, Section, toast } from "../ui";

export function SettingsPage() {
  return (
    <>
      <PageHeader title="设置" description="选择模型供应商，连接外部服务、配置通知，查看用量和操作日志。" />
      <ModelProvider />
      <Connectors />
      <Notifiers />
      <Usage />
      <Audit />
    </>
  );
}

type ProviderItem = { id: string; name: string; baseUrl: string; model: string; summaryModel: string; hasKey: boolean; keyHint: string; readOnly: boolean; active: boolean };
type TestResult = { ok: boolean; ms: number; error?: string };

/** Anthropic-compatible endpoints; model names are suggestions, check the provider's console. */
const PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: "Anthropic 官方", baseUrl: "", model: "claude-sonnet-5-5" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-chat" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "glm-4.6" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/anthropic", model: "kimi-k2-turbo-preview" },
  { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic", model: "qwen3-coder-plus" },
  { name: "自定义", baseUrl: "", model: "" },
];

function ModelProvider() {
  const { data, error, reload } = useApi<{ active: string; providers: ProviderItem[] }>("/providers");
  const [editing, setEditing] = useState<ProviderItem | "new" | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const runTest = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "running" }));
    const r = await api<TestResult>(`/providers/${id}/test`, { method: "POST" }).catch((e) => ({ ok: false, ms: 0, error: (e as Error).message }));
    setTests((t) => ({ ...t, [id]: r }));
  };
  return (
    <Section
      title="模型供应商"
      actions={
        <Button variant="soft" size="sm" onClick={() => setEditing("new")}>
          添加供应商
        </Button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <Card className="divide-y divide-line-subtle">
          {data.providers.map((p) => {
            const t = tests[p.id];
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-body font-medium text-fg">{p.name}</span>
                    {p.active && <Badge tone="success">使用中</Badge>}
                    {p.readOnly && <Badge tone="neutral">来自配置文件</Badge>}
                  </div>
                  <span className="truncate font-mono text-caption text-fg-muted">
                    {p.model} · {p.baseUrl || "api.anthropic.com"} · {p.hasKey ? `key ${p.keyHint}` : "没有 key"}
                  </span>
                  {t && t !== "running" && (
                    <span className={t.ok ? "text-caption text-success-fg" : "text-caption text-danger-fg"}>
                      {t.ok ? `连通，${t.ms} ms` : `失败：${t.error}`}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" loading={t === "running"} disabled={!p.hasKey} onClick={() => runTest(p.id)}>
                    测试
                  </Button>
                  {!p.readOnly && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                      编辑
                    </Button>
                  )}
                  {!p.readOnly && !p.active && (
                    <Button variant="ghost" size="sm" onClick={() => confirm(`删除「${p.name}」？`) && act(() => api(`/providers/${p.id}`, { method: "DELETE" }), "已删除")}>
                      删除
                    </Button>
                  )}
                  {!p.active && (
                    <Button variant="secondary" size="sm" disabled={!p.hasKey} onClick={() => act(() => api(`/providers/${p.id}/activate`, { method: "POST" }), `已切换到 ${p.name}`)}>
                      启用
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}
      {editing && (
        <ProviderDialog
          item={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </Section>
  );
}

function ProviderDialog({ item, onClose, onSaved }: { item?: ProviderItem; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: item?.name ?? "", baseUrl: item?.baseUrl ?? "", apiKey: "", model: item?.model ?? "", summaryModel: item?.summaryModel ?? "" });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api(item ? `/providers/${item.id}` : "/providers", { method: item ? "PUT" : "POST", body: form });
              toast("已保存");
              onSaved();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{item ? `编辑 ${item.name}` : "添加供应商"}</DialogTitle>
            <DialogDescription>需要兼容 Anthropic Messages API，模型要支持工具调用。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {!item && (
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <Button key={p.name} type="button" variant={form.name === p.name ? "soft" : "secondary"} size="sm" onClick={() => setForm({ ...form, name: p.name === "自定义" ? "" : p.name, baseUrl: p.baseUrl, model: p.model })}>
                    {p.name}
                  </Button>
                ))}
              </div>
            )}
            <Field label="名称" htmlFor="pv-name">
              <Input id="pv-name" value={form.name} onChange={set("name")} />
            </Field>
            <Field label="接口地址" htmlFor="pv-url" hint="不要带 /v1。留空用官方 api.anthropic.com。">
              <Input id="pv-url" placeholder="https://api.anthropic.com" value={form.baseUrl} onChange={set("baseUrl")} />
            </Field>
            <Field label="API Key" htmlFor="pv-key" hint={item?.hasKey ? `已设置（${item.keyHint}），留空则不修改` : undefined}>
              <Input id="pv-key" type="password" autoComplete="off" value={form.apiKey} onChange={set("apiKey")} />
            </Field>
            <Field label="模型" htmlFor="pv-model" hint="预设的模型名只是建议，以供应商控制台为准。">
              <Input id="pv-model" value={form.model} onChange={set("model")} />
            </Field>
            <Field label="摘要模型（可选）" htmlFor="pv-sum" hint="对话太长时用来压缩历史，可以填便宜一点的模型；留空用上面的模型。" error={err}>
              <Input id="pv-sum" value={form.summaryModel} onChange={set("summaryModel")} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" loading={busy}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const CONNECTOR_EXAMPLE = [
  { id: "github", type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ghp_..." } },
];

function Connectors() {
  const { data, error, reload } = useApi<{ config: unknown[]; status: { id: string; connected: boolean; error?: string; tools: { name: string; readOnly: boolean }[] }[] }>("/connectors");
  return (
    <Section title="连接器（MCP）">
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <div className="grid gap-3">
          {data.status.length > 0 && (
            <Card className="divide-y divide-line-subtle">
              {data.status.map((c) => (
                <div key={c.id} className="grid gap-2 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <StatusDot state={c.connected ? "success" : "error"} />
                    <span className="text-body text-fg">{c.id}</span>
                    <span className="text-caption text-fg-subtle">{c.connected ? `${c.tools.length} 个工具` : c.error}</span>
                  </div>
                  {c.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {c.tools.map((t) => (
                        <Badge key={t.name} tone={t.readOnly ? "neutral" : "warning"} title={t.readOnly ? "只读，直接执行" : "会改数据，需要审批"}>
                          {t.name.split("__")[1]}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </Card>
          )}
          <JsonEditor
            id="connectors"
            label="connectors.json"
            hint="stdio：在服务器上启动 command；http：连接 Streamable HTTP 地址。黄色工具需要审批。"
            value={data.config.length ? data.config : CONNECTOR_EXAMPLE}
            example={data.config.length === 0}
            onSave={async (v) => {
              await api("/connectors", { method: "PUT", body: v });
              reload();
            }}
          />
        </div>
      )}
    </Section>
  );
}

const NOTIFIER_EXAMPLE = [{ id: "tg", kind: "telegram", botToken: "123:ABC", chatId: "987654321", approvals: true, inbound: { channelId: "team" } }];

function Notifiers() {
  const { data, error, reload } = useApi<unknown[]>("/notifiers");
  return (
    <Section title="通知渠道">
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <JsonEditor
          id="notifiers"
          label="notifiers.json"
          hint="telegram / slack / webhook。approvals: true 会把审批请求发过去；Telegram 的 inbound 让那个聊天能直接给角色或频道派活。"
          value={data.length ? data : NOTIFIER_EXAMPLE}
          example={data.length === 0}
          onSave={async (v) => {
            await api("/notifiers", { method: "PUT", body: v });
            reload();
          }}
        />
      )}
    </Section>
  );
}

function JsonEditor({ id, label, hint, value, example, onSave }: { id: string; label: string; hint: string; value: unknown; example?: boolean; onSave: (v: unknown) => Promise<void> }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <Card className="grid gap-3 p-4">
      {example && <Badge tone="info" className="justify-self-start">还没配置，下面是示例，改成你自己的再保存</Badge>}
      <Field label={label} htmlFor={id} hint={hint} error={err}>
        <Textarea id={id} rows={10} className="font-mono text-footnote" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const parsed = JSON.parse(text);
              if (!Array.isArray(parsed)) throw new Error("需要是一个数组 [...]");
              await onSave(parsed);
              setErr(undefined);
              toast("已保存");
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

type UsageRow = { model: string; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number };

function Usage() {
  const { data, error } = useApi<Record<string, Record<string, UsageRow>>>("/usage");
  const rows = Object.entries(data ?? {})
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 14)
    .flatMap(([day, roles]) => Object.entries(roles).map(([role, r]) => ({ day, role, ...r })));
  const fmt = (n: number) => n.toLocaleString();
  return (
    <Section title="用量（近 14 天）">
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data && rows.length === 0 && <Empty>还没有调用记录。</Empty>}
      {rows.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-footnote">
            <thead className="text-fg-subtle">
              <tr className="border-b border-line-subtle">
                {["日期", "角色", "请求", "输入", "输出", "缓存读取"].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-fg">
              {rows.map((r) => (
                <tr key={`${r.day}-${r.role}`} className="border-b border-line-subtle last:border-b-0">
                  <td className="px-4 py-2 text-fg-muted">{r.day}</td>
                  <td className="px-4 py-2">{r.role}</td>
                  <td className="px-4 py-2 tabular-nums">{fmt(r.requests)}</td>
                  <td className="px-4 py-2 tabular-nums">{fmt(r.input)}</td>
                  <td className="px-4 py-2 tabular-nums">{fmt(r.output)}</td>
                  <td className="px-4 py-2 tabular-nums">{fmt(r.cacheRead)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Section>
  );
}

const EVENT_TEXT: Record<string, string> = {
  run_start: "开始",
  run_resume: "恢复",
  run_end: "结束",
  tool: "工具",
  handoff: "交接",
  compacted: "压缩",
  soul_updated: "改人设",
  policy_updated: "改权限",
  connectors_updated: "改连接器",
  notifiers_updated: "改通知",
  provider_updated: "改模型",
  provider_switched: "切换模型",
};

function Audit() {
  const { data, error, reload } = useApi<any[]>("/audit?limit=100");
  return (
    <Section
      title="操作日志"
      actions={
        <Button variant="ghost" size="sm" onClick={reload}>
          刷新
        </Button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data?.length === 0 && <Empty>还没有记录。</Empty>}
      {data && data.length > 0 && (
        <Card className="divide-y divide-line-subtle">
          {[...data].reverse().map((e, i) => (
            <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <Badge tone={e.isError ? "danger" : e.decision === "denied" ? "warning" : "neutral"}>{EVENT_TEXT[e.event] ?? e.event}</Badge>
              <span className="text-footnote text-fg">{e.roleId ?? (e.channel ? `#${e.channel}` : "")}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg-muted">
                {e.tool ? `${e.tool} ${JSON.stringify(e.input ?? "")}` : e.trigger ?? e.prompt ?? (e.from ? `${e.from} → ${e.to}` : "")}
              </span>
              <span className="text-caption text-fg-subtle">{timeAgo(e.at)}</span>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}
