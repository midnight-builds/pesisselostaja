import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ONLY the network call, like commentaryLoopDelta.test.ts does.
vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchLiveEvents: vi.fn() };
});

import { fetchLiveEvents, formatHelsinkiTimestamp } from "@pesisselostaja/core";
import type { LiveEvent, LiveEventsResult } from "@pesisselostaja/core";
import { CommentaryLoop, p95 } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";

const fetchMock = vi.mocked(fetchLiveEvents);

/** Issue #303: kiinteä 2 s delta-timeout abortoi ~11 % polleista (6.9.2026,
 *  ajot 135689 + 135680), vaikka onnistuneet deltat mitattiin max 1805 ms:iin
 *  — ja saman illan reset-ryöpyt pudottivat kursorin täyshakukierteeseen
 *  koko AFTER_MARGIN_MS:n ajaksi. Nämä testit lukitsevat molemmat korjaukset:
 *  timeout avautuu mitatusta kestosta, ja reset nostaa kursorin lattian
 *  leimansa yli niin että ryöppy päättyy ensimmäiseen resettiin. */

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, maxQueuedNarrationMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, ytdlpExtractorArgs: "", maxFailureWindowMs: 720000, finishedFailureWindowMs: 120000, hardStopQuietMs: 180000, drainMaxMs: 0,
    noSignalSlate: false, noSignalSlateAfterMs: 8000,
    noSignalSlateWidth: 1920, noSignalSlateHeight: 1080,
    deltaFetch: true,
    pollTrace: false, announceBatterChanges: true, dryRun: false,
    apiKey: "test", apiBase: "https://example.invalid/api",
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    runRetentionDays: 0,
    ttsCacheMaxBytes: 0,
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
    ...overrides,
  };
}

interface LoopInternals {
  fetchFullEvents(): Promise<LiveEventsResult>;
  fetchEventsForPoll(): Promise<LiveEventsResult | null>;
  apiTimeoutMs(size: "delta" | "meta" | "full"): number;
  recentDeltaMs: number[];
  slowDeltaDwellPolls: number;
  consecutiveFetchFailures: number;
  lastServerDateMs: number | null;
  lastFullFetchAt: number;
  resetFloorMs: number | null;
  history: { size: number };
}

function makeLoop(overrides: Partial<RelayConfig> = {}): LoopInternals {
  return new CommentaryLoop(makeConfig(overrides), async () => {}) as unknown as LoopInternals;
}

// Fictional data only (public repo).
function ev(id: number): LiveEvent {
  return {
    id, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: [], timestamp: 10, updated: null,
  };
}

const T0 = Date.parse("2026-09-06T10:00:00Z");

function result(events: LiveEvent[], extra: Partial<LiveEventsResult> = {}): LiveEventsResult {
  return { events, notModified: false, etag: null, serverDateMs: T0, ...extra };
}

beforeEach(() => fetchMock.mockReset());

describe("adaptiivinen delta-timeout (#303)", () => {
  it("pysyy 2 s:ssa kun API vastaa nopeasti — venttiili voi vain löysätä", () => {
    const loop = makeLoop();
    loop.recentDeltaMs.push(...Array.from({ length: 50 }, () => 80));
    expect(loop.apiTimeoutMs("delta")).toBe(2000);
  });

  it("avautuu mitatusta kestosta: 1.8 s onnistumiset nostavat rajan p95 × 2:een", () => {
    // Juuri 6.9.2026 mitattu tilanne: onnistuneet deltat max 1805 ms, ja
    // kiinteä 2 s raja abortoi häntäviipeet. Tämän testin PITÄÄ kaatua
    // kiinteällä DELTA_FETCH_TIMEOUT_MS = 2000 -toteutuksella.
    const loop = makeLoop();
    loop.recentDeltaMs.push(...Array.from({ length: 50 }, () => 1800));
    expect(loop.apiTimeoutMs("delta")).toBe(3600);
  });

  it("katto on 5 s: vaihtelevat 0.1–4 s kestot eivät nosta rajaa yli, mutta raja ylittää maksimikeston", () => {
    // Issuen #303 hyväksymiskriteeri: kun vasteajat vaihtelevat 0.1–4 s,
    // hakuvirheosuuden pitää jäädä ~0 %:iin — eli rajan on ylitettävä
    // suurin mitattu kesto — ilman että aidosti jumittunut yhteys jää
    // roikkumaan (raja pysyy äärellisenä katossa).
    const loop = makeLoop();
    const latencies = Array.from({ length: 100 }, (_, i) => 100 + Math.round((i / 99) * 3900));
    loop.recentDeltaMs.push(...latencies);
    const timeout = loop.apiTimeoutMs("delta");
    expect(timeout).toBe(5000);
    expect(timeout).toBeGreaterThan(Math.max(...latencies));
  });

  it("yksittäinen poikkeama ei raahaa rajaa: p95, ei max", () => {
    const loop = makeLoop();
    loop.recentDeltaMs.push(...Array.from({ length: 99 }, () => 80), 4000);
    expect(loop.apiTimeoutMs("delta")).toBe(2000);
  });

  it("virhesarjaventtiili säilyy pohjalla: nopea otos + avoin dwell antaa yhä 4 s", () => {
    const loop = makeLoop();
    loop.recentDeltaMs.push(...Array.from({ length: 50 }, () => 80));
    loop.slowDeltaDwellPolls = 5;
    expect(loop.apiTimeoutMs("delta")).toBe(4000);
  });

  it("otos on rullaava: hidas ilta unohtuu kun API tervehtyy", async () => {
    const loop = makeLoop();
    // 100 hidasta kestoa, sitten 100 nopeaa timedFetchin kautta — vanhat
    // poistuvat otoksesta (DELTA_ADAPTIVE_SAMPLE_SIZE = 100).
    loop.recentDeltaMs.push(...Array.from({ length: 100 }, () => 1800));
    const timed = loop as unknown as { timedFetch<T>(size: string, fetch: () => Promise<T>): Promise<T> };
    for (let i = 0; i < 100; i++) await timed.timedFetch("delta", async () => null);
    expect(loop.recentDeltaMs).toHaveLength(100);
    expect(loop.apiTimeoutMs("delta")).toBe(2000);
  });

  it("p95 tyhjästä otoksesta on 0", () => {
    expect(p95([])).toBe(0);
  });
});

describe("reset-lattia (#303)", () => {
  /** Ajaa yhden pollin, jonka delta-vastaus on reset leimalla `resetAtIso`,
   *  ja palauttaa seuraavan pollin fetchLiveEventsille antaman `after`-arvon. */
  async function pollResetThenNext(resetAtIso: string): Promise<{ loop: LoopInternals; nextAfter: string | undefined }> {
    const loop = makeLoop();
    const events = [ev(1), ev(2)];
    // Siemennä historia + kursoripohja aidolla täyshaulla.
    fetchMock.mockResolvedValueOnce(result(events));
    await loop.fetchFullEvents();
    loop.lastFullFetchAt = Date.now(); // estä 60 s resyncin täyshaku
    // Polli 1: delta vastaa resetillä (sama historia, ettei lyhyempi
    // vastaus laukaise varmistustäyshakua).
    fetchMock.mockResolvedValueOnce(result(events, { reset: resetAtIso }));
    await loop.fetchEventsForPoll();
    loop.lastFullFetchAt = Date.now();
    // Polli 2: normaali delta — kiinnostaa vain millä after-arvolla se lähti.
    fetchMock.mockResolvedValueOnce(result(events));
    await loop.fetchEventsForPoll();
    const nextAfter = (fetchMock.mock.calls.at(-1)?.[1] as { after?: string } | undefined)?.after;
    return { loop, nextAfter };
  }

  it("selitetty reset nostaa kursorin lattian leiman yli — ryöppy päättyy ensimmäiseen resettiin", async () => {
    // Leima uudempi kuin after (T0 - 180 s): ottelun alun / kesken ottelun
    // resetoinnin tapaus, joka livenä 6.9.2026 jätti kursorin
    // täyshakukierteeseen useiksi ikkunoiksi.
    const resetAt = new Date(T0 - 60_000);
    const { loop, nextAfter } = await pollResetThenNext(resetAt.toISOString());
    expect(loop.resetFloorMs).toBe(resetAt.getTime() + 1000);
    // Seuraava delta ei enää osu leiman alle: after >= reset-hetki + 1 s.
    expect(nextAfter).toBe(formatHelsinkiTimestamp(new Date(resetAt.getTime() + 1000)));
  });

  it("selittämätön reset EI nosta lattiaa — katkaisija hoitaa sen tapauksen", async () => {
    // Leima vanhempi kuin after: palvelin resetoi syystä jota emme näe.
    // Lattian nostaminen tässä peittäisi katkaisijan mittaaman oireen.
    const { loop } = await pollResetThenNext(new Date(T0 - 300_000).toISOString());
    expect(loop.resetFloorMs).toBeNull();
  });
});
