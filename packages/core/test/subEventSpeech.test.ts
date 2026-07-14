import { describe, it, expect } from "vitest";
import {
  subEventToSpeech,
  runValueOfSubEvent,
  buildPlayerLookup,
  type SpeechContext,
} from "../src/speech.js";
import type { MatchMetadata, LiveEvent, SubEvent, Team, Player } from "../src/types.js";

// Fictional teams and players only (public repo, matches can involve minors).
function player(id: number, number: number, first: string, last: string): Player {
  return { id, number, name: `${first} ${last}`, first_name: first, last_name: last };
}
function team(id: number, shorthand: string, players: Player[]): Team {
  return { id, name: shorthand, shorthand, players, all_players: players.map((p) => p.id) };
}
const meta: MatchMetadata = {
  id: 1, date: "2026-07-14",
  home: team(100, "Ketut", [player(11, 5, "Milla", "Mäyrä"), player(12, 8, "Aino", "Ilves")]),
  away: team(200, "Sudet", [player(21, 3, "Veera", "Susi")]),
  series: {}, stadium: { name: "Testikenttä" },
  live: true, started: true,
};
const lookup = buildPlayerLookup(meta);

function liveEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: [], timestamp: 1, updated: null,
    ...overrides,
  };
}

function ctxWith(overrides: Partial<SpeechContext> = {}): SpeechContext {
  return {
    periodHomeRuns: 0, periodAwayRuns: 0,
    homePeriodsWon: 0, awayPeriodsWon: 0, periodsPlayed: 1,
    currentOuts: 0, currentPeriod: 0, currentBatTeamId: 100,
    currentInning: 0, currentBatTurn: 0,
    ...overrides,
  };
}

describe("runValueOfSubEvent", () => {
  it("returns oscscore as-is (multi-run kotiutuslyönti marking)", () => {
    const sub: SubEvent = { texts: [{ type: "stat", oscscore: 2 }] };
    expect(runValueOfSubEvent(sub)).toBe(2);
  });

  it("counts one scoring marking as exactly one run, whatever the stat value", () => {
    // Stat values are lyöntipisteitä, not runs: score:3 is still a single run.
    expect(runValueOfSubEvent({ texts: [{ type: "stat", score: 3 }] })).toBe(1);
    expect(runValueOfSubEvent({ texts: [{ type: "stat", homerun: 2 }] })).toBe(1);
    expect(runValueOfSubEvent({ texts: [{ type: "stat", walkscore: 1 }] })).toBe(1);
    expect(runValueOfSubEvent({ texts: [{ type: "stat", wtscore: 1 }] })).toBe(1);
  });

  it("returns 0 for non-scoring sub-events", () => {
    expect(runValueOfSubEvent({ texts: [{ type: "stat", out: 1 }] })).toBe(0);
    expect(runValueOfSubEvent({ texts: [{ type: "event", text: "Palo", base: null }] })).toBe(0);
    expect(runValueOfSubEvent({ texts: [] })).toBe(0);
  });
});

describe("subEventToSpeech: batter change", () => {
  const sub: SubEvent = {
    texts: ["Lyöntivuorossa", { type: "player", id: 11 }],
  };

  it("announces the batter as number + initial + last name", () => {
    expect(subEventToSpeech(liveEvent(), sub, meta, lookup)).toBe("Vuorossa 5 M Mäyrä.");
  });

  it("stays silent when batter-change announcements are off", () => {
    expect(subEventToSpeech(liveEvent(), sub, meta, lookup, false)).toBeNull();
  });
});

describe("subEventToSpeech: scoring events", () => {
  it("speaks a run with its bringer and appends the score when context is given", () => {
    const sub: SubEvent = {
      texts: [
        { type: "player", id: 11 },
        { type: "event", text: "löi juoksun, tuojana", base: null },
        { type: "player", id: 12 },
      ],
    };
    const ctx = ctxWith({ periodHomeRuns: 1, periodAwayRuns: 0 });
    expect(subEventToSpeech(liveEvent(), sub, meta, lookup, true, ctx)).toBe(
      "5 M Mäyrä löi juoksun, tuojana 8 A Ilves. 1, 0, Ketut johtaa."
    );
  });

  it("speaks a kunnari with the batter's name", () => {
    const sub: SubEvent = {
      texts: [{ type: "player", id: 21 }, { type: "event", text: "löi kunnarin", base: null }],
    };
    const ctx = ctxWith({ periodHomeRuns: 0, periodAwayRuns: 3, currentBatTeamId: 200 });
    expect(subEventToSpeech(liveEvent({ team: 200 }), sub, meta, lookup, true, ctx)).toBe(
      "3 V Susi löi kunnarin! 0, 3, Sudet johtaa."
    );
  });
});

describe("subEventToSpeech: palo", () => {
  const paloSub: SubEvent = {
    texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }],
  };

  it("speaks the batting team and the palo's Finnish ordinal", () => {
    const ctx = ctxWith({ currentOuts: 3, currentBatTeamId: 200 });
    expect(subEventToSpeech(liveEvent({ team: 200 }), paloSub, meta, lookup, true, ctx)).toBe(
      "Palo! Sudet. Kolmas palo."
    );
  });

  it("omits the ordinal without context", () => {
    expect(subEventToSpeech(liveEvent({ team: 100 }), paloSub, meta, lookup)).toBe(
      "Palo! Ketut."
    );
  });
});

describe("subEventToSpeech: match end", () => {
  const endSub: SubEvent = { texts: [{ type: "event", text: "Ottelu päättyi", base: null }] };

  it("reports the run score in a single-jakso match (camp/tournament)", () => {
    const ctx = ctxWith({ periodsPlayed: 1, periodHomeRuns: 2, periodAwayRuns: 6 });
    expect(subEventToSpeech(liveEvent(), endSub, meta, lookup, true, ctx)).toBe(
      "Ottelu päättyi! Sudet voitti, Ketut 2, Sudet 6."
    );
  });

  it("reports periods won in a multi-jakso match", () => {
    const ctx = ctxWith({
      periodsPlayed: 2, periodHomeRuns: 4, periodAwayRuns: 1,
      homePeriodsWon: 2, awayPeriodsWon: 0,
    });
    expect(subEventToSpeech(liveEvent(), endSub, meta, lookup, true, ctx)).toBe(
      "Ottelu päättyi! Ketut voitti, Ketut 2, Sudet 0."
    );
  });
});

describe("subEventToSpeech: filtering and generic texts", () => {
  it("returns null when only hidden/stat elements remain", () => {
    const sub: SubEvent = {
      texts: [{ type: "stat", score: 1 }, { type: "stat", hide: true, foo: 1 }],
    };
    expect(subEventToSpeech(liveEvent(), sub, meta, lookup)).toBeNull();
  });

  it("cleans dashes out of generic event texts for TTS", () => {
    const sub: SubEvent = {
      texts: [{ type: "event", text: "Vaihto – kentälle", base: null }],
    };
    expect(subEventToSpeech(liveEvent(), sub, meta, lookup)).toBe("Vaihto, kentälle.");
  });
});
