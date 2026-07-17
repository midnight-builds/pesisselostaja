import type { LiveEventsResponse, LiveMatchSummary, MatchMetadata } from "./types.js";

const DEFAULT_API_BASE = "https://api.pesistulokset.fi/api/v1";
const DEFAULT_API_KEY = "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";

export interface ApiOptions {
  apiBase?: string;
  apiKey?: string;
  /** Overrides the default 8s fetch timeout. Callers polling on a tighter
   *  cadence than the server's response-cache window can lower this, since
   *  waiting past the cache TTL for a hung request buys nothing. */
  timeoutMs?: number;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = 8000,
  headers?: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

/** "YYYY-MM-DD HH:mm:ss" in Europe/Helsinki — the exact format the events
 *  endpoint's `after=` parameter requires (anything else → 400
 *  "Virheellinen aikaleima"; verified against the pesistulokset.fi
 *  frontend's own formatting). sv-SE locale conveniently renders ISO-like. */
export function formatHelsinkiTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(date);
}

export async function fetchMatchMetadata(
  matchId: number,
  opts: ApiOptions = {}
): Promise<MatchMetadata> {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const key = opts.apiKey ?? DEFAULT_API_KEY;
  const url = `${base}/public/match?id=${matchId}&apikey=${key}`;
  const res = await fetchWithTimeout(url, opts.timeoutMs);
  if (!res.ok) throw new Error(`Match metadata fetch failed: ${res.status}`);
  return res.json() as Promise<MatchMetadata>;
}

export async function fetchLiveMatches(opts: ApiOptions = {}): Promise<LiveMatchSummary[]> {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const key = opts.apiKey ?? DEFAULT_API_KEY;
  const date = new Date().toISOString().slice(0, 10);
  const url = `${base}/public/matches-list?date=${date}&apikey=${key}`;
  const res = await fetchWithTimeout(url, 10000);
  if (!res.ok) return [];

  type RawItem = {
    seasonSeries?: { name?: string };
    groups?: Array<{ matches?: Array<{ id: number; home: { id: number; name: string; shorthand: string }; away: { id: number; name: string; shorthand: string }; live: boolean }> }>;
  };

  const data = await res.json() as RawItem[];
  if (!Array.isArray(data)) return [];

  const result: LiveMatchSummary[] = [];
  for (const item of data) {
    const seriesName = item.seasonSeries?.name;
    for (const group of item.groups ?? []) {
      for (const m of group.matches ?? []) {
        if (m.live) result.push({ id: m.id, home: m.home, away: m.away, live: true, matchStatus: "live", startTime: null, seriesName });
      }
    }
  }
  return result;
}

export async function fetchTodayMatches(opts: ApiOptions = {}): Promise<LiveMatchSummary[]> {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const key = opts.apiKey ?? DEFAULT_API_KEY;
  const date = new Date().toISOString().slice(0, 10);
  const url = `${base}/public/matches-list?date=${date}&apikey=${key}`;
  const res = await fetchWithTimeout(url, 10000);
  if (!res.ok) return [];

  type RawMatch = {
    id: number;
    home: { id: number; name: string; shorthand: string };
    away: { id: number; name: string; shorthand: string };
    live: boolean;
    date?: string | null;
    result?: { result_string?: string | null } | null;
  };
  type RawItem = {
    seasonSeries?: { name?: string };
    groups?: Array<{ matches?: RawMatch[] }>;
  };

  const data = await res.json() as RawItem[];
  if (!Array.isArray(data)) return [];

  const result: LiveMatchSummary[] = [];
  for (const item of data) {
    const seriesName = item.seasonSeries?.name;
    for (const group of item.groups ?? []) {
      for (const m of group.matches ?? []) {
        const matchStatus = m.live ? "live"
          : m.result?.result_string ? "finished"
          : "upcoming";
        result.push({
          id: m.id, home: m.home, away: m.away, live: m.live,
          matchStatus, startTime: m.date ?? null, seriesName,
        });
      }
    }
  }
  return result;
}

export interface LiveEventsFetchOptions extends ApiOptions {
  /** Delta query: only events after this instant. A string is the required
   *  "YYYY-MM-DD HH:mm:ss" Europe/Helsinki wall-clock form (see
   *  formatHelsinkiTimestamp); a number is passed through as-is (legacy).
   *  Verified live 2026-07-16 to work as a true delta on a running match. */
  after?: string | number;
  /** The API delays the public feed ~2 min by default; skip-delay=true (same
   *  parameter the pesistulokset.fi frontend sends) serves events sooner.
   *  Verified live 2026-07-16: cut publication delay ~25-45%. */
  skipDelay?: boolean;
  /** Previous response's ETag → sent as If-None-Match. On 304 the result has
   *  notModified=true and an empty events list (verified live 2026-07-16:
   *  the endpoint honors conditional requests). */
  etag?: string;
}

/** LiveEventsResponse plus transport metadata for delta polling. All fields
 *  optional/additive, so existing callers are unaffected. */
export interface LiveEventsResult extends LiveEventsResponse {
  /** True when the server answered 304 Not Modified (events is then []). */
  notModified?: boolean;
  /** ETag of this response (or the request ETag on a 304), for the next
   *  conditional request. */
  etag?: string | null;
  /** Server's Date header as ms epoch — the wall clock the `after` parameter
   *  is judged against server-side. Events carry no per-event wall-clock
   *  field (verified against real data 2026-07-17), so delta callers derive
   *  the next `after` from this instead of from event timestamps. */
  serverDateMs?: number | null;
}

export async function fetchLiveEvents(
  matchId: number,
  opts: LiveEventsFetchOptions = {}
): Promise<LiveEventsResult> {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  let url = `${base}/online/${matchId}/events`;
  // Built by hand instead of URLSearchParams: the timestamp must encode its
  // space as %20 (the form verified against the live API), not the "+" that
  // URLSearchParams produces.
  const parts: string[] = [];
  if (opts.after !== undefined) parts.push(`after=${encodeURIComponent(String(opts.after))}`);
  if (opts.skipDelay) parts.push("skip-delay=true");
  if (parts.length > 0) url += `?${parts.join("&")}`;
  const headers = opts.etag ? { "If-None-Match": opts.etag } : undefined;
  const res = await fetchWithTimeout(url, opts.timeoutMs, headers);
  const dateHeader = res.headers.get("date");
  const serverDateMs = dateHeader ? Date.parse(dateHeader) || null : null;
  if (res.status === 304) {
    return { events: [], notModified: true, etag: opts.etag ?? null, serverDateMs };
  }
  if (!res.ok) throw new Error(`Live events fetch failed: ${res.status}`);
  const body = (await res.json()) as LiveEventsResponse;
  return { ...body, notModified: false, etag: res.headers.get("etag"), serverDateMs };
}
