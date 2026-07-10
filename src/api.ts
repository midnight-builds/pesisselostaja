import type { LiveEventsResponse, LiveMatchSummary, MatchMetadata } from "./types.js";

const DEFAULT_API_BASE = "https://api.pesistulokset.fi/api/v1";
const DEFAULT_API_KEY = "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";

export interface ApiOptions {
  apiBase?: string;
  apiKey?: string;
}

async function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMatchMetadata(
  matchId: number,
  opts: ApiOptions = {}
): Promise<MatchMetadata> {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const key = opts.apiKey ?? DEFAULT_API_KEY;
  const url = `${base}/public/match?id=${matchId}&apikey=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Match metadata fetch failed: ${res.status}`);
  return res.json() as Promise<MatchMetadata>;
}

export async function fetchLiveMatches(opts: ApiOptions = {}): Promise<LiveMatchSummary[]> {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const key = opts.apiKey ?? DEFAULT_API_KEY;
  const date = new Date().toISOString().slice(0, 10);
  const url = `${base}/public/matches-list?date=${date}&apikey=${key}`;
  const res = await fetchWithTimeout(url);
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
        if (m.live) result.push({ id: m.id, home: m.home, away: m.away, live: true, seriesName });
      }
    }
  }
  return result;
}

export async function fetchLiveEvents(
  matchId: number,
  opts: ApiOptions & { after?: number } = {}
): Promise<LiveEventsResponse> {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  let url = `${base}/online/${matchId}/events`;
  const params = new URLSearchParams();
  if (opts.after !== undefined) params.set("after", String(opts.after));
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Live events fetch failed: ${res.status}`);
  return res.json() as Promise<LiveEventsResponse>;
}
