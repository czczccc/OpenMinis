import { Badge, Button, Card, cn, Field, Input, StatusDot } from "@cz/design-system";
import { Bot, CheckCircle2, Clock, Hash, ListChecks, LogOut, Settings, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, events, getToken, setToken, useConnected, useEvents, useRoute } from "./api";
import { ApprovalsPage } from "./pages/Approvals";
import { AutomationPage } from "./pages/Automation";
import { ChannelPage, ChannelsPage } from "./pages/Channels";
import { RolePage, RolesPage } from "./pages/Roles";
import { SettingsPage } from "./pages/Settings";
import { TasksPage } from "./pages/Tasks";

const NAV = [
  { id: "channels", label: "频道", icon: Hash },
  { id: "roles", label: "角色", icon: Bot },
  { id: "approvals", label: "审批", icon: ShieldCheck },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "automation", label: "自动化", icon: Clock },
  { id: "settings", label: "设置", icon: Settings },
] as const;

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));

  useEffect(() => {
    const out = () => {
      setToken("");
      events.stop();
      setAuthed(false);
    };
    window.addEventListener("minis-unauthorized", out);
    return () => window.removeEventListener("minis-unauthorized", out);
  }, []);

  useEffect(() => {
    if (authed) events.start();
    return () => events.stop();
  }, [authed]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <Shell
      onLogout={() => {
        setToken("");
        setAuthed(false);
      }}
    />
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <div className="mb-6 flex items-center gap-2">
        <CheckCircle2 className="size-6 text-accent" />
        <span className="text-title text-fg">OpenMinis</span>
      </div>
      <Card className="p-5">
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setToken(token.trim());
            try {
              await api("/roles");
              onDone();
            } catch {
              setToken("");
              setError("Token 不对，或者连不上服务器");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="API Token" htmlFor="token" hint="服务器 /etc/openminis.env 里的 MINIS_API_TOKEN" error={error}>
            <Input id="token" type="password" autoComplete="current-password" value={token} onChange={(e) => setValue(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" loading={busy} disabled={!token.trim()}>
            登录
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const section = route[0] ?? "channels";
  const connected = useConnected();
  const pending = usePendingApprovals();

  let page: ReactNode;
  if (section === "channels") page = route[1] ? <ChannelPage id={route[1]} key={route[1]} /> : <ChannelsPage />;
  else if (section === "roles") page = route[1] ? <RolePage id={route[1]} tab={route[2]} key={route[1]} /> : <RolesPage />;
  else if (section === "approvals") page = <ApprovalsPage />;
  else if (section === "tasks") page = <TasksPage />;
  else if (section === "automation") page = <AutomationPage />;
  else if (section === "settings") page = <SettingsPage />;
  else page = <ChannelsPage />;

  return (
    <div className="flex min-h-dvh">
      <nav
        aria-label="主导航"
        className={cn(
          "z-40 flex shrink-0 bg-surface",
          "fixed inset-x-0 bottom-0 justify-around border-t border-line px-1 pt-1 pb-safe",
          "md:sticky md:top-0 md:h-dvh md:w-56 md:flex-col md:justify-start md:gap-0.5 md:border-t-0 md:border-r md:px-3 md:py-5",
        )}
      >
        <div className="mb-5 hidden items-center gap-2 px-2 md:flex">
          <CheckCircle2 className="size-5 text-accent" />
          <span className="text-title-sm text-fg">OpenMinis</span>
        </div>
        {NAV.map(({ id, label, icon: Icon }) => {
          const active = section === id;
          return (
            <a
              key={id}
              href={`#/${id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center gap-0.5 rounded-control px-2 py-1.5 text-caption transition duration-fast ease-standard",
                "md:flex-row md:gap-2.5 md:px-2.5 md:py-2 md:text-body",
                active ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
              )}
            >
              <Icon className="size-5 md:size-4" />
              <span>{label}</span>
              {id === "approvals" && pending > 0 && (
                <Badge tone="danger" className="absolute -top-0.5 right-0 md:static md:ml-auto">
                  {pending}
                </Badge>
              )}
            </a>
          );
        })}
        <div className="hidden flex-1 md:block" />
        <div className="hidden items-center justify-between px-2.5 md:flex">
          <span className="flex items-center gap-2 text-footnote text-fg-muted">
            <StatusDot state={connected ? "success" : "error"} />
            {connected ? "已连接" : "未连接"}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="退出登录" title="退出登录" onClick={onLogout}>
            <LogOut />
          </Button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 px-4 pt-6 pb-28 md:px-10 md:pt-10 md:pb-12">
        <div className="mx-auto max-w-5xl">{page}</div>
      </main>
    </div>
  );
}

function usePendingApprovals() {
  const [count, setCount] = useState(0);
  const refresh = () =>
    api<any[]>("/approvals?status=pending")
      .then((a) => setCount(a.length))
      .catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useEvents((e) => {
    if (e.type === "approval_requested" || e.type === "approval_resolved") refresh();
  });
  return count;
}
