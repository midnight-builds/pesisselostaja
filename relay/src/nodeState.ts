// Node file-based persistence adapter for v2's WatcherState.
//
// The relay runs under Node, but v2's own state.ts persists to localStorage
// (browser). The scoring/turn *logic* is canonical in v2 and reused verbatim
// here (getPeriodScore/addRun/periodsWon/periodsPlayed); only load/save are
// reimplemented against the filesystem, mirroring v2's serialized field set
// (paloTurnKey/paloTurnMax/currentInning/currentBatTurn/announcedTurnKey).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { WatcherState, PeriodScore } from "../../v2/src/state.js";

export type { WatcherState, PeriodScore } from "../../v2/src/state.js";
export { getPeriodScore, addRun, periodsWon, periodsPlayed } from "../../v2/src/state.js";

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

export function loadState(filePath: string): WatcherState {
  if (!existsSync(filePath)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    return {
      seenFingerprints: new Set(raw.seenFingerprints ?? []),
      lastTimestamp: raw.lastTimestamp ?? 0,
      periodRuns: normalizePeriodRuns(raw.periodRuns),
      currentOuts: raw.currentOuts ?? 0,
      paloTurnKey: raw.paloTurnKey ?? null,
      paloTurnMax: raw.paloTurnMax ?? 0,
      currentPeriod: raw.currentPeriod ?? 0,
      currentBatTeamId: raw.currentBatTeamId ?? null,
      currentInning: raw.currentInning ?? 0,
      currentBatTurn: raw.currentBatTurn ?? 0,
      finished: raw.finished ?? false,
      // Runtime-only counters — never restored, always start fresh per process
      // (matches v2's loadState).
      announcementCount: 0,
      lastSummaryTime: 0,
      announcedTurnKey: raw.announcedTurnKey ?? null,
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
    paloTurnKey: state.paloTurnKey,
    paloTurnMax: state.paloTurnMax,
    currentPeriod: state.currentPeriod,
    currentBatTeamId: state.currentBatTeamId,
    currentInning: state.currentInning,
    currentBatTurn: state.currentBatTurn,
    finished: state.finished,
    announcedTurnKey: state.announcedTurnKey,
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
