/** Issue #158: a startup fetch must never be able to kill a live broadcast.
 *
 *  By the time `run()` executes, ffmpeg is already pushing picture to the
 *  commentated broadcast. Before this fix the first `fetchMatchMetadata()` had
 *  no try/catch: one timeout rejected the promise, `main().catch()` called
 *  `process.exit(1)`, and systemd's `Restart=on-failure` + `RestartSec=10` +
 *  `KillMode=control-group` took ffmpeg down with it — a ≥10 s black screen,
 *  looping for as long as the API stayed slow.
 *
 *  Fictional players only (public repo). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchMatchMetadata: vi.fn(), fetchLiveEvents: vi.fn() };
});

import { fetchLiveEvents, fetchMatchMetadata } from "@pesisselostaja/core";
import type { MatchMetadata } from "@pesisselostaja/core";
import { CommentaryLoop } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";
import { setLogSink } from "../src/log.js";

const metaMock = vi.mocked(fetchMatchMetadata);
const eventsMock = vi.mocked(fetchLiveEvents);

const META: MatchMetadata = {
  id: 900001,
  date: "2026-07-31",
  home: { id: 100, name: "Ketut", shorthand: "Ketut", players: [], all_players: [] },
  away: { id: 200, name: "Sudet", shorthand: "Sudet", players: [], all_players: [] },
  series: {},
  stadium: { name: "Testikenttä" },
  live: true,
  started: false,
};

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
    deltaFetch: true,
    pollTrace: false, announceBatterChanges: true, dryRun: true,
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
  startupFetch<T>(what: string, fn: () => Promise<T>, signal: AbortSignal): Promise<T | null>;
  run(): Promise<void>;
  stop(): void;
}

function makeLoop(): LoopInternals {
  return new CommentaryLoop(makeConfig(), async () => {}) as unknown as LoopInternals;
}

const codes: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  metaMock.mockReset();
  eventsMock.mockReset();
  codes.length = 0;
  setLogSink((entry) => {
    if (entry.code) codes.push(entry.code);
  });
});

afterEach(() => {
  setLogSink(null);
  vi.useRealTimers();
});

describe("startup fetch retry (#158)", () => {
  it("retries instead of rejecting, and says so in the log", async () => {
    const loop = makeLoop();
    const fn = vi
      .fn(async (): Promise<string> => "ok")
      .mockRejectedValueOnce(new Error("aikakatkaisu"))
      .mockRejectedValueOnce(new Error("aikakatkaisu"))
      .mockResolvedValue("ok");

    const promise = loop.startupFetch("Testihaku", fn, new AbortController().signal);
    await vi.runAllTimersAsync();

    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(codes).toContain("api.startup_fetch_failed");
    expect(codes).toContain("api.startup_fetch_recovered");
  });

  it("gives up only on abort, and then without throwing", async () => {
    const loop = makeLoop();
    const controller = new AbortController();
    const fn = vi.fn(async (): Promise<string> => "ok").mockRejectedValue(new Error("API on nurin"));

    const promise = loop.startupFetch("Testihaku", fn, controller.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn.mock.calls.length).toBeGreaterThan(1);

    controller.abort();
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
  });

  it("run() survives a failing startup metadata fetch — this is the live-broadcast killer", async () => {
    const loop = makeLoop();
    // The exact shape of the defect: the very first fetch times out.
    metaMock.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    metaMock.mockResolvedValue(META);
    eventsMock.mockResolvedValue({ events: [], team: null, period: null } as never);

    let rejected: unknown = null;
    const run = loop.run().catch((err: unknown) => {
      rejected = err;
    });
    // Enough virtual time to get past the first retry wait and into the poll loop.
    await vi.advanceTimersByTimeAsync(5_000);
    loop.stop();
    await vi.runAllTimersAsync();
    await run;

    expect(rejected).toBeNull();
    expect(metaMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("run() survives a failing startup history fetch too", async () => {
    const loop = makeLoop();
    metaMock.mockResolvedValue(META);
    eventsMock.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    eventsMock.mockResolvedValue({ events: [], team: null, period: null } as never);

    let rejected: unknown = null;
    const run = loop.run().catch((err: unknown) => {
      rejected = err;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    loop.stop();
    await vi.runAllTimersAsync();
    await run;

    expect(rejected).toBeNull();
    expect(eventsMock.mock.calls.length).toBeGreaterThan(1);
  });

  /** The retry window must not make the mixer think the match is over: a
   *  restored `finished: true` from the state file halves the give-up window
   *  (finishedFailureWindowMs), so a long retry could get the whole relay shut
   *  down — by the very mechanism added to protect it. */
  it("does not report matchFinished while the startup fetch is retrying", async () => {
    const loop = makeLoop();
    (loop as unknown as { state: { finished: boolean } }).state.finished = true;
    metaMock.mockRejectedValue(new Error("API on nurin"));

    const run = loop.run().catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect((loop as unknown as { matchFinished: boolean }).matchFinished).toBe(false);

    loop.stop();
    await vi.runAllTimersAsync();
    await run;
  });
});
