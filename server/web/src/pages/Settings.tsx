import { Badge, Button, Card, Field, StatusDot, Textarea } from "@cz/design-system";
import { useEffect, useState } from "react";
import { api, timeAgo, useApi } from "../api";
import { Empty, ErrorNote, Loading, PageHeader, Section, toast } from "../ui";

export function SettingsPage() {
  return (
    <>
      <PageHeader title="设置" description="连接外部服务、配置通知，查看用量和操作日志。" />
      <Connectors />
      <Notifiers />
      <Usage />
      <Audit />
    </>
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
