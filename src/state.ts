import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface PeriodScore {
  home: number;
  away: number;
}

export interface WatcherState {
  seenFingerprints: Set<string>;
  lastTimestamp: number;
  /** Runs per period, keyed by event.period (0 = 1. jakso, 1 = 2. jakso,
   *  2 = supervuoro, 3 = kotiutuslyöntikilpailu). Runs reset per period. */
  periodRuns: Record<number, PeriodScore>;
  currentOuts: number;
  currentPeriod: number;
  currentBatTeamId: number | null;
  finished: boolean;
  announcementCount: number;
  lastSummaryTime: number;
}

/** Runs scored in a given period (zero if the period hasn't started). */
export function getPeriodScore(state: WatcherState, period: number): PeriodScore {
  return state.periodRuns[period] ?? { home: 0, away: 0 };
}

export function addRun(state: WatcherState, period: number, isHome: boolean, value: number): void {
  const s = state.periodRuns[period] ?? (state.periodRuns[period] = { home: 0, away: 0 });
  if (isHome) s.home += value;
  else s.away += value;
}

/** Period wins per team. A period counts once it is decided: a later period
 *  has started, or the match has finished. Ties award nobody. Supervuoro and
 *  kotiutuslyöntikilpailu are periods too, so the winner of the decider gets
 *  the match point. */
export function periodsWon(state: WatcherState): PeriodScore {
  let home = 0;
  let away = 0;
  for (const key of Object.keys(state.periodRuns)) {
    const p = Number(key);
    const decided = p < state.currentPeriod || state.finished;
    if (!decided) continue;
    const s = state.periodRuns[p];
    if (s.home > s.away) home++;
    else if (s.away > s.home) away++;
  }
  return { home, away };
}

export function loadState(filePath: string): WatcherState {
  if (!existsSync(filePath)) {
    return emptyState();
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    return {
      seenFingerprints: new Set(raw.seenFingerprints ?? []),
      lastTimestamp: raw.lastTimestamp ?? 0,
      periodRuns: normalizePeriodRuns(raw.periodRuns),
      currentOuts: raw.currentOuts ?? 0,
      currentPeriod: raw.currentPeriod ?? 0,
      currentBatTeamId: raw.currentBatTeamId ?? null,
      finished: raw.finished ?? false,
      announcementCount: 0,
      lastSummaryTime: 0,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(filePath: string, state: WatcherState): void {
  const data = {
    seenFingerprints: [...state.seenFingerprints],
    lastTimestamp: state.lastTimestamp,
    periodRuns: state.periodRuns,
    currentOuts: state.currentOuts,
    currentPeriod: state.currentPeriod,
    currentBatTeamId: state.currentBatTeamId,
    finished: state.finished,
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizePeriodRuns(raw: unknown): Record<number, PeriodScore> {
  const out: Record<number, PeriodScore> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, { home?: number; away?: number }>)) {
      out[Number(key)] = { home: value?.home ?? 0, away: value?.away ?? 0 };
    }
  }
  return out;
}

function emptyState(): WatcherState {
  return {
    seenFingerprints: new Set(),
    lastTimestamp: 0,
    periodRuns: {},
    currentOuts: 0,
    currentPeriod: 0,
    currentBatTeamId: null,
    finished: false,
    announcementCount: 0,
    lastSummaryTime: 0,
  };
}
