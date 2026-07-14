// Pure watcher-state logic: the state shape, scoring derivation and the
// serialized JSON form shared by every persistence adapter. Storage itself
// lives behind the WatcherStateStore port — the web app persists to
// localStorage, the broadcast app to a file.

export interface PeriodScore {
  home: number;
  away: number;
}

export interface WatcherState {
  seenFingerprints: Set<string>;
  lastTimestamp: number;
  periodRuns: Record<number, PeriodScore>;
  currentOuts: number;
  /** Turn key the current palot count belongs to; keeps palot monotonic per turn. */
  paloTurnKey: string | null;
  /** Highest palot count seen for {@link paloTurnKey} (never decreases mid-turn). */
  paloTurnMax: number;
  currentPeriod: number;
  currentBatTeamId: number | null;
  currentInning: number;
  currentBatTurn: number;
  finished: boolean;
  announcementCount: number;
  lastSummaryTime: number;
  /** Turn key (period:inning:batTurn:team) of the last bat-turn change spoken aloud. */
  announcedTurnKey: string | null;
}

/** Persistence port for {@link WatcherState}. Each app binds its own storage
 *  key up front and supplies an adapter: the web app a localStorage entry per
 *  matchId, the broadcast app a state JSON file. */
export interface WatcherStateStore {
  load(): WatcherState;
  save(state: WatcherState): void;
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

/** Distinct periods with any recorded runs — used to tell a single-jakso
 *  camp/tournament match apart from a normal multi-jakso one. */
export function periodsPlayed(state: WatcherState): number {
  return Object.keys(state.periodRuns).length;
}

export function emptyState(): WatcherState {
  return {
    seenFingerprints: new Set(),
    lastTimestamp: 0,
    periodRuns: {},
    currentOuts: 0,
    paloTurnKey: null,
    paloTurnMax: 0,
    currentPeriod: 0,
    currentBatTeamId: null,
    currentInning: 0,
    currentBatTurn: 0,
    finished: false,
    announcementCount: 0,
    lastSummaryTime: 0,
    announcedTurnKey: null,
  };
}

/** The persisted field set. announcementCount/lastSummaryTime are runtime-only
 *  counters — never persisted, always start fresh per process. */
export function serializeWatcherState(state: WatcherState): unknown {
  return {
    seenFingerprints: [...state.seenFingerprints],
    lastTimestamp: state.lastTimestamp,
    periodRuns: state.periodRuns,
    currentOuts: state.currentOuts,
    paloTurnKey: state.paloTurnKey,
    paloTurnMax: state.paloTurnMax,
    currentPeriod: state.currentPeriod,
    currentBatTeamId: state.currentBatTeamId,
    currentInning: state.currentInning,
    currentBatTurn: state.currentBatTurn,
    finished: state.finished,
    announcedTurnKey: state.announcedTurnKey,
  };
}

export function deserializeWatcherState(raw: unknown): WatcherState {
  const parsed = (raw ?? {}) as Record<string, unknown> & {
    seenFingerprints?: string[];
    periodRuns?: unknown;
  };
  return {
    seenFingerprints: new Set(parsed.seenFingerprints ?? []),
    lastTimestamp: (parsed.lastTimestamp as number) ?? 0,
    periodRuns: normalizePeriodRuns(parsed.periodRuns),
    currentOuts: (parsed.currentOuts as number) ?? 0,
    paloTurnKey: (parsed.paloTurnKey as string | null) ?? null,
    paloTurnMax: (parsed.paloTurnMax as number) ?? 0,
    currentPeriod: (parsed.currentPeriod as number) ?? 0,
    currentBatTeamId: (parsed.currentBatTeamId as number | null) ?? null,
    currentInning: (parsed.currentInning as number) ?? 0,
    currentBatTurn: (parsed.currentBatTurn as number) ?? 0,
    finished: (parsed.finished as boolean) ?? false,
    announcementCount: 0,
    lastSummaryTime: 0,
    announcedTurnKey: (parsed.announcedTurnKey as string | null) ?? null,
  };
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
