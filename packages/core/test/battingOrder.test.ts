/** Issue #241: `Player.number` is the batting-order slot at fetch time, not a
 *  jersey number — and `/public/match` never follows in-match changes to it.
 *
 *  Two things went wrong live on 5.8.2026 (match 136765, two `substitution`
 *  events reordering slots 7–11):
 *
 *  1. The feed line announcing the new order printed every player's OLD slot.
 *  2. The code called the slot a jersey number and assumed it stops moving once
 *     the match starts, so `rosterSettled` froze a table that was about to be
 *     wrong. The operator confirmed 6.8.2026 that a team can reorder mid-
 *     vuoropari, not just at a jakso break.
 *
 *  Fictional names only (public repo). */

import { describe, it, expect } from "vitest";
import {
  buildPlayerLookup,
  collectLineupChanges,
  withLineup,
  withLineups,
  slotOfPlayer,
  subEventFeedDetail,
  subEventToSpeech,
} from "../src/speech.js";
import type { LiveEvent, MatchMetadata, Player, SubEvent, Team } from "../src/types.js";

const HOME = 100;
const AWAY = 200;

/** `number` mirrors the API: 1..N in `players` order (verified across four
 *  rosters from two matches), i.e. the slot at fetch time. */
function roster(startId: number, ...names: string[]): Player[] {
  return names.map((last, i) => ({
    id: startId + i,
    number: i + 1,
    name: `Testi ${last}`,
    first_name: "Testi",
    last_name: last,
  }));
}

function team(id: number, shorthand: string, players: Player[]): Team {
  return { id, name: shorthand, shorthand, players, all_players: players.map((p) => p.id) };
}

const HOME_PLAYERS = roster(11, "Aho", "Ilves", "Kettu", "Mäyrä");
const meta: MatchMetadata = {
  id: 1,
  date: "2026-08-05",
  home: team(HOME, "Ketut", HOME_PLAYERS),
  away: team(AWAY, "Sudet", roster(21, "Susi", "Karhu")),
  series: {},
  stadium: { name: "Testikenttä" },
  live: true,
  started: true,
};

/** Aho 11, Ilves 12, Kettu 13, Mäyrä 14 — the pre-match order. */
const [AHO, ILVES, KETTU, MAYRA] = HOME_PLAYERS as [Player, Player, Player, Player];

function substitutionSub(teamId: number, ids: (string | number | null)[], pitcher?: number): SubEvent {
  return {
    texts: [
      { type: "team", id: teamId },
      { type: "event", text: "muutti lyöntijärjestystä." },
      { type: "substitution", team: teamId, newLineUp: ids as string[], ...(pitcher != null ? { pitcher } : {}) },
    ],
  } as unknown as SubEvent;
}

function liveEvent(subs: SubEvent[]): LiveEvent {
  return {
    id: 1, groupType: "x", period: 0, inning: 0, batTurn: 0, team: HOME, hTeam: HOME,
    batter: null, pairIndex: null, hitNumber: null, hit: null, events: subs, timestamp: null,
  };
}

describe("buildPlayerLookup: slots come from the order, not the field", () => {
  it("numbers the batting order 1..N by position in `players`", () => {
    const lookup = buildPlayerLookup(meta);
    expect(lookup.byTeamSlot.get(`${HOME}:1`)?.last_name).toBe("Aho");
    expect(lookup.byTeamSlot.get(`${HOME}:4`)?.last_name).toBe("Mäyrä");
    expect(slotOfPlayer(lookup, HOME, ILVES.id)).toBe(2);
  });

  it("keeps the two teams' slots apart", () => {
    const lookup = buildPlayerLookup(meta);
    expect(lookup.byTeamSlot.get(`${AWAY}:1`)?.last_name).toBe("Susi");
    expect(slotOfPlayer(lookup, AWAY, AHO.id)).toBeNull();
  });
});

describe("withLineup: the event stream is the only live source", () => {
  it("moves a player to the slot the new order gives them", () => {
    const before = buildPlayerLookup(meta);
    expect(slotOfPlayer(before, HOME, MAYRA.id)).toBe(4);

    const after = withLineup(before, HOME, [MAYRA.id, AHO.id, ILVES.id, KETTU.id]);
    expect(slotOfPlayer(after, HOME, MAYRA.id)).toBe(1);
    expect(after.byTeamSlot.get(`${HOME}:1`)?.last_name).toBe("Mäyrä");
    expect(after.byTeamSlot.get(`${HOME}:2`)?.last_name).toBe("Aho");
  });

  it("does not mutate the lookup it was given", () => {
    const before = buildPlayerLookup(meta);
    withLineup(before, HOME, [MAYRA.id, AHO.id]);
    expect(slotOfPlayer(before, HOME, MAYRA.id)).toBe(4);
  });

  it("leaves the other team alone", () => {
    const after = withLineup(buildPlayerLookup(meta), HOME, [MAYRA.id, AHO.id, ILVES.id, KETTU.id]);
    expect(after.byTeamSlot.get(`${AWAY}:1`)?.last_name).toBe("Susi");
    expect(after.byTeamSlot.get(`${AWAY}:2`)?.last_name).toBe("Karhu");
  });

  it("drops the tail when the new order is shorter — a vacated slot must not still resolve", () => {
    const after = withLineup(buildPlayerLookup(meta), HOME, [AHO.id, ILVES.id]);
    expect(after.byTeamSlot.get(`${HOME}:4`)).toBeUndefined();
    expect(slotOfPlayer(after, HOME, MAYRA.id)).toBeNull();
  });

  it("keeps the order right around a player it cannot name (jokeri)", () => {
    // 33189 is in `all_players` but not in `players`, so no name exists for it
    // anywhere in the metadata — the players AFTER it must still land right.
    const after = withLineup(buildPlayerLookup(meta), HOME, [AHO.id, 33189, ILVES.id]);
    expect(slotOfPlayer(after, HOME, ILVES.id)).toBe(3);
    expect(slotOfPlayer(after, HOME, 33189)).toBe(2);
    expect(after.byTeamSlot.get(`${HOME}:2`)).toBeUndefined();
  });

  it("ignores an empty lineup rather than wiping the order it has", () => {
    const before = buildPlayerLookup(meta);
    expect(withLineup(before, HOME, [])).toBe(before);
    expect(withLineup(before, HOME, undefined)).toBe(before);
  });
});

describe("collectLineupChanges", () => {
  it("keeps only the newest order per team", () => {
    const changes = collectLineupChanges([
      liveEvent([substitutionSub(HOME, [AHO.id, ILVES.id])]),
      liveEvent([substitutionSub(HOME, [ILVES.id, AHO.id])]),
      liveEvent([substitutionSub(AWAY, [22, 21])]),
    ]);
    expect(changes.size).toBe(2);
    expect(changes.get(HOME)).toEqual([ILVES.id, AHO.id]);
    expect(changes.get(AWAY)).toEqual([22, 21]);
  });

  it("ignores a substitution with no team or no usable lineup", () => {
    const changes = collectLineupChanges([
      liveEvent([{ texts: [{ type: "substitution", newLineUp: ["11"] }] } as unknown as SubEvent]),
      liveEvent([substitutionSub(HOME, [null, ""])]),
    ]);
    expect(changes.size).toBe(0);
  });

  it("accumulates across polls into the caller's map", () => {
    const changes = new Map<number, (string | number | null)[]>();
    collectLineupChanges([liveEvent([substitutionSub(HOME, [AHO.id, ILVES.id])])], changes);
    collectLineupChanges([liveEvent([substitutionSub(AWAY, [22, 21])])], changes);
    expect([...changes.keys()].sort()).toEqual([HOME, AWAY]);
  });
});

describe("the feed line that announces the change (the live bug)", () => {
  it("prints each player's NEW slot, not the one they are moving away from", () => {
    // This is the exact failure seen twice on 5.8.2026: the line saying
    // "here is the new order" listed everyone by their old position.
    const detail = subEventFeedDetail(
      substitutionSub(HOME, [MAYRA.id, KETTU.id, ILVES.id, AHO.id]),
      buildPlayerLookup(meta)
    );
    expect(detail).toBe("Uusi lyöntijärjestys: 1 Mäyrä, 2 Kettu, 3 Ilves, 4 Aho.");
    // The old slots must appear nowhere: Mäyrä was 4, Aho was 1.
    expect(detail).not.toMatch(/4 Mäyrä|1 Aho/);
  });

  it("gives the pitcher the slot the same element assigns them", () => {
    const detail = subEventFeedDetail(
      substitutionSub(HOME, [MAYRA.id, AHO.id], AHO.id),
      buildPlayerLookup(meta)
    );
    expect(detail).toBe("Uusi lyöntijärjestys: 1 Mäyrä, 2 Aho. Lukkarina 2 Aho.");
  });

  it("falls back to the player's tracked slot when the pitcher is not in the new order", () => {
    const lookup = buildPlayerLookup(meta);
    const detail = subEventFeedDetail(substitutionSub(HOME, [MAYRA.id, AHO.id], KETTU.id), lookup);
    expect(detail).toBe("Uusi lyöntijärjestys: 1 Mäyrä, 2 Aho. Lukkarina 3 Kettu.");
  });
});

describe("after the change: slot-addressed events resolve to the new occupant", () => {
  /** The API's `{type:"player", number, team}` form is addressed by slot. With
   *  a table frozen at the pre-match order it names whoever USED to bat there. */
  function batterSub(teamId: number, slot: number): SubEvent {
    return {
      texts: [
        { team: teamId, type: "player", number: slot, role: "batter" },
        { type: "event", text: "on vuorossa." },
      ],
    } as unknown as SubEvent;
  }

  it("names the player who now bats in that slot", () => {
    const lookup = withLineups(
      buildPlayerLookup(meta),
      collectLineupChanges([liveEvent([substitutionSub(HOME, [MAYRA.id, AHO.id, ILVES.id, KETTU.id])])])
    );
    const sub = batterSub(HOME, 1);
    const spoken = subEventToSpeech(liveEvent([sub]), sub, meta, lookup);
    expect(spoken).toContain("Mäyrä");
    expect(spoken).not.toContain("Aho");
  });

  it("replays onto a lookup rebuilt from freshly fetched metadata", () => {
    // maybeRefreshRoster rebuilds from `/public/match`, which still returns the
    // PRE-match order even after the match has ended — verified against match
    // 136765. A plain rebuild would therefore undo every in-match change.
    const changes = collectLineupChanges([
      liveEvent([substitutionSub(HOME, [MAYRA.id, AHO.id, ILVES.id, KETTU.id])]),
    ]);
    const rebuilt = withLineups(buildPlayerLookup(meta), changes);
    expect(rebuilt.byTeamSlot.get(`${HOME}:1`)?.last_name).toBe("Mäyrä");
  });

  it("is idempotent — the full history is re-read every poll", () => {
    const changes = collectLineupChanges([
      liveEvent([substitutionSub(HOME, [MAYRA.id, AHO.id, ILVES.id, KETTU.id])]),
    ]);
    const once = withLineups(buildPlayerLookup(meta), changes);
    const twice = withLineups(once, changes);
    expect([...twice.slotOf.entries()].sort()).toEqual([...once.slotOf.entries()].sort());
  });
});
