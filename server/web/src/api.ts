import { useCallback, useEffect, useRef, useState } from "react";

const TOKEN_KEY = "minis-token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Call the server API with the stored token. JSON in, JSON (or text) out. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; text?: boolean } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: `Bearer ${getToken()}`,
      ...(opts.body !== undefined && typeof opts.body !== "string" ? { "content-type": "application/json" } : {}),
    },
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("minis-unauthorized"));
    throw new ApiError(res.status, typeof data === "object" && data?.error ? data.error : String(data));
  }
  return data as T;
}

/** Load data, with reload() and loading/error state. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(undefined);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(undefined);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);
  return { data, error, loading, reload, setData };
}

export type ServerEvent = { type: string; at: string; [k: string]: any };
type Listener = (e: ServerEvent) => void;

/** One shared SSE connection to /events for the whole app. */
class EventHub {
  private source?: EventSource;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(on: boolean) => void>();
  connected = false;

  start() {
    this.stop();
    const token = getToken();
    if (!token) return;
    const src = new EventSource(`/events?token=${encodeURIComponent(token)}`);
    this.source = src;
    const types = ["task_started", "task_finished", "text", "tool_call", "tool_result", "approval_requested", "approval_resolved", "channel_message", "compacted"];
    for (const t of types) src.addEventListener(t, (ev) => this.emit(JSON.parse((ev as MessageEvent).data)));
    src.onopen = () => this.setState(true);
    src.onerror = () => this.setState(false);
  }

  stop() {
    this.source?.close();
    this.source = undefined;
    this.setState(false);
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: (on: boolean) => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private emit(e: ServerEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private setState(on: boolean) {
    this.connected = on;
    for (const fn of this.stateListeners) fn(on);
  }
}

export const events = new EventHub();

/** Subscribe to server events while the component is mounted. */
export function useEvents(fn: Listener, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const off = events.on((e) => ref.current(e));
    return () => {
      off();
    };
  }, deps);
}

export function useConnected() {
  const [on, setOn] = useState(events.connected);
  useEffect(() => {
    const off = events.onState(setOn);
    return () => {
      off();
    };
  }, []);
  return on;
}

/** Hash routing: #/roles/dev → ["roles", "dev"]. */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(path: string) {
  window.location.hash = `#/${path}`;
}

export function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(iso).toLocaleString();
}
