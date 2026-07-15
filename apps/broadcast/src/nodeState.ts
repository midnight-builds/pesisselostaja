// File adapter for core's WatcherState (WatcherStateStore port): the whole
// state lives in one JSON file. The state shape, scoring logic and serialized
// form live in @pesisselostaja/core.
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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

/** Async on purpose: this runs on every poll cycle, and a synchronous write
 *  would block the event loop — including NarrationFifo's 20ms tick that
 *  feeds ffmpeg — for the duration of the disk I/O (HANDOFF.md 8). */
export function saveState(filePath: string, state: WatcherState): Promise<void> {
  return writeFile(filePath, JSON.stringify(serializeWatcherState(state), null, 2));
}
