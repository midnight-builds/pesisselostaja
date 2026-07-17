import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";

// Mock ONLY the network call; everything else (speech helpers, state,
// formatHelsinkiTimestamp) stays real.
vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchLiveEvents: vi.fn() };
});

import { fetchLiveEvents, formatHelsinkiTimestamp } from "@pesisselostaja/core";
import type { LiveEvent, LiveEventsResult, SubEvent } from "@pesisselostaja/core";
import { CommentaryLoop } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";
import type { EventHistory } from "../src/eventHistory.js";

const fetchMock = vi.mocked(fetchLiveEvents);

// Fictional data only (public repo).
function ev(overrides: Partial<LiveEvent> = {}, subs: SubEvent[] = []): LiveEvent {
  return {
    id: 1, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: subs, timestamp: 10, updated: null,
    ...overrides,
  };
}
const palo: SubEvent = { texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }] };
const run: SubEvent = { texts: [{ type: "stat", score: 1 }] };

const T0 = Date.parse("2026-07-17T08:00:00Z");

function result(events: LiveEvent[], extra: Partial<LiveEventsResult> = {}): LiveEventsResult {
  return { events, notModified: false, etag: 'W/"tag"', serverDateMs: T0, ...extra };
}

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, maxFailureWindowMs: 720000, finishedFailureWindowMs: 120000,
    deltaFetch: true, announceBatterChanges: true, dryRun: false,
    apiKey: "test", apiBase: "https://example.invalid/api",
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
    ...overrides,
  };
}

/** Typed view of the private members these tests drive directly. */
interface LoopInternals {
  fetchFullEvents(): Promise<LiveEventsResult>;
  fetchEventsForPoll(): Promise<LiveEventsResult | null>;
  refreshRuntimeControls(): Promise<void>;
  history: EventHistory;
  lastServerDateMs: number | null;
  lastFullFetchAt: number;
  deltaFetch: boolean;
  pollIntervalMs: number;
  narrationDelayMs: number;
}

function makeLoop(overrides: Partial<RelayConfig> = {}): LoopInternals {
  const loop = new CommentaryLoop(makeConfig(overrides), async () => {});
  return loop as unknown as LoopInternals;
}

beforeEach(() => fetchMock.mockReset());

describe("CommentaryLoop delta polling (HANDOFF.md 15.7. kohta 6)", () => {
  it("full fetch replaces the history and re-bases the delta cursor", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();
    expect(loop.history.events.map((e) => e.id)).toEqual([1]);
    expect(loop.lastServerDateMs).toBe(T0);
  });

  it("delta poll asks with after = last Date header minus the safety margin, merges, and processing sees the FULL history", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    fetchMock.mockResolvedValueOnce(result([ev({ id: 2 }, [run])], { serverDateMs: T0 + 3000 }));
    const res = await loop.fetchEventsForPoll();

    expect(res).not.toBeNull();
    const opts = fetchMock.mock.calls[1][1] as { after?: string; skipDelay?: boolean };
    expect(opts.skipDelay).toBe(true);
    expect(opts.after).toBe(formatHelsinkiTimestamp(new Date(T0 - 180 * 1000)));
    // The merged history — what processEventsLive actually runs on — holds both.
    expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("keeps the after URL stable through a quiet stretch and turns its ETag into a 304 skip", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    // Quiet 200: nothing new → cursor + etag stored for this exact after URL.
    fetchMock.mockResolvedValueOnce(result([], { etag: 'W/"quiet"' }));
    await loop.fetchEventsForPoll();

    // Next poll sends If-None-Match for the same after; server says 304.
    fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"quiet"', serverDateMs: T0 + 6000 });
    const res = await loop.fetchEventsForPoll();

    expect(res).toBeNull(); // 304 → skip event processing entirely
    const secondOpts = fetchMock.mock.calls[1][1] as { after?: string; etag?: string };
    const thirdOpts = fetchMock.mock.calls[2][1] as { after?: string; etag?: string };
    expect(thirdOpts.after).toBe(secondOpts.after); // URL did not move
    expect(thirdOpts.etag).toBe('W/"quiet"');
  });

  it("falls back to an immediate full fetch in the same poll when the server sets the reset flag", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    fetchMock.mockResolvedValueOnce(result([ev({ id: 99 })], { reset: true }));
    fetchMock.mockResolvedValueOnce(result([ev({ id: 5 }), ev({ id: 6 })]));
    await loop.fetchEventsForPoll();

    expect(fetchMock).toHaveBeenCalledTimes(3); // delta + fallback full, same poll
    const fallbackOpts = fetchMock.mock.calls[2][1] as { after?: string };
    expect(fallbackOpts.after).toBeUndefined();
    expect(loop.history.events.map((e) => e.id)).toEqual([5, 6]); // rebuilt, not merged
  });

  it("falls back to a full fetch when a delta shrinks an event's sub-event list (inconsistent)", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo, run])]));
    await loop.fetchFullEvents();

    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])])); // shrunk!
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo, run]), ev({ id: 2 })]));
    await loop.fetchEventsForPoll();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("does a periodic full resync that replaces the merged history", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    loop.lastFullFetchAt = Date.now() - 61_000; // resync due
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo]), ev({ id: 2 })]));
    await loop.fetchEventsForPoll();

    const opts = fetchMock.mock.calls[1][1] as { after?: string };
    expect(opts.after).toBeUndefined(); // a genuine full fetch
    expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("deltaFetch=false reverts to plain full fetches", async () => {
    const loop = makeLoop({ deltaFetch: false });
    fetchMock.mockResolvedValue(result([ev({ id: 1 })]));
    await loop.fetchEventsForPoll();
    await loop.fetchEventsForPoll();
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as { after?: string }).after).toBeUndefined();
    }
  });
});

describe("CommentaryLoop runtime controls: deltaFetch + pollIntervalMs", () => {
  const controlFile = "/tmp/pesis-test-control-runtime.json";
  afterEach(() => rmSync(controlFile, { force: true }));

  it("flips deltaFetch and pollIntervalMs live from the control file", async () => {
    const loop = makeLoop({ controlFile });
    expect(loop.deltaFetch).toBe(true);
    expect(loop.pollIntervalMs).toBe(3000);

    writeFileSync(controlFile, JSON.stringify({ deltaFetch: false, pollIntervalMs: 5000 }));
    await loop.refreshRuntimeControls();
    expect(loop.deltaFetch).toBe(false);
    expect(loop.pollIntervalMs).toBe(5000);

    writeFileSync(controlFile, JSON.stringify({ deltaFetch: true }));
    await loop.refreshRuntimeControls();
    expect(loop.deltaFetch).toBe(true);
    expect(loop.pollIntervalMs).toBe(5000); // omitted key leaves the setting alone
  });

  it("clamps pollIntervalMs to the 2000 ms floor", async () => {
    const loop = makeLoop({ controlFile });
    writeFileSync(controlFile, JSON.stringify({ pollIntervalMs: 500 }));
    await loop.refreshRuntimeControls();
    expect(loop.pollIntervalMs).toBe(2000);
  });
});
