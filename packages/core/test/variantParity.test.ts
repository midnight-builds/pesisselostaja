/** Variant parity: a phrase variant may vary the WORDING, never the CONTENT.
 *
 *  The bug this file exists to prevent (issues #99, #100) is invisible to the
 *  usual test shape. Asserting "the output is one of these strings" passes
 *  happily while one variant in five quietly drops the batting team or the
 *  source's own description of how a run was scored — every variant is a
 *  grammatical Finnish sentence, so nothing looks broken. It took a listener
 *  asking "why didn't it say how that run happened?" mid-broadcast to find it.
 *
 *  So these tests assert the other direction: enumerate EVERY variant of a
 *  group and require each one to carry the same facts.
 *
 *  Fictional teams and players only (public repo, matches involve minors). */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildPlayerLookup,
  formatIdleSummary,
  formatWelcomeFiller,
  subEventToSpeech,
  groupToSpeech,
  type SpeechContext,
} from "../src/speech.js";
import type { LiveEvent, MatchMetadata, Player, SubEvent, Team } from "../src/types.js";

function player(id: number, number: number, first: string, last: string): Player {
  return { id, number, name: `${first} ${last}`, first_name: first, last_name: last };
}
function team(id: number, shorthand: string, players: Player[]): Team {
  return { id, name: shorthand, shorthand, players, all_players: players.map((p) => p.id) };
}

const meta: MatchMetadata = {
  id: 1,
  date: "2026-07-29",
  home: team(100, "Ketut", [player(11, 5, "Milla", "Mäyrä"), player(12, 8, "Aino", "Ilves")]),
  away: team(200, "Sudet", [player(21, 3, "Veera", "Karhu")]),
  series: {},
  stadium: { name: "Testikenttä" },
  live: true,
  started: true,
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

/** Renders every variant of one group exactly once.
 *
 *  pickVariant draws with Math.random and then nudges the index when it would
 *  repeat the previous pick, so a plain loop over random draws is both slow and
 *  (in principle) able to miss a variant. Driving Math.random through
 *  0/n, 1/n, … n-1/n walks the list in order instead: consecutive draws never
 *  collide, so the anti-repeat nudge stays out of the way and every variant is
 *  produced.
 *
 *  `count` is the number of variants the group is expected to have. It is
 *  asserted, so adding a variant without updating the expectation fails loudly
 *  rather than leaving the new one untested. */
const realRandom = Math.random;
afterEach(() => {
  Math.random = realRandom;
});

function allVariants(count: number, render: () => string | null): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    Math.random = () => i / count;
    const rendered = render();
    if (rendered !== null) out.push(rendered);
  }
  Math.random = realRandom;
  const distinct = new Set(out);
  expect(
    distinct.size,
    `odotettiin ${count} eri varianttia, saatiin ${distinct.size}: ${[...distinct].join(" | ")}`
  ).toBe(count);
  return out;
}

/** Every variant must contain every fragment. Case-insensitive on purpose: the
 *  same fact legitimately reads "Kolmas palo" at the start of a sentence and
 *  "kolmas palo" inside one — that is wording, which variants may vary. */
function expectEveryVariantCarries(variants: string[], fragments: string[]): void {
  for (const variant of variants) {
    for (const fragment of fragments) {
      expect(
        variant.toLowerCase(),
        `variantti "${variant}" pudotti tiedon "${fragment}"`
      ).toContain(fragment.toLowerCase());
    }
  }
}

// ------------------------------------------------------------------ fillers

describe("idle filler", () => {
  it("every variant names the batting team, the score and the margin (issue #100)", () => {
    const ctx = ctxWith({ periodHomeRuns: 6, periodAwayRuns: 1, currentBatTeamId: 200 });
    const variants = allVariants(5, () => formatIdleSummary(meta, ctx));
    expectEveryVariantCarries(variants, ["6", "1", "Ketut", "reilusti", "sisävuorossa on Sudet"]);
  });

  it("every tie variant names the batting team and the score", () => {
    const ctx = ctxWith({ periodHomeRuns: 3, periodAwayRuns: 3, currentBatTeamId: 100 });
    const variants = allVariants(4, () => formatIdleSummary(meta, ctx));
    expectEveryVariantCarries(variants, ["3, 3", "sisävuorossa on Ketut"]);
  });
});

describe("welcome filler", () => {
  it("every variant names both teams and the field", () => {
    const variants = allVariants(3, () => formatWelcomeFiller(meta));
    expectEveryVariantCarries(variants, ["Ketut vastaan Sudet", "pelikenttänä Testikenttä"]);
  });
});

// ------------------------------------------------------------------- events

function speechFor(sub: SubEvent, ctx?: SpeechContext): string | null {
  return subEventToSpeech(liveEvent({ events: [sub] }), sub, meta, lookup, true, ctx);
}

/** Shapes taken from match 144980 (29.7.2026), player ids replaced. */
const wtscoreSub: SubEvent = {
  texts: [
    { type: "event", text: "toi juoksun harhaheitolla" },
    { type: "player", id: 21 },
    { type: "stat", wtscore: 1 },
  ],
};

const scoreSub: SubEvent = {
  texts: [
    { type: "event", text: "löi juoksun, tuojana" },
    { type: "player", id: 11 },
    { type: "player", id: 12 },
    { type: "stat", score: 1 },
  ],
};

const homerunSub: SubEvent = {
  texts: [
    { type: "event", text: "löi kunnarin" },
    { type: "player", id: 11 },
    { type: "stat", homerun: 2 },
  ],
};

describe("run brought (wtscore)", () => {
  // The source ships the reason ready-made; two of three variants used to drop
  // it, so two thirds of harhaheitto runs were narrated as a bare "juoksu".
  it("every variant speaks the source's own phrase and the runner (issue #99)", () => {
    const variants = allVariants(3, () => speechFor(wtscoreSub));
    expectEveryVariantCarries(variants, ["toi juoksun harhaheitolla", "Karhu"]);
  });
});

describe("run scored", () => {
  it("every variant names both the batter and the tuoja", () => {
    const variants = allVariants(3, () => speechFor(scoreSub));
    // Mäyrä batted; Ilves came home from 3. pesä (CLAUDE.md Terminology).
    expectEveryVariantCarries(variants, ["Mäyrä", "Ilves", "tuojana"]);
    // Word order varies ("Mäyrä löi juoksun" / "Juoksun löi Mäyrä" /
    // "…kirjattu juoksu: sen löi Mäyrä"); that a run was HIT does not.
    for (const variant of variants) {
      expect(variant).toMatch(/juoks/i);
      expect(variant).toMatch(/löi/i);
    }
  });
});

describe("kunnari", () => {
  it("every variant names the hitter", () => {
    const variants = allVariants(3, () => speechFor(homerunSub));
    expectEveryVariantCarries(variants, ["Mäyrä", "unnari"]);
  });
});

describe("grouped hit (#154)", () => {
  // One swing, several markings. A variant that drops a tuoja here silently
  // erases a child's name from the broadcast — the exact class of loss this
  // file exists to catch.
  const groupedSubs: SubEvent[] = [
    { texts: [{ type: "event", text: "löi juoksun, tuojana" }, { type: "player", id: 11 }, { type: "player", id: 12 }, { type: "stat", score: 1 }] },
    { texts: [{ type: "event", text: "löi juoksun, tuojana" }, { type: "player", id: 11 }, { type: "player", id: 21 }, { type: "stat", score: 1 }] },
    { texts: [{ type: "event", text: "löi kunnarin" }, { type: "player", id: 11 }, { type: "stat", homerun: 1 }] },
  ];

  function groupedSpeech(): string | null {
    const event = liveEvent({ events: groupedSubs });
    return groupToSpeech(event, groupedSubs, [0, 1, 2], meta, lookup, true, undefined);
  }

  it("every variant names the batter, every tuoja and the kunnari", () => {
    const variants = allVariants(3, groupedSpeech);
    expectEveryVariantCarries(variants, ["Mäyrä", "Ilves", "Karhu", "unnari"]);
    // And the run count, or the score jump is unexplained.
    for (const variant of variants) expect(variant).toContain("Kolme juoksua.");
  });
});

describe("batter change", () => {
  it("every variant names the player — 'vuorossa' and 'lyömässä' mean the same thing", () => {
    const sub: SubEvent = { texts: ["Lyöntivuorossa", { type: "player", id: 11 }] };
    const variants = allVariants(6, () => speechFor(sub));
    expectEveryVariantCarries(variants, ["Mäyrä"]);
  });
});

describe("palo", () => {
  it("every variant names the team and the ordinal", () => {
    const sub: SubEvent = { texts: [{ type: "event", text: "Palo" }] };
    const ctx = ctxWith({ currentOuts: 3 });
    const variants = allVariants(2, () => speechFor(sub, ctx));
    expectEveryVariantCarries(variants, ["Ketut", "kolmas palo"]);
  });
});

// -------------------------------------------------------------- multi-run

describe("a marking that brings more than one run", () => {
  // oscscore > 1 is rare but real (confirmed by the user 29.7.2026). The run
  // phrases are all singular, so without this the scoreboard jumps two while
  // the sentence describes one.
  it("says the count out loud, in every variant", () => {
    const sub: SubEvent = {
      texts: [
        { type: "event", text: "löi juoksun, tuojana" },
        { type: "player", id: 11 },
        { type: "player", id: 12 },
        { type: "stat", oscscore: 2 },
      ],
    };
    const ctx = ctxWith({ periodHomeRuns: 4, periodAwayRuns: 1 });
    const variants = allVariants(3, () => speechFor(sub, ctx));
    expectEveryVariantCarries(variants, ["Kaksi juoksua.", "4, 1"]);
  });

  it("stays silent about the count for an ordinary single run", () => {
    const variants = allVariants(3, () => speechFor(scoreSub, ctxWith({ periodHomeRuns: 1 })));
    for (const variant of variants) expect(variant).not.toContain("juoksua");
  });
});
