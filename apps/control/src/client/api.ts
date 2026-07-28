/** Client side of the HTTP contract in ../shared/api.ts.
 *
 *  Everything the UI does to the server goes through here, so error handling
 *  and the SSE reconnect policy live in exactly one place. */

import type { ApiError, CreateJobRequest, PatchJobRequest, PatchKnobsRequest } from "../shared/api";
import { DEFAULT_RTMP_URL } from "../shared/api";
import type {
  ControlKnobs,
  DayMatches,
  Job,
  LiveState,
  LogLine,
  MatchOption,
  PreflightResult,
  RelayProcess,
} from "../shared/types";

export { DEFAULT_RTMP_URL };

/** Turns any failure — network, HTTP status, bad JSON — into a Finnish
 *  sentence, because every call site renders the message verbatim to an
 *  operator standing in a field. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
    });
  } catch {
    throw new Error("Palvelimeen ei saada yhteyttä");
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Palvelin vastasi virheellistä JSONia (HTTP ${res.status})`);
    }
  }

  if (!res.ok) {
    const err = body as ApiError | null;
    if (err && typeof err.error === "string") {
      throw new Error(err.detail ? `${err.error}: ${err.detail}` : err.error);
    }
    throw new Error(`Palvelinvirhe (HTTP ${res.status})`);
  }
  return body as T;
}

function postJson<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export const api = {
  live: () => request<LiveState>("/api/live"),
  matches: (date: string) => request<DayMatches>(`/api/matches?date=${encodeURIComponent(date)}`),
  match: (id: number) => request<MatchOption>(`/api/matches/${id}`),
  jobs: () => request<Job[]>("/api/jobs"),
  createJob: (payload: CreateJobRequest) => postJson<Job>("/api/jobs", payload),
  patchJob: (id: string, payload: PatchJobRequest) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  activateJob: (id: string) => postJson<Job>(`/api/jobs/${encodeURIComponent(id)}/activate`),
  preflight: () => postJson<PreflightResult>("/api/preflight"),
  relay: (action: "start" | "stop" | "restart") => postJson<RelayProcess>(`/api/relay/${action}`),
  knobs: (payload: PatchKnobsRequest) => postJson<ControlKnobs>("/api/knobs", payload),
  delayNudge: (deltaMs: number) => postJson<ControlKnobs>("/api/knobs/delay-nudge", { deltaMs }),
  log: (limit: number, level?: LogLine["level"]) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (level) q.set("level", level);
    return request<LogLine[]>(`/api/log?${q.toString()}`);
  },
};

export type LiveConnectionStatus = "connecting" | "open" | "down";

interface LiveConnectionOptions {
  onState: (state: LiveState) => void;
  onStatus: (status: LiveConnectionStatus) => void;
}

/** How long we tolerate silence on an "open" stream before assuming iOS froze
 *  it. The server pushes on every poll (seconds), so 30 s is already generous. */
const STALE_MS = 30_000;
const MAX_BACKOFF_MS = 15_000;

/** Opens the SSE stream and keeps it open.
 *
 *  iOS Safari suspends EventSource when the tab goes to the background and
 *  frequently never fires `error` on wake — the socket is just silently dead.
 *  So three things guard the connection:
 *    1. exponential backoff reconnect on error/close,
 *    2. a staleness watchdog that reconnects a silent-but-"open" stream,
 *    3. an immediate reconnect when the page becomes visible again.
 *  While disconnected we still poll GET /api/live once per retry, so the
 *  numbers on screen keep moving even if EventSource never opens at all
 *  (buffering proxy, etc.).
 *
 *  Returns a cleanup function. */
export function connectLive(opts: LiveConnectionOptions): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  let status: LiveConnectionStatus = "connecting";

  const setStatus = (next: LiveConnectionStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus(next);
  };

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (staleTimer) clearTimeout(staleTimer);
    retryTimer = null;
    staleTimer = null;
  };

  const armStaleWatchdog = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (stopped) return;
      // Open but silent: treat exactly like a dropped connection.
      scheduleReconnect();
    }, STALE_MS);
  };

  const handlePayload = (raw: string) => {
    try {
      opts.onState(JSON.parse(raw) as LiveState);
    } catch {
      return; // A malformed frame is not worth tearing the stream down for.
    }
    attempt = 0;
    setStatus("open");
    armStaleWatchdog();
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearTimers();
    source?.close();
    source = null;
    setStatus("down");

    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt += 1;

    // One-shot fallback so the view is not frozen while we wait.
    void api
      .live()
      .then((state) => {
        if (!stopped) opts.onState(state);
      })
      .catch(() => undefined);

    retryTimer = setTimeout(open, delay);
  };

  const open = () => {
    if (stopped) return;
    clearTimers();
    source?.close();
    if (status !== "open") setStatus("connecting");

    const es = new EventSource("/api/live/stream");
    source = es;
    es.addEventListener("live", (ev) => handlePayload((ev as MessageEvent<string>).data));
    // Unnamed frames too — a server-side rename should not blank the screen.
    es.onmessage = (ev: MessageEvent<string>) => handlePayload(ev.data);
    es.onopen = () => armStaleWatchdog();
    es.onerror = () => {
      if (es !== source) return;
      scheduleReconnect();
    };
  };

  const onVisible = () => {
    if (stopped || document.visibilityState !== "visible") return;
    if (status === "open") return;
    attempt = 0; // A deliberate return to the app deserves an instant retry.
    open();
  };

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);
  open();

  return () => {
    stopped = true;
    clearTimers();
    source?.close();
    source = null;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onVisible);
  };
}
