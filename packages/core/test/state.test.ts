import { describe, it, expect } from "vitest";
import {
  emptyState,
  getPeriodScore,
  addRun,
  periodsWon,
  periodsPlayed,
  serializeWatcherState,
  deserializeWatcherState,
} from "../src/state.js";

describe("scoring: addRun / getPeriodScore", () => {
  it("accumulates runs per period and per team", () => {
    const s = emptyState();
    addRun(s, 0, true, 1);
    addRun(s, 0, true, 1);
    addRun(s, 0, false, 1);
    addRun(s, 1, false, 1);
    expect(getPeriodScore(s, 0)).toEqual({ home: 2, away: 1 });
    expect(getPeriodScore(s, 1)).toEqual({ home: 0, away: 1 });
  });

  it("returns 0-0 for a period with no recorded runs", () => {
    expect(getPeriodScore(emptyState(), 0)).toEqual({ home: 0, away: 0 });
  });

  it("adds oscscore-style multi-run values as given", () => {
    const s = emptyState();
    addRun(s, 2, true, 2);
    expect(getPeriodScore(s, 2)).toEqual({ home: 2, away: 0 });
  });
});

describe("periodsWon", () => {
  it("counts only periods before the current one while the match is live", () => {
    const s = emptyState();
    addRun(s, 0, true, 3); // 1. jakso: koti 3-0 → koti voitti
    addRun(s, 1, false, 5); // 2. jakso käynnissä: vieras johtaa, ei vielä ratkennut
    s.currentPeriod = 1;
    expect(periodsWon(s)).toEqual({ home: 1, away: 0 });
  });

  it("counts the current period too once the match is finished", () => {
    const s = emptyState();
    addRun(s, 0, true, 3);
    addRun(s, 1, false, 5);
    s.currentPeriod = 1;
    s.finished = true;
    expect(periodsWon(s)).toEqual({ home: 1, away: 1 });
  });

  it("awards a tied period to neither team", () => {
    const s = emptyState();
    addRun(s, 0, true, 2);
    addRun(s, 0, false, 2);
    s.currentPeriod = 0;
    s.finished = true;
    expect(periodsWon(s)).toEqual({ home: 0, away: 0 });
  });
});

describe("periodsPlayed", () => {
  it("is 0 for a fresh state and counts distinct periods with runs", () => {
    const s = emptyState();
    expect(periodsPlayed(s)).toBe(0);
    addRun(s, 0, true, 1);
    addRun(s, 0, false, 1);
    expect(periodsPlayed(s)).toBe(1);
    addRun(s, 2, true, 1); // supervuoro
    expect(periodsPlayed(s)).toBe(2);
  });
});

describe("serialize/deserialize round-trip", () => {
  function populatedState() {
    const s = emptyState();
    s.seenFingerprints = new Set(["0:1:0:100:2:0", "0:1:1:200:2:0"]);
    s.lastTimestamp = 1234;
    addRun(s, 0, true, 2);
    addRun(s, 1, false, 1);
    s.currentOuts = 2;
    s.paloTurnKey = "0:1:1:200";
    s.paloTurnMax = 2;
    s.currentPeriod = 1;
    s.currentBatTeamId = 200;
    s.currentInning = 1;
    s.currentBatTurn = 1;
    s.finished = false;
    s.announcedTurnKey = "0:1:1:200";
    return s;
  }

  it("restores every persisted field, including Set and periodRuns", () => {
    const original = populatedState();
    const restored = deserializeWatcherState(
      JSON.parse(JSON.stringify(serializeWatcherState(original)))
    );
    expect(restored.seenFingerprints).toEqual(original.seenFingerprints);
    expect(restored.periodRuns).toEqual(original.periodRuns);
    expect(restored.lastTimestamp).toBe(1234);
    expect(restored.currentOuts).toBe(2);
    expect(restored.paloTurnKey).toBe("0:1:1:200");
    expect(restored.paloTurnMax).toBe(2);
    expect(restored.currentPeriod).toBe(1);
    expect(restored.currentBatTeamId).toBe(200);
    expect(restored.currentInning).toBe(1);
    expect(restored.currentBatTurn).toBe(1);
    expect(restored.finished).toBe(false);
    expect(restored.announcedTurnKey).toBe("0:1:1:200");
  });

  it("resets runtime-only counters instead of persisting them", () => {
    const original = populatedState();
    original.announcementCount = 7;
    original.lastSummaryTime = 999;
    const restored = deserializeWatcherState(serializeWatcherState(original));
    expect(restored.announcementCount).toBe(0);
    expect(restored.lastSummaryTime).toBe(0);
  });

  it("deserializes null/garbage into a usable empty state", () => {
    expect(deserializeWatcherState(null)).toEqual(emptyState());
    expect(deserializeWatcherState({ periodRuns: "rikki" })).toEqual(emptyState());
  });

  it("restores numeric periodRuns keys from JSON string keys", () => {
    const restored = deserializeWatcherState({
      periodRuns: { "1": { home: 4 } },
    });
    expect(getPeriodScore(restored, 1)).toEqual({ home: 4, away: 0 });
  });
});
