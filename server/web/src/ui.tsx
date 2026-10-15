import { Badge, Button, Card, cn, Skeleton } from "@cz/design-system";
import type { ReactNode } from "react";

/** Page title row with optional actions on the right. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-heading text-fg">{title}</h1>
        {description && <p className="mt-1 text-body text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-8", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-title-sm text-fg">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Card className="px-5 py-8 text-center text-body text-fg-muted">{children}</Card>;
}

export function Loading() {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-14 rounded-card" />
      <Skeleton className="h-14 rounded-card" />
      <Skeleton className="h-14 rounded-card" />
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-danger-line bg-danger-soft px-4 py-3 text-body text-danger-fg">{children}</p>;
}

const statusTone: Record<string, "neutral" | "accent" | "success" | "warning" | "danger" | "info"> = {
  running: "accent",
  pending: "warning",
  done: "success",
  approved: "success",
  failed: "danger",
  denied: "danger",
  cancelled: "neutral",
  expired: "neutral",
  interrupted: "warning",
};

const statusText: Record<string, string> = {
  running: "运行中",
  pending: "待审批",
  done: "完成",
  approved: "已批准",
  failed: "失败",
  denied: "已拒绝",
  cancelled: "已取消",
  expired: "已过期",
  interrupted: "已中断",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTone[status] ?? "neutral"} dot>
      {statusText[status] ?? status}
    </Badge>
  );
}

/** Monospace JSON / text block. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cn("overflow-x-auto rounded-md bg-sunken p-3 font-mono text-footnote whitespace-pre-wrap break-words text-fg-muted", className)}>
      {children}
    </pre>
  );
}

export function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & React.ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} {...props}>
      {children}
    </Button>
  );
}

/** Small "copied / saved / failed" message at the bottom of the screen. */
let toastTimer: number | undefined;
export function toast(message: string) {
  let el = document.getElementById("minis-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "minis-toast";
    el.setAttribute("role", "status");
    el.className =
      "fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-control bg-inverse px-4 py-2 text-body text-fg-inverse shadow-lg md:bottom-8";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el!.style.display = "none";
  }, 2600);
}
