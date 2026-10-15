import { Button, Card } from "@cz/design-system";
import { Check, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { api, timeAgo, useApi, useEvents } from "../api";
import { Code, Empty, ErrorNote, Loading, PageHeader, Section, StatusBadge, toast } from "../ui";

type Approval = { id: string; roleId: string; taskId?: string; tool: string; input: any; reason: string; status: string; createdAt: string; resolvedAt?: string; resolvedBy?: string };

export function ApprovalsPage() {
  const { data, error, reload } = useApi<Approval[]>("/approvals");
  useEvents((e) => {
    if (e.type === "approval_requested" || e.type === "approval_resolved") reload();
  });
  const pending = data?.filter((a) => a.status === "pending").reverse() ?? [];
  const history = data?.filter((a) => a.status !== "pending").reverse().slice(0, 50) ?? [];
  return (
    <>
      <PageHeader title="审批" description="推代码、发消息、改外部数据这类操作，会停在这里等你点头。" />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <Section title={`待处理 ${pending.length ? `(${pending.length})` : ""}`}>
            {pending.length === 0 ? <Empty>没有需要你处理的操作。</Empty> : <div className="grid gap-3">{pending.map((a) => <PendingCard key={a.id} a={a} onDone={reload} />)}</div>}
          </Section>
          <Section title="历史">
            {history.length === 0 ? (
              <Empty>还没有记录。</Empty>
            ) : (
              <Card className="divide-y divide-line-subtle">
                {history.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                    <StatusBadge status={a.status} />
                    <code className="font-mono text-footnote text-fg">{a.tool}</code>
                    <span className="text-footnote text-fg-muted">{a.roleId}</span>
                    <span className="min-w-0 flex-1 truncate text-footnote text-fg-subtle">{preview(a)}</span>
                    <span className="text-caption text-fg-subtle">
                      {a.resolvedBy} · {timeAgo(a.resolvedAt)}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </Section>
        </>
      )}
    </>
  );
}

function preview(a: Approval) {
  return a.tool === "bash" ? String(a.input?.command ?? "") : JSON.stringify(a.input);
}

function PendingCard({ a, onDone }: { a: Approval; onDone: () => void }) {
  const [busy, setBusy] = useState<"yes" | "no">();
  const decide = async (approve: boolean) => {
    setBusy(approve ? "yes" : "no");
    try {
      await api(`/approvals/${a.id}`, { body: { approve } });
      toast(approve ? "已批准" : "已拒绝");
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Card className="grid gap-3 border-warning-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="size-4 text-warning" />
        <span className="text-body text-fg">
          <b>{a.roleId}</b> 想执行 <code className="font-mono text-footnote">{a.tool}</code>
        </span>
        <span className="ml-auto text-caption text-fg-subtle">{timeAgo(a.createdAt)}</span>
      </div>
      <p className="text-footnote text-fg-muted">原因：{a.reason}</p>
      <Code>{a.tool === "bash" ? String(a.input?.command ?? "") : JSON.stringify(a.input, null, 2)}</Code>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" loading={busy === "no"} disabled={Boolean(busy)} onClick={() => decide(false)}>
          <X /> 拒绝
        </Button>
        <Button loading={busy === "yes"} disabled={Boolean(busy)} onClick={() => decide(true)}>
          <Check /> 批准
        </Button>
      </div>
    </Card>
  );
}
