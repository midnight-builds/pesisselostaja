const LS_PREFIX = "pesistulokset-v2-state-";

export interface PeriodScore {
  home: number;
  away: number;
}

export interface WatcherState {
  seenFingerprints: Set<string>;
  lastTimestamp: number;
  periodRuns: Record<number, PeriodScore>;
  currentOuts: number;
  currentPeriod: number;
  currentBatTeamId: number | null;
  currentInning: number;
  currentBatTurn: number;
  finished: boolean;
  announcementCount: number;
  lastSummaryTime: number;
}

export function getPeriodScore(state: WatcherState, period: number): PeriodScore {
  return state.periodRuns[period] ?? { home: 0, away: 0 };
}

export function addRun(state: WatcherState, period: number, isHome: boolean, value: number): void {
  const s = state.periodRuns[period] ?? (state.periodRuns[period] = { home: 0, away: 0 });
  if (isHome) s.home += value;
  else s.away += value;
}

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

export function loadState(matchId: number): WatcherState {
  try {
    const raw = localStorage.getItem(LS_PREFIX + matchId);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      seenFingerprints: new Set(parsed.seenFingerprints ?? []),
      lastTimestamp: parsed.lastTimestamp ?? 0,
      periodRuns: normalizePeriodRuns(parsed.periodRuns),
      currentOuts: parsed.currentOuts ?? 0,
      currentPeriod: parsed.currentPeriod ?? 0,
      currentBatTeamId: parsed.currentBatTeamId ?? null,
      currentInning: parsed.currentInning ?? 0,
      currentBatTurn: parsed.currentBatTurn ?? 0,
      finished: parsed.finished ?? false,
      announcementCount: 0,
      lastSummaryTime: 0,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(matchId: number, state: WatcherState): void {
  const data = {
    seenFingerprints: [...state.seenFingerprints],
    lastTimestamp: state.lastTimestamp,
    periodRuns: state.periodRuns,
    currentOuts: state.currentOuts,
    currentPeriod: state.currentPeriod,
    currentBatTeamId: state.currentBatTeamId,
    currentInning: state.currentInning,
    currentBatTurn: state.currentBatTurn,
    finished: state.finished,
  };
  localStorage.setItem(LS_PREFIX + matchId, JSON.stringify(data));
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
    currentInning: 0,
    currentBatTurn: 0,
    finished: false,
    announcementCount: 0,
    lastSummaryTime: 0,
  };
}
