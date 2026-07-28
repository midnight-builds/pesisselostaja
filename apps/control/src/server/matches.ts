// Match lookup and live-state derivation against the pesistulokset.fi API.
// Scoring/period logic is NOT reimplemented here — it already exists, and is
// already subtle (see CLAUDE.md "Scoring"), in @pesisselostaja/core. This file
// only shapes core's output into the control app's own DayMatches/MatchState
// contracts (apps/control/src/shared/types.ts).
import {
  fetchMatchMetadata,
  fetchLiveEvents,
  emptyState,
  addRun,
  getPeriodScore,
  periodsWon,
  recomputeCurrentOutsKeyed,
  isMatchEndSubEvent,
  isRunScoringSubEvent,
  runValueOfSubEvent,
  type MatchMetadata,
} from "@pesisselostaja/core";
import type { DayMatches, MatchOption, MatchState } from "../shared/types.js";

// Same base URL and key as packages/core/src/api.ts's DEFAULT_API_BASE /
// DEFAULT_API_KEY. Core doesn't export those two constants (they're module-
// private), and none of its date-aware list helpers accept an arbitrary
// `date=` — matches-list?date= for a day other than "today" has to be built
// by hand. Keep this in sync with core's api.ts if the key ever rotates.
const API_BASE = "https://api.pesistulokset.fi/api/v1";
const API_KEY = "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";

// One picker screen can trigger the same day's fetch several times in quick
// succession (re-render, filter toggle, pull-to-refresh) — ~200 matches is
// wasted round-trip weight to repeat inside a few seconds of each other.
const DAY_CACHE_TTL_MS = 60_000;
const dayCache = new Map<string, { expiresAt: number; data: DayMatches }>();

// Team metadata (names, ids) barely changes mid-match, but a live view can
// poll getMatchState every few seconds — fetching it fresh every time would
// multiply load on the pesistulokset API for data that's static for the
// whole match. TTL, not "forever", only as a guard against a mid-day roster
// correction on the source's end.
const META_CACHE_TTL_MS = 5 * 60_000;
const metaCache = new Map<number, { expiresAt: number; data: MatchMetadata }>();

async function getCachedMeta(matchId: number): Promise<MatchMetadata> {
  const cached = metaCache.get(matchId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;
  const meta = await fetchMatchMetadata(matchId);
  metaCache.set(matchId, { expiresAt: now + META_CACHE_TTL_MS, data: meta });
  return meta;
}

interface RawTeam {
  name?: string;
  shorthand?: string;
}

interface RawMatch {
  id: number;
  home?: RawTeam;
  away?: RawTeam;
  date?: string | null;
  stadium?: { name?: string } | null;
  live: boolean;
  result?: { result_string?: string | null } | null;
}

interface RawGroup {
  matches?: RawMatch[];
}

interface RawSeries {
  seasonSeries?: { name?: string } | null;
  groups?: RawGroup[];
}

function matchStatus(m: RawMatch, resultString: string | null): MatchOption["status"] {
  if (m.live) return "live";
  return resultString ? "finished" : "upcoming";
}

export async function getDayMatches(date: string): Promise<DayMatches> {
  const now = Date.now();
  const cached = dayCache.get(date);
  if (cached && cached.expiresAt > now) return cached.data;

  const url = `${API_BASE}/public/matches-list?date=${encodeURIComponent(date)}&apikey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ottelulistan haku epäonnistui (${res.status}).`);
  const raw = (await res.json()) as RawSeries[];

  const matches: MatchOption[] = [];
  const stadiumSet = new Set<string>();
  const seriesSet = new Set<string>();

  for (const series of Array.isArray(raw) ? raw : []) {
    const seriesName = series.seasonSeries?.name ?? null;
    if (seriesName) seriesSet.add(seriesName);
    for (const group of series.groups ?? []) {
      for (const m of group.matches ?? []) {
        const stadiumName = m.stadium?.name ?? null;
        if (stadiumName) stadiumSet.add(stadiumName);
        const resultString = m.result?.result_string ?? null;
        matches.push({
          id: m.id,
          home: m.home?.name ?? "?",
          away: m.away?.name ?? "?",
          homeShort: m.home?.shorthand ?? m.home?.name ?? "?",
          awayShort: m.away?.shorthand ?? m.away?.name ?? "?",
          // ISO, UTC, as the API sends it — the caller (client) converts to
          // Europe/Helsinki for display; this field stays the source of truth.
          startsAt: m.date ?? null,
          seriesName,
          stadium: stadiumName,
          live: m.live,
          status: matchStatus(m, resultString),
          resultString,
        });
      }
    }
  }

  const data: DayMatches = {
    date,
    stadiums: [...stadiumSet].sort((a, b) => a.localeCompare(b, "fi")),
    seriesNames: [...seriesSet].sort((a, b) => a.localeCompare(b, "fi")),
    matches,
  };
  dayCache.set(date, { expiresAt: now + DAY_CACHE_TTL_MS, data });
  return data;
}

// packages/core's MatchResult type only declares `match_id` and `details` —
// the API's actual response also carries `result_string` as a sibling of
// `details` (verified live against /public/match), core just doesn't type
// it. Read it defensively rather than widening core's type from here.
function resultStringOf(meta: MatchMetadata): string | null {
  const result = meta.result as { result_string?: string | null } | undefined;
  return result?.result_string ?? null;
}

/** core's fetchMatchMetadata collapses every HTTP failure into one generic
 *  Error whose message ends in the status ("Match metadata fetch failed:
 *  404"), and the pesistulokset API answers an unknown id with exactly that
 *  404. Only that one status means "no such match" — a timeout or a 5xx must
 *  keep throwing, because "you typed the wrong number" and "the source is
 *  down" call for opposite reactions from the operator. */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /failed:\s*404\b/.test(err.message);
}

/** null = the source has no match with that id (a mistyped or mispasted
 *  number). Callers must decide what to say about it; this returns rather
 *  than throws, so "not found" cannot be mistaken for a broken API. */
export async function getMatch(id: number): Promise<MatchOption | null> {
  if (!Number.isInteger(id) || id <= 0) return null;

  let meta: MatchMetadata;
  try {
    meta = await fetchMatchMetadata(id);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  // A 200 that carries no teams is not a match either (the API has answered
  // with an error object under a 200 before) — treat it as not found rather
  // than reading `undefined.name` and turning it into a 500.
  if (meta?.home?.name == null || meta?.away?.name == null) return null;

  const resultString = resultStringOf(meta);
  return {
    id: meta.id,
    home: meta.home.name,
    away: meta.away.name,
    homeShort: meta.home.shorthand,
    awayShort: meta.away.shorthand,
    startsAt: meta.date ?? null,
    seriesName: meta.series?.custom_name ?? meta.series?.name ?? null,
    stadium: meta.stadium?.name ?? null,
    live: meta.live,
    status: meta.live ? "live" : resultString ? "finished" : "upcoming",
    resultString,
  };
}

export async function getMatchState(matchId: number): Promise<MatchState> {
  const [meta, eventsResult] = await Promise.all([
    getCachedMeta(matchId),
    fetchLiveEvents(matchId),
  ]);
  const events = eventsResult.events;

  if (events.length === 0) {
    // A match the scorer hasn't opened yet: no history to derive a score
    // from, but the picker already knows the teams from metadata.
    return {
      matchId,
      home: meta.home.shorthand,
      away: meta.away.shorthand,
      periodScores: [],
      totalHome: 0,
      totalAway: 0,
      periodsWonHome: 0,
      periodsWonAway: 0,
      currentPeriod: null,
      palot: null,
      battingTeam: null,
      finished: false,
      eventCount: 0,
      lastEventAt: null,
    };
  }

  // Fast-forwards through the full event history the same way the relay's
  // processEventsSilent does (apps/broadcast/src/commentaryLoop.ts) — derive
  // the scoring state without ever "speaking" anything. Palot are handled
  // separately below via recomputeCurrentOutsKeyed, core's single source of
  // truth for the current turn's out count, so no incremental out-tracking
  // is needed here.
  const state = emptyState();
  for (const event of events) {
    if (
      event.team != null &&
      (event.team !== state.currentBatTeamId ||
        event.inning !== state.currentInning ||
        event.batTurn !== state.currentBatTurn)
    ) {
      state.currentBatTeamId = event.team;
      state.currentInning = event.inning;
      state.currentBatTurn = event.batTurn;
    }
    if (event.period > 0 && event.period !== state.currentPeriod) {
      state.currentPeriod = event.period;
    }

    for (const sub of event.events) {
      if (isMatchEndSubEvent(sub)) state.finished = true;
      if (isRunScoringSubEvent(sub) && event.team !== null) {
        // One scoring marking = one run; runValueOfSubEvent already knows
        // stat values (score:3, homerun:2) are lyöntipisteet, not runs
        // (CLAUDE.md "Scoring") — never recompute that here.
        addRun(state, event.period, event.team === meta.home.id, runValueOfSubEvent(sub));
      }
    }
  }

  const { outs } = recomputeCurrentOutsKeyed(events);
  const won = periodsWon(state);

  const periodScores: MatchState["periodScores"] = [];
  for (let p = 0; p <= state.currentPeriod; p++) periodScores.push(getPeriodScore(state, p));
  const totalHome = periodScores.reduce((sum, s) => sum + s.home, 0);
  const totalAway = periodScores.reduce((sum, s) => sum + s.away, 0);

  const battingTeam =
    state.currentBatTeamId === meta.home.id ? meta.home.shorthand
    : state.currentBatTeamId === meta.away.id ? meta.away.shorthand
    : null;

  // event.timestamp is match-epoch-relative, not wall-clock (see
  // commentaryLoop.ts) — turning it into an absolute instant needs the
  // continuous epoch estimate a live poll loop builds up over many polls,
  // which a one-shot read like this doesn't have. serverDateMs (the API's
  // own Date header for this response) is the trustworthy clock available
  // here, so lastEventAt records "when we last confirmed the feed had
  // events", matching the field's stated purpose (liveness), not the
  // in-match clock of the event itself.
  const lastEventAt = new Date(eventsResult.serverDateMs ?? Date.now()).toISOString();

  return {
    matchId,
    home: meta.home.shorthand,
    away: meta.away.shorthand,
    periodScores,
    totalHome,
    totalAway,
    periodsWonHome: won.home,
    periodsWonAway: won.away,
    currentPeriod: state.currentPeriod,
    palot: outs,
    battingTeam,
    finished: state.finished,
    eventCount: events.length,
    lastEventAt,
  };
}
