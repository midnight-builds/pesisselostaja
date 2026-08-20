/** Issue #154: one swing, several markings, one sentence.
 *
 *  Live on 31.7.2026 (match 145918, 10.55.35) a kunnari that cleared the bases
 *  was spoken as four sentences in the same second, each naming a different
 *  tuoja, and only the last one said "Kunnari!". To a listener it sounded like
 *  four hits in a row. It was one swing: the scorer records every runner who
 *  reached home as its own marking.
 *
 *  The sub-event shapes below are copied from that match's real API response
 *  (`online/145918/events`) — same nesting, same stat keys, same player-element
 *  order — with fictional names and numbers, because the repo is public and
 *  the players are minors.
 *
 *  Operator's decision, recorded in the issue: merge into one sentence AND read
 *  every tuoja by name. */

import { describe, it, expect } from "vitest";
import {
  groupSubEventsForSpeech,
  groupToSpeech,
  buildPlayerLookup,
  type SpeechContext,
} from "../src/speech.js";
import type { MatchMetadata, LiveEvent, SubEvent, Team, Player } from "../src/types.js";

function player(id: number, number: number, first: string, last: string): Player {
  return { id, number, name: `${first} ${last}`, first_name: first, last_name: last };
}
function team(id: number, shorthand: string, players: Player[]): Team {
  return { id, name: shorthand, shorthand, players, all_players: players.map((p) => p.id) };
}

const LYOJA = player(11, 1, "Milla", "Mäyrä");
const A = player(12, 2, "Aino", "Ilves");
const B = player(13, 3, "Liisa", "Karhu");
const C = player(14, 4, "Sanni", "Kettu");

const meta: MatchMetadata = {
  id: 1,
  date: "2026-07-31",
  home: team(100, "Ketut", [LYOJA, A, B, C]),
  away: team(200, "Sudet", [player(21, 1, "Veera", "Susi")]),
  series: {},
  stadium: { name: "Testikenttä" },
  live: true,
  started: true,
};
const lookup = buildPlayerLookup(meta);

/** "<lyöjä> löi juoksun, tuojana <runner>" — the shape the API sends, with the
 *  batter first and `role: "batter"` exactly as in the live data. */
function scored(batter: Player, runner: Player): SubEvent {
  return {
    texts: [
      { team: 100, type: "player", number: batter.number, role: "batter" },
      { type: "event", text: "löi juoksun, tuojana", base: null },
      { team: 100, type: "player", number: runner.number },
      { type: "stat", score: 1 },
    ],
  } as unknown as SubEvent;
}

/** The kunnari marking names only the batter — and carries no `role`, which is
 *  why grouping compares the FIRST player element rather than the role. */
function kunnari(batter: Player): SubEvent {
  return {
    texts: [
      { team: 100, type: "player", number: batter.number },
      { type: "event", text: "löi kunnarin", base: null },
      { type: "stat", homerun: 1 },
    ],
  } as unknown as SubEvent;
}

function brought(who: Player): SubEvent {
  return {
    texts: [
      { team: 100, type: "player", number: who.number },
      { type: "event", text: "toi juoksun harhaheitolla", base: null },
      { type: "stat", wtscore: 1 },
    ],
  } as unknown as SubEvent;
}

function liveEvent(subs: SubEvent[]): LiveEvent {
  return {
    id: 1, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: subs, timestamp: 1, updated: null,
  } as unknown as LiveEvent;
}

function ctx(overrides: Partial<SpeechContext> = {}): SpeechContext {
  return {
    periodHomeRuns: 8, periodAwayRuns: 6,
    homePeriodsWon: 0, awayPeriodsWon: 0, periodsPlayed: 1,
    currentOuts: 0, currentPeriod: 0, currentBatTeamId: 100,
    currentInning: 0, currentBatTurn: 0,
    ...overrides,
  };
}

function speakAll(subs: SubEvent[]): string[] {
  const event = liveEvent(subs);
  return groupSubEventsForSpeech(subs)
    .map((g) => groupToSpeech(event, subs, g, meta, lookup, true, ctx()))
    .filter((s): s is string => s !== null);
}

describe("one swing = one sentence (#154)", () => {
  it("speaks a bases-clearing kunnari as ONE sentence naming every tuoja", () => {
    // The exact 31.7. shape: three runners home, then the kunnari marking.
    const subs = [scored(LYOJA, A), scored(LYOJA, B), scored(LYOJA, C), kunnari(LYOJA)];

    expect(groupSubEventsForSpeech(subs)).toEqual([[0, 1, 2, 3]]);

    const spoken = speakAll(subs);
    expect(spoken).toHaveLength(1);
    const text = spoken[0];
    // Every tuoja by name — the operator's explicit decision.
    expect(text).toContain("Ilves");
    expect(text).toContain("Karhu");
    expect(text).toContain("Kettu");
    expect(text).toContain("Mäyrä");
    // A kunnari must still be announced as one.
    expect(text.toLowerCase()).toContain("kunnari");
    // Four markings = four runs, so the score jump is explained.
    expect(text).toContain("Neljä juoksua.");
  });

  it("groups a two-run hit without a kunnari as well", () => {
    const subs = [scored(LYOJA, A), scored(LYOJA, B)];
    const spoken = speakAll(subs);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain("Ilves");
    expect(spoken[0]).toContain("Karhu");
    expect(spoken[0]).toContain("Kaksi juoksua.");
    expect(spoken[0].toLowerCase()).not.toContain("kunnari");
  });

  it("leaves a single run exactly as it was", () => {
    const spoken = speakAll([scored(LYOJA, A)]);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain("Mäyrä");
    expect(spoken[0]).toContain("Ilves");
    // No count for one run — the singular phrasing already says it.
    expect(spoken[0]).not.toContain("juoksua.");
  });

  it("does not merge two different batters", () => {
    const subs = [scored(LYOJA, A), scored(A, B)];
    expect(groupSubEventsForSpeech(subs)).toEqual([[0], [1]]);
    expect(speakAll(subs)).toHaveLength(2);
  });

  it("does not merge harhaheitot — they are separate things that happened", () => {
    // "toi juoksun" has no batter, and two in a row are two events, not one
    // swing. Merging them would invent a hit that never happened.
    const subs = [brought(A), brought(B)];
    expect(groupSubEventsForSpeech(subs)).toEqual([[0], [1]]);
    expect(speakAll(subs)).toHaveLength(2);
  });

  it("keeps a solo kunnari its own sentence", () => {
    const spoken = speakAll([kunnari(LYOJA)]);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].toLowerCase()).toContain("kunnari");
  });

  it("separates a hit from an unrelated marking that follows it", () => {
    const subs = [scored(LYOJA, A), scored(LYOJA, B), brought(C)];
    expect(groupSubEventsForSpeech(subs)).toEqual([[0, 1], [2]]);
  });

  it("still announces the kunnari when no name resolves at all", () => {
    // The relay fetches the roster once at startup, so starting before the
    // lineup is published leaves every name unresolvable for the whole match
    // (reference-lineups-published-late). An earlier version of the grouping
    // dropped the entire group here and spoke only the first marking — the
    // kunnari was never announced while the score jumped four runs.
    const emptyLookup = buildPlayerLookup({
      ...meta,
      home: team(100, "Ketut", []),
      away: team(200, "Sudet", []),
    });
    const subs = [scored(LYOJA, A), scored(LYOJA, B), scored(LYOJA, C), kunnari(LYOJA)];
    const text = groupToSpeech(liveEvent(subs), subs, [0, 1, 2, 3], meta, emptyLookup, true, ctx());
    expect(text).not.toBeNull();
    expect(text!.toLowerCase()).toContain("kunnari");
    expect(text).toContain("Neljä juoksua.");
  });

  it("does not name the same tuoja twice on a scorer double-marking", () => {
    // Double-markings are real and expected; the feed mirrors them. But
    // "tuojina Ilves ja Ilves" in one sentence reads as two people.
    const subs = [scored(LYOJA, A), scored(LYOJA, A)];
    const text = groupToSpeech(liveEvent(subs), subs, [0, 1], meta, lookup, true, ctx());
    expect(text!.match(/Ilves/g)).toHaveLength(1);
  });

  it("does not merge an id-keyed player with a number-keyed one", () => {
    // resolvePlayerName treats id and number as overlapping namespaces; a
    // grouping key may not, or one player's hit gets attributed to another.
    const byId = {
      texts: [
        { team: 100, type: "player", id: 12 },
        { type: "event", text: "löi juoksun, tuojana", base: null },
        { team: 100, type: "player", number: A.number },
        { type: "stat", score: 1 },
      ],
    } as unknown as SubEvent;
    const byNumber = {
      texts: [
        { team: 100, type: "player", number: 12 },
        { type: "event", text: "löi juoksun, tuojana", base: null },
        { team: 100, type: "player", number: B.number },
        { type: "stat", score: 1 },
      ],
    } as unknown as SubEvent;
    expect(groupSubEventsForSpeech([byId, byNumber])).toEqual([[0], [1]]);
  });
});
