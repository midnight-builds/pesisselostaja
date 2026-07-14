// File adapter for core's WatcherState (WatcherStateStore port): the whole
// state lives in one JSON file. The state shape, scoring logic and serialized
// form live in @pesisselostaja/core.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  emptyState,
  serializeWatcherState,
  deserializeWatcherState,
  type WatcherState,
} from "@pesisselostaja/core";

export {
  emptyState,
  getPeriodScore,
  addRun,
  periodsWon,
  periodsPlayed,
  type WatcherState,
  type PeriodScore,
} from "@pesisselostaja/core";

export function loadState(filePath: string): WatcherState {
  if (!existsSync(filePath)) return emptyState();
  try {
    return deserializeWatcherState(JSON.parse(readFileSync(filePath, "utf-8")));
  } catch {
    return emptyState();
  }
}

export function saveState(filePath: string, state: WatcherState): void {
  writeFileSync(filePath, JSON.stringify(serializeWatcherState(state), null, 2));
}
