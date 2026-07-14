// localStorage adapter for core's WatcherState (WatcherStateStore port):
// one entry per matchId. The state shape, scoring logic and serialized form
// live in @pesisselostaja/core.
import {
  emptyState,
  serializeWatcherState,
  deserializeWatcherState,
  type WatcherState,
} from "@pesisselostaja/core";

export {
  getPeriodScore,
  addRun,
  periodsWon,
  periodsPlayed,
  type WatcherState,
  type PeriodScore,
} from "@pesisselostaja/core";

const LS_PREFIX = "pesisselostaja-v2-state-";

export function loadState(matchId: number): WatcherState {
  try {
    const raw = localStorage.getItem(LS_PREFIX + matchId);
    if (!raw) return emptyState();
    return deserializeWatcherState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

export function saveState(matchId: number, state: WatcherState): void {
  localStorage.setItem(LS_PREFIX + matchId, JSON.stringify(serializeWatcherState(state)));
}
