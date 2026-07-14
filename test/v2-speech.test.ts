import { describe, it, expect } from "vitest";
import {
  formatBatTurnChangeSpeech,
  formatStartupSpeech,
  eventFingerprint,
  type SpeechContext,
} from "../v2/src/speech.js";
import type { MatchMetadata, LiveEvent, SubEvent, Team } from "../v2/src/types.js";

// Fictional teams only (public repo, matches can involve minors — see
// feedback-fixtures-fictional-names). Home = Ketut, Away = Sudet.
function team(id: number, shorthand: string): Team {
  return { id, name: shorthand, shorthand, players: [], all_players: [] };
}
const meta: MatchMetadata = {
  id: 1, date: "2026-07-14",
  home: team(100, "Ketut"),
  away: team(200, "Sudet"),
  series: {}, stadium: { name: "Testikenttä" },
  live: true, started: true,
};

describe("formatScore ordering (via public callers) — HANDOFF task 2", () => {
  // Runs must always be spoken home-first, in match order, regardless of who
  // leads. The old bug printed away-first when the away team led ("6, 3, Sudet
  // johtaa" for a 3–6 game). See relay/HANDOFF.md.
  it("keeps home runs first even when the away team leads (turn change)", () => {
    const speech = formatBatTurnChangeSpeech(meta, 100, 200, 3, 6, 1, 1);
    expect(speech).toContain("3, 6, Sudet johtaa");
    expect(speech).not.toContain("6, 3");
  });

  it("keeps home runs first when the home team leads", () => {
    const speech = formatBatTurnChangeSpeech(meta, 200, 100, 7, 2, 1, 1);
    expect(speech).toContain("7, 2, Ketut johtaa");
  });

  it("keeps home runs first on a tie", () => {
    const speech = formatBatTurnChangeSpeech(meta, 200, 100, 4, 4, 1, 1);
    expect(speech).toContain("4, 4, tasatilanne");
  });

  it("also orders home-first in the startup summary when away leads", () => {
    const ctx: SpeechContext = {
      periodHomeRuns: 1, periodAwayRuns: 5,
      homePeriodsWon: 0, awayPeriodsWon: 0, periodsPlayed: 1,
      currentOuts: 0, currentPeriod: 0, currentBatTeamId: null,
    };
    const speech = formatStartupSpeech(meta, ctx);
    expect(speech).toContain("1, 5, Sudet johtaa");
    expect(speech).not.toContain("5, 1");
  });
});

describe("eventFingerprint cross-turn palo collision — HANDOFF task 1", () => {
  const paloSub = (): SubEvent => ({
    texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }],
  });
  function paloEvent(id: number, period: number, inning: number, batTurn: number, teamId: number): LiveEvent {
    return {
      id, groupType: "x", period, inning, batTurn, team: teamId, hTeam: 100,
      batter: null, pairIndex: null, hitNumber: null, hit: null,
      events: [paloSub()], timestamp: id, updated: null,
    };
  }

  it("distinguishes same-id palot in different turns (id resets each turn)", () => {
    // event.id restarts at 0 every turn and every palo's texts are identical
    // (`Palo` + out:1), so without turn coordinates the first palo of two
    // different vuoroparit collide on one fingerprint and the later one is
    // silently dropped from feed and speech.
    const turnA = eventFingerprint(paloEvent(2, 0, 1, 0, 100), 0);
    const turnB = eventFingerprint(paloEvent(2, 0, 2, 1, 200), 0);
    expect(turnA).not.toBe(turnB);
  });

  it("collapses the period-3 (kotiutuslyöntikilpailu) re-key so it is not double-announced", () => {
    // In period 3 the API briefly re-keys a turn-ending palo into the next
    // sisävuoro; including coordinates there would give that transient a fresh
    // fingerprint and double-announce it, so coordinates are dropped in p3.
    const a = eventFingerprint(paloEvent(5, 3, 1, 0, 100), 0);
    const b = eventFingerprint(paloEvent(5, 3, 1, 1, 200), 0);
    expect(a).toBe(b);
  });
});
