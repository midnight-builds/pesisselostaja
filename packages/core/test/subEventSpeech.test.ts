import { describe, it, expect } from "vitest";
import {
  subEventToSpeech,
  runValueOfSubEvent,
  buildPlayerLookup,
  formatWelcomeFiller,
  formatIdleSummary,
  stadiumSpeechName,
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
// "Susi" appears in both rosters on purpose: shared surnames must be spoken
// with the first name, unique ones as the bare surname.
const meta: MatchMetadata = {
  id: 1, date: "2026-07-14",
  home: team(100, "Ketut", [
    player(11, 5, "Milla", "Mäyrä"),
    player(12, 8, "Aino", "Ilves"),
    player(13, 9, "Liisa", "Susi"),
  ]),
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

  it("announces the batter by surname only", () => {
    expect([
      "Vuorossa Mäyrä.",
      "Nyt vuorossa Mäyrä.",
      "Lyömässä Mäyrä.",
    ]).toContain(subEventToSpeech(liveEvent(), sub, meta, lookup));
  });

  it("adds the first name when the match has two players with the same surname", () => {
    const ambiguous: SubEvent = { texts: ["Lyöntivuorossa", { type: "player", id: 13 }] };
    expect([
      "Vuorossa Liisa Susi.",
      "Nyt vuorossa Liisa Susi.",
      "Lyömässä Liisa Susi.",
    ]).toContain(subEventToSpeech(liveEvent(), ambiguous, meta, lookup));
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
    expect([
      "Mäyrä löi juoksun, tuojana Ilves. 1, 0, Ketut johtaa.",
      "Juoksun löi Mäyrä, tuojana Ilves. 1, 0, Ketut johtaa.",
      "Tulospalveluun on kirjattu juoksu: sen löi Mäyrä, tuojana Ilves. 1, 0, Ketut johtaa.",
    ]).toContain(subEventToSpeech(liveEvent(), sub, meta, lookup, true, ctx));
  });

  it("speaks a kunnari with the batter's name (first name on a shared surname)", () => {
    const sub: SubEvent = {
      texts: [{ type: "player", id: 21 }, { type: "event", text: "löi kunnarin", base: null }],
    };
    const ctx = ctxWith({ periodHomeRuns: 0, periodAwayRuns: 3, currentBatTeamId: 200 });
    expect([
      "Veera Susi löi kunnarin! 0, 3, Sudet johtaa.",
      "Kunnari! Sen löi Veera Susi. 0, 3, Sudet johtaa.",
      "Veera Susi lyö kunnarin! 0, 3, Sudet johtaa.",
    ]).toContain(subEventToSpeech(liveEvent({ team: 200 }), sub, meta, lookup, true, ctx));
  });
});

describe("subEventToSpeech: palo", () => {
  const paloSub: SubEvent = {
    texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }],
  };

  it("speaks the batting team and the palo's Finnish ordinal", () => {
    const ctx = ctxWith({ currentOuts: 3, currentBatTeamId: 200 });
    expect([
      "Palo! Sudet. Kolmas palo.",
      "Joukkueen Sudet kolmas palo!",
    ]).toContain(subEventToSpeech(liveEvent({ team: 200 }), paloSub, meta, lookup, true, ctx));
  });

  it("omits the ordinal without context", () => {
    expect(subEventToSpeech(liveEvent({ team: 100 }), paloSub, meta, lookup)).toBe(
      "Palo! Ketut."
    );
  });
});

describe("subEventToSpeech: match end", () => {
  const endSub: SubEvent = { texts: [{ type: "event", text: "Ottelu päättyi", base: null }] };

  it("reports the run score and vuoropari count in a single-jakso match (camp/tournament)", () => {
    const ctx = ctxWith({ periodsPlayed: 1, periodHomeRuns: 2, periodAwayRuns: 6, currentInning: 2 });
    expect(subEventToSpeech(liveEvent(), endSub, meta, lookup, true, ctx)).toBe(
      "Ottelu päättyi! Sudet voitti, Ketut 2, Sudet 6. Ottelussa pelattiin kolme vuoroparia."
    );
  });

  it("reports periods won and jakso count in a multi-jakso match", () => {
    const ctx = ctxWith({
      periodsPlayed: 2, periodHomeRuns: 4, periodAwayRuns: 1,
      homePeriodsWon: 2, awayPeriodsWon: 0,
    });
    expect(subEventToSpeech(liveEvent(), endSub, meta, lookup, true, ctx)).toBe(
      "Ottelu päättyi! Ketut voitti, Ketut 2, Sudet 0. Ottelussa pelattiin kaksi jaksoa."
    );
  });

  it("names the supervuoro as the decider when the match reached period 2", () => {
    const ctx = ctxWith({
      periodsPlayed: 3, currentPeriod: 2,
      homePeriodsWon: 2, awayPeriodsWon: 1,
    });
    expect(subEventToSpeech(liveEvent({ period: 2 }), endSub, meta, lookup, true, ctx)).toBe(
      "Ottelu päättyi! Ketut voitti, Ketut 2, Sudet 1. Ratkaisu syntyi supervuorossa."
    );
  });
});

describe("formatWelcomeFiller and stadium name", () => {
  it("truncates a piped camp-field code to its first part", () => {
    expect(stadiumSpeechName("12 Tupos B | LEIRITUOTANTO")).toBe("12 Tupos B");
    expect(stadiumSpeechName("Hiukkavaaran pesäpallostadion")).toBe("Hiukkavaaran pesäpallostadion");
  });

  it("welcomes with the team pair, and the stadium in at least one variant", () => {
    const fillers = new Set<string>();
    for (let i = 0; i < 40; i++) fillers.add(formatWelcomeFiller(meta));
    for (const f of fillers) expect(f).toContain("Ketut vastaan Sudet");
    expect([...fillers].some((f) => f.includes("pelikenttänä Testikenttä"))).toBe(true);
  });
});

describe("source attribution variants", () => {
  it("occasionally attributes the idle filler to tulospalvelu", () => {
    const ctx = ctxWith({ periodHomeRuns: 4, periodAwayRuns: 3 });
    const outputs = new Set<string>();
    for (let i = 0; i < 60; i++) outputs.add(formatIdleSummary(meta, ctx));
    expect([...outputs].some((o) => o.startsWith("Tulospalvelun mukaan"))).toBe(true);
    expect([...outputs].some((o) => !o.startsWith("Tulospalvelun mukaan"))).toBe(true);
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
