import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommentaryLoop, type NarrationStatus, type SpeechSink } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";
import type { MatchMetadata } from "@pesisselostaja/core";

// Fictional teams only — public repo (see feedback-fixtures-fictional-names).
const META: MatchMetadata = {
  id: 900001,
  date: "2026-07-16",
  home: { id: 1, name: "Testilä Tähdet", shorthand: "TTä", players: [], all_players: [] },
  away: { id: 2, name: "Esimerkki Eagles", shorthand: "EEa", players: [], all_players: [] },
  series: { name: "Testisarja" },
  stadium: { name: "Testikenttä" },
  live: true,
  started: false,
};

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "",
    streamKey: "",
    voice: "harri-medium",
    piperBin: "piper",
    pollInterval: 4000,
    narrationGain: 1.3,
    narrationDelayMs: 0,
    urlRefreshMs: 900000,
    maxFailureWindowMs: 720000,
    announceBatterChanges: true,
    dryRun: false,
    apiKey: "test",
    apiBase: "https://example.invalid/api",
    // Nonexistent paths → loaders fall back to defaults (see loadState /
    // loadPronunciations), so no fixtures on disk are needed.
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x",
    elevenLabsModelId: "y",
    ...overrides,
  };
}

/** Records each sink call with the wall-clock instant it fired, so tests can
 *  assert both order and timing of narration handoff. */
function recordingSink(): SpeechSink & { calls: { text: string; at: number }[] } {
  const calls: { text: string; at: number }[] = [];
  const sink = (async (_spoken: string, readable: string) => {
    calls.push({ text: readable, at: Date.now() });
  }) as SpeechSink & { calls: typeof calls };
  sink.calls = calls;
  return sink;
}

function status(attached: boolean, pending: number): NarrationStatus {
  return { isReaderAttached: () => attached, pendingClips: () => pending };
}

/** The behaviors under test (filler gating, delayed handoff) live on private
 *  members; this typed view exposes just what the tests touch, so no `any`
 *  casts are needed. */
interface LoopInternals {
  narrationReadyForFiller(): boolean;
  maybeAnnounceSummary(meta: MatchMetadata): Promise<void>;
  speak(text: string, countAnnouncement?: boolean, dedupeKey?: string): void;
  synthQueue: Promise<void>;
  state: { announcementCount: number };
  lastSpeech: string | null;
}

function internals(loop: CommentaryLoop): LoopInternals {
  return loop as unknown as LoopInternals;
}

describe("CommentaryLoop pre-game filler gating (HANDOFF.md 7)", () => {
  it("is not ready while ffmpeg is unattached, or while clips are still queued", () => {
    const notAttached = internals(new CommentaryLoop(makeConfig(), recordingSink(), status(false, 0)));
    expect(notAttached.narrationReadyForFiller()).toBe(false);

    const attachedButBusy = internals(new CommentaryLoop(makeConfig(), recordingSink(), status(true, 2)));
    expect(attachedButBusy.narrationReadyForFiller()).toBe(false);

    const ready = internals(new CommentaryLoop(makeConfig(), recordingSink(), status(true, 0)));
    expect(ready.narrationReadyForFiller()).toBe(true);
  });

  it("treats narration as always ready when no status port is supplied (dry-run/tests)", () => {
    const loop = internals(new CommentaryLoop(makeConfig(), recordingSink()));
    expect(loop.narrationReadyForFiller()).toBe(true);
  });

  it("skips synthesizing the pre-game welcome filler until ffmpeg is attached and the queue empty", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig(), sink, status(false, 0)));

    // Pre-game (matchStarted defaults false), silence long enough that only the
    // readiness gate can block the filler.
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
  });

  it("synthesizes the pre-game welcome filler once ffmpeg is attached and the queue empty", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig(), sink, status(true, 0)));

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);
  });

  it("still queues genuine event narration even when ffmpeg is unattached (only fillers are gated)", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig(), sink, status(false, 0)));

    // speak() is the shared path for event narration; it must never consult the
    // filler gate.
    loop.speak("Palo! Ensimmäinen palo.");
    await loop.synthQueue;
    expect(sink.calls.map((c) => c.text)).toEqual(["Palo! Ensimmäinen palo."]);
  });
});

describe("CommentaryLoop narration delay (HANDOFF.md 8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0); // pin the fake clock so `at` timings are relative to 0
  });
  afterEach(() => vi.useRealTimers());

  it("delays the sink handoff by the configured amount without blocking the caller", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 4000 }), sink, status(true, 0)));

    loop.speak("Juoksu!");
    // Let the queued microtask arm the timer.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3999);
    expect(sink.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].at).toBe(4000);
  });

  it("does the dedupe/state bookkeeping synchronously, before any delay elapses", () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 5000 }), sink, status(true, 0)));

    expect(loop.state.announcementCount).toBe(0);
    loop.speak("Juoksu!"); // counts as an announcement
    // No timers advanced yet: sink hasn't fired, but bookkeeping already has.
    expect(sink.calls).toHaveLength(0);
    expect(loop.state.announcementCount).toBe(1);
    expect(loop.lastSpeech).toBe("Juoksu!");
  });

  it("measures the delay from each clip's decision time (a floor, not a per-clip cumulative wait) and preserves order", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 1000 }), sink, status(true, 0)));

    // Two clips decided in the same instant.
    loop.speak("Ensimmäinen");
    loop.speak("Toinen");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    // Both land at t=1000 in decision order — the second is NOT pushed to 2000,
    // which is what a cumulative per-clip delay would do.
    expect(sink.calls.map((c) => c.text)).toEqual(["Ensimmäinen", "Toinen"]);
    expect(sink.calls.map((c) => c.at)).toEqual([1000, 1000]);
  });

  it("applies no wait when the delay is 0 (default behavior unchanged)", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 0 }), sink, status(true, 0)));

    loop.speak("Heti");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].at).toBe(0);
  });
});
