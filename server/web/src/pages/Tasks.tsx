import { Button, Card, Tabs, TabsList, TabsTrigger } from "@cz/design-system";
import { Square } from "lucide-react";
import { useState } from "react";
import { api, timeAgo, useApi, useEvents } from "../api";
import { Code, Empty, ErrorNote, Loading, PageHeader, StatusBadge, toast } from "../ui";

type Task = { id: string; kind: string; roleId?: string; channelId?: string; sessionId?: string; prompt: string; trigger: string; status: string; text?: string; error?: string; createdAt: string; finishedAt?: string };

const TRIGGER: Record<string, string> = { api: "手动", routine: "定时", github: "GitHub", webhook: "Webhook", telegram: "Telegram" };

export function TasksPage() {
  const [filter, setFilter] = useState("all");
  const { data, error, reload } = useApi<Task[]>(filter === "all" ? "/tasks" : `/tasks?status=${filter}`, [filter]);
  const [open, setOpen] = useState<string>();
  useEvents((e) => {
    if (e.type === "task_started" || e.type === "task_finished") reload();
  });
  return (
    <>
      <PageHeader title="任务" description="所有在后台跑的活：手动派的、定时的、Webhook 和 Telegram 触发的。" />
      <Tabs value={filter} onValueChange={setFilter} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="running">运行中</TabsTrigger>
          <TabsTrigger value="failed">失败</TabsTrigger>
        </TabsList>
      </Tabs>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Loading />}
      {data?.length === 0 && <Empty>没有任务。</Empty>}
      {data && data.length > 0 && (
        <Card className="divide-y divide-line-subtle">
          {data.map((t) => (
            <div key={t.id} className="px-4 py-3">
              <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(open === t.id ? undefined : t.id)} aria-expanded={open === t.id}>
                <StatusBadge status={t.status} />
                <span className="text-body text-fg">{t.roleId ?? `#${t.channelId}`}</span>
                <span className="text-caption text-fg-subtle">{TRIGGER[t.trigger.split(":")[0]] ?? t.trigger}</span>
                <span className="min-w-0 flex-1 basis-full truncate text-footnote text-fg-muted sm:basis-auto">{t.prompt}</span>
                <span className="text-caption text-fg-subtle">{timeAgo(t.createdAt)}</span>
              </button>
              {open === t.id && (
                <div className="mt-3 grid gap-2">
                  <Code>{t.prompt}</Code>
                  {(t.text || t.error) && <Code>{t.text || t.error}</Code>}
                  <div className="flex flex-wrap items-center gap-2">
                    {t.roleId && t.sessionId && (
                      <Button variant="secondary" size="sm" asChild>
                        <a href={`#/roles/${encodeURIComponent(t.roleId)}`}>打开角色</a>
                      </Button>
                    )}
                    {t.channelId && (
                      <Button variant="secondary" size="sm" asChild>
                        <a href={`#/channels/${encodeURIComponent(t.channelId)}`}>打开频道</a>
                      </Button>
                    )}
                    {t.status === "running" && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={async () => {
                          try {
                            await api(`/tasks/${t.id}/cancel`, { method: "POST" });
                            toast("已停止");
                          } catch (e) {
                            toast((e as Error).message);
                          }
                        }}
                      >
                        <Square /> 停止
                      </Button>
                    )}
                    <span className="ml-auto font-mono text-caption text-fg-subtle">{t.id}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
