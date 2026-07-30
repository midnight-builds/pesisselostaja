/** Issue #90: the relay fetched the lineup exactly once, at startup.
 *
 *  `online/{id}/events` carries no names — only a jersey number and a team id —
 *  so every name comes from that one fetch. When the lineup is edited between
 *  the relay starting and the scorer opening the match, the whole broadcast is
 *  narrated with the wrong names while the scores, palot and turns stay
 *  perfectly right. Live on 28.7.2026 that got past everyone except a viewer
 *  who knew the players by sight.
 *
 *  These tests drive maybeRefreshRoster directly, the same way the delta tests
 *  drive the fetch internals. Fictional players only (public repo). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchMatchMetadata: vi.fn() };
});

import { buildPlayerLookup, fetchMatchMetadata } from "@pesisselostaja/core";
import type { MatchMetadata, Player, PlayerLookup, Team } from "@pesisselostaja/core";
import { CommentaryLoop } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";
import { setLogSink } from "../src/log.js";

const metaMock = vi.mocked(fetchMatchMetadata);

function player(id: number, number: number, last: string): Player {
  return { id, number, name: `Testi ${last}`, first_name: "Testi", last_name: last };
}

function team(id: number, shorthand: string, players: Player[]): Team {
  return { id, name: shorthand, shorthand, players, all_players: players.map((p) => p.id) };
}

function meta(home: Player[], away: Player[]): MatchMetadata {
  return {
    id: 900001,
    date: "2026-07-29",
    home: team(100, "Ketut", home),
    away: team(200, "Sudet", away),
    series: {},
    stadium: { name: "Testikenttä" },
    live: true,
    started: true,
  };
}

const EARLY = meta([player(11, 5, "Mäyrä")], []);
/** Same jersey number, different player — the case that produced #90. */
const FINAL = meta([player(12, 5, "Ilves")], [player(21, 3, "Karhu")]);

function makeConfig(): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    noSignalSlate: false, noSignalSlateAfterMs: 8000,
    noSignalSlateWidth: 1920, noSignalSlateHeight: 1080,
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, maxFailureWindowMs: 720000, finishedFailureWindowMs: 120000, hardStopQuietMs: 180000,
    deltaFetch: true, announceBatterChanges: true, dryRun: true,
    apiKey: "test", apiBase: "https://example.invalid/api",
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    runRetentionDays: 0,
    ttsCacheMaxBytes: 0,
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
  };
}

interface LoopInternals {
  maybeRefreshRoster(
    current: { meta: MatchMetadata; lookup: PlayerLookup },
    now?: number
  ): Promise<{ meta: MatchMetadata; lookup: PlayerLookup }>;
  matchStarted: boolean;
  rosterRefreshedAt: number;
  rosterSettled: boolean;
}

function makeLoop(): LoopInternals {
  return new CommentaryLoop(makeConfig(), async () => {}) as unknown as LoopInternals;
}

function snapshot(m: MatchMetadata) {
  return { meta: m, lookup: buildPlayerLookup(m) };
}

/** Name for jersey 5 of the home team — the thing the listener actually hears. */
function homeNumberFive(lookup: PlayerLookup): string | undefined {
  return lookup.byTeamNumber.get("100:5")?.last_name;
}

const codes: string[] = [];

beforeEach(() => {
  metaMock.mockReset();
  codes.length = 0;
  setLogSink((entry) => {
    if (entry.code) codes.push(entry.code);
  });
});

afterEach(() => setLogSink(null));

const MINUTE = 60_000;

describe("roster refresh", () => {
  it("picks up a lineup published after the relay started", async () => {
    const loop = makeLoop();
    loop.rosterRefreshedAt = 0;
    metaMock.mockResolvedValueOnce(FINAL);

    const before = snapshot(EARLY);
    expect(homeNumberFive(before.lookup)).toBe("Mäyrä");

    const after = await loop.maybeRefreshRoster(before, MINUTE);
    expect(homeNumberFive(after.lookup)).toBe("Ilves");
    // The operator has to see it: everything spoken before this may be wrong.
    expect(codes).toContain("api.roster_changed");
  });

  it("does not re-read on every poll — once a minute is the cadence", async () => {
    const loop = makeLoop();
    loop.rosterRefreshedAt = MINUTE;
    metaMock.mockResolvedValue(FINAL);

    await loop.maybeRefreshRoster(snapshot(EARLY), MINUTE + 3000);
    await loop.maybeRefreshRoster(snapshot(EARLY), MINUTE + 6000);
    expect(metaMock).not.toHaveBeenCalled();

    await loop.maybeRefreshRoster(snapshot(EARLY), MINUTE + MINUTE);
    expect(metaMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads immediately when the match opens, without waiting out the interval", async () => {
    // The moment the scorer opens the match is when the final lineup appears —
    // and it is also the last moment before names start being spoken.
    const loop = makeLoop();
    loop.rosterRefreshedAt = MINUTE;
    loop.matchStarted = true;
    metaMock.mockResolvedValueOnce(FINAL);

    const after = await loop.maybeRefreshRoster(snapshot(EARLY), MINUTE + 1000);
    expect(metaMock).toHaveBeenCalledTimes(1);
    expect(homeNumberFive(after.lookup)).toBe("Ilves");
  });

  it("stops refreshing once the match has started and both rosters carry players", async () => {
    const loop = makeLoop();
    loop.matchStarted = true;
    metaMock.mockResolvedValueOnce(FINAL);

    await loop.maybeRefreshRoster(snapshot(EARLY), MINUTE);
    expect(loop.rosterSettled).toBe(true);
    expect(codes).toContain("api.roster_settled");

    // Nothing more goes out to someone else's API for the rest of the match.
    await loop.maybeRefreshRoster(snapshot(FINAL), 10 * MINUTE);
    expect(metaMock).toHaveBeenCalledTimes(1);
  });

  it("keeps refreshing while a roster is still empty, even after the match started", async () => {
    // A published-but-empty away roster resolves no names at all; settling on
    // it would mean giving up on ever getting them.
    const loop = makeLoop();
    loop.matchStarted = true;
    metaMock.mockResolvedValueOnce(EARLY);

    await loop.maybeRefreshRoster(snapshot(EARLY), MINUTE);
    expect(loop.rosterSettled).toBe(false);

    metaMock.mockResolvedValueOnce(FINAL);
    const after = await loop.maybeRefreshRoster(snapshot(EARLY), 2 * MINUTE);
    expect(loop.rosterSettled).toBe(true);
    expect(homeNumberFive(after.lookup)).toBe("Ilves");
  });

  it("keeps the names it has when the refresh fails", async () => {
    const loop = makeLoop();
    metaMock.mockRejectedValueOnce(new Error("timeout"));

    const before = snapshot(EARLY);
    const after = await loop.maybeRefreshRoster(before, MINUTE);
    expect(after).toBe(before);
    expect(codes).toContain("api.roster_refresh_failed");
    expect(loop.rosterSettled).toBe(false);
  });

  it("says nothing when the lineup is unchanged", async () => {
    const loop = makeLoop();
    metaMock.mockResolvedValueOnce(FINAL);

    await loop.maybeRefreshRoster(snapshot(FINAL), MINUTE);
    expect(codes).not.toContain("api.roster_changed");
  });
});
