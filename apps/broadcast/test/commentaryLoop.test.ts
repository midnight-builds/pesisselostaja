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
    firstSpeechDelayMs: 0, // most tests exercise gating/latching without the start-up grace
    urlRefreshMs: 900000,
    maxFailureWindowMs: 720000,
    finishedFailureWindowMs: 120000,
    deltaFetch: true,
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

/** Mutable stand-in for FfmpegMixer's attach/queue state, so a test can flip
 *  attachment mid-test the way a real ffmpeg connect/exit would. firstAt
 *  defaults to 0 (= "first attach long ago"), so tests not about the
 *  first-speech grace never trip it. */
function mutableStatus(attached = false, pending = 0, firstAt: number | null = 0) {
  const s = { attached, pending, firstAt };
  const port: NarrationStatus = {
    isReaderAttached: () => s.attached,
    pendingClips: () => s.pending,
    firstAttachedAt: () => s.firstAt,
  };
  return { s, port };
}

/** The behaviors under test (filler gating, first-attach latch, delayed
 *  handoff) live on private members; this typed view exposes just what the
 *  tests touch, so no `any` casts are needed. */
interface LoopInternals {
  narrationReadyForFiller(): boolean;
  maybeLatchNarrationReady(meta: MatchMetadata): void;
  maybeAnnounceSummary(meta: MatchMetadata): Promise<void>;
  speak(text: string, countAnnouncement?: boolean, dedupeKey?: string): void;
  synthQueue: Promise<void>;
  state: { announcementCount: number; finished: boolean };
  matchStarted: boolean;
  lastSpeech: string | null;
  lastSpeechAt: number;
  lastSummaryCount: number;
  narrationEverReady: boolean;
}

function internals(loop: CommentaryLoop): LoopInternals {
  return loop as unknown as LoopInternals;
}

/** A loop whose first-attach latch has already fired, mirroring the poll
 *  loop's per-cycle maybeLatchNarrationReady call — the state most gating
 *  tests want as their baseline. */
function latchedLoop(sink: SpeechSink, s: { attached: boolean; pending: number }, port: NarrationStatus, config = makeConfig()) {
  const wasAttached = s.attached;
  s.attached = true;
  const loop = internals(new CommentaryLoop(config, sink, port));
  loop.maybeLatchNarrationReady(META);
  s.attached = wasAttached;
  return loop;
}

describe("CommentaryLoop pre-game filler gating (HANDOFF.md 7)", () => {
  it("is not ready while ffmpeg is unattached, unlatched, or while clips are still queued", () => {
    const a = mutableStatus(false, 0);
    expect(internals(new CommentaryLoop(makeConfig(), recordingSink(), a.port)).narrationReadyForFiller()).toBe(false);

    const b = mutableStatus(true, 2);
    const busy = internals(new CommentaryLoop(makeConfig(), recordingSink(), b.port));
    busy.maybeLatchNarrationReady(META);
    expect(busy.narrationReadyForFiller()).toBe(false);

    const c = mutableStatus(true, 0);
    const fresh = internals(new CommentaryLoop(makeConfig(), recordingSink(), c.port));
    // Before the latch even an attached, idle pipeline is not "ready" — a
    // filler would only be suppressed while burning its bookkeeping.
    expect(fresh.narrationReadyForFiller()).toBe(false);
    fresh.maybeLatchNarrationReady(META);
    expect(fresh.narrationReadyForFiller()).toBe(true);
  });

  it("treats narration as always ready when no status port is supplied (dry-run/tests)", () => {
    const loop = internals(new CommentaryLoop(makeConfig(), recordingSink()));
    expect(loop.narrationReadyForFiller()).toBe(true);
    expect(loop.narrationEverReady).toBe(true);
  });

  it("skips synthesizing the pre-game welcome filler until ffmpeg is attached and the queue empty", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));

    // Pre-game (matchStarted defaults false), silence long enough that only the
    // readiness gate can block the filler.
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
  });

  it("synthesizes the pre-game welcome filler once ffmpeg is attached and the queue empty", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(true, 0);
    const loop = latchedLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);
  });
});

describe("CommentaryLoop in-game filler gating (HANDOFF.md 7, extension)", () => {
  function inGameLoop(sink: SpeechSink, s: { attached: boolean; pending: number }, port: NarrationStatus) {
    const loop = latchedLoop(sink, s, port);
    loop.matchStarted = true;
    loop.state.announcementCount = 1; // countDue stays false; idleDue drives the filler
    // lastSpeechAt stays 0 → far past IDLE_FILLER_MS, so idleDue is true.
    return loop;
  }

  it("skips the recap/idle filler while ffmpeg is detached, WITHOUT advancing the summary bookkeeping", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = inGameLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
    // Bookkeeping untouched → the first ready poll still sees the filler as due.
    expect(loop.lastSummaryCount).toBe(0);
    expect(loop.lastSpeechAt).toBe(0);
  });

  it("skips the filler while queued clips are still draining (attached but busy)", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(true, 3);
    const loop = inGameLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
    expect(loop.lastSpeechAt).toBe(0);
  });

  it("speaks a fresh filler on the first ready poll after a skipped round", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = inGameLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META); // skipped: detached
    s.attached = true;
    await loop.maybeAnnounceSummary(META); // gate open → speaks now
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);
    expect(loop.lastSpeechAt).toBeGreaterThan(0);
  });
});

describe("CommentaryLoop pre-first-attach suppression + connect recap (HANDOFF.md 7, case B)", () => {
  it("suppresses event narration before the first attach while bookkeeping still advances", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));

    loop.speak("Juoksun löi Aino Aaltonen.");
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0); // nothing synthesized or queued
    expect(loop.state.announcementCount).toBe(1); // ...but counted
    expect(loop.lastSpeech).toBe("Juoksun löi Aino Aaltonen.");

    // Dedupe still operates on suppressed speech: the double-marking is dropped.
    loop.speak("Juoksun löi Aino Aaltonen.");
    expect(loop.state.announcementCount).toBe(1);
  });

  it("speaks exactly one fresh situation recap at the first attach when mid-game speech was suppressed", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));
    loop.matchStarted = true;

    loop.speak("Juoksun löi Aino Aaltonen.");
    loop.speak("Palo! Ensimmäinen palo.");
    s.attached = true;
    loop.maybeLatchNarrationReady(META);
    loop.maybeLatchNarrationReady(META); // idempotent: latch is one-way
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].text).toMatch(/menossa/i); // formatSituationSummary variants
  });

  it("speaks the closing line instead of a mid-game recap if the match finished during suppression", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));
    loop.matchStarted = true;

    loop.speak("Ottelu päättyi!");
    loop.state.finished = true;
    s.attached = true;
    loop.maybeLatchNarrationReady(META);
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].text).toMatch(/^Ottelu päättyi!/);
  });

  it("speaks no extra recap at the first attach when nothing was suppressed", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(true, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));
    loop.matchStarted = true;

    loop.maybeLatchNarrationReady(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
  });

  it("keeps queueing event narration through post-latch ffmpeg drops (flap case unchanged)", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(true, 0);
    const loop = latchedLoop(sink, s, port);
    loop.matchStarted = true;

    s.attached = false; // mid-game flap: ffmpeg exited after the first attach
    loop.speak("Palo! Toinen palo.");
    await loop.synthQueue;
    expect(sink.calls.map((c) => c.text)).toEqual(["Palo! Toinen palo."]);
  });

  it("without a status port everything reaches the sink immediately (old behavior)", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig(), sink));

    loop.speak("Palo! Ensimmäinen palo.");
    await loop.synthQueue;
    expect(sink.calls.map((c) => c.text)).toEqual(["Palo! Ensimmäinen palo."]);
  });
});

describe("CommentaryLoop first-speech grace (HANDOFF.md 16.7. kohta 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("holds the latch until ffmpeg has been attached for the configured grace", () => {
    const { s, port } = mutableStatus(true, 0, 0); // first attach at t=0
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 20000 }), recordingSink(), port));
    expect(s.attached).toBe(true);

    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(false); // attached, but grace still running

    vi.setSystemTime(19999);
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(false);

    vi.setSystemTime(20000);
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(true);
  });

  it("measures the grace from the FIRST attach ever, so a respawn after the grace latches immediately", () => {
    const { s, port } = mutableStatus(false, 0, 0); // first attach happened at t=0, then ffmpeg died
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 20000 }), recordingSink(), port));

    vi.setSystemTime(25000);
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(false); // detached: no latch regardless of elapsed time

    s.attached = true; // respawn re-attaches at t=25s — grace (from t=0) already elapsed
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(true);
  });

  it("keeps the pre-game welcome filler quiet through the grace without burning its cadence", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(true, 0, 0);
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 20000 }), sink, port));

    vi.setSystemTime(10000); // attached, grace running, silence > WELCOME cadence? (lastSpeechAt=0)
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
    expect(loop.lastSpeechAt).toBe(0); // cadence untouched — fires fresh once ready
  });

  it("applies no grace when firstSpeechDelayMs is 0 (default off in tests)", () => {
    const { port } = mutableStatus(true, 0, null); // attached but mixer never reported a first-attach time
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 0 }), recordingSink(), port));
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(true);
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
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 4000 }), sink));

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
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 5000 }), sink));

    expect(loop.state.announcementCount).toBe(0);
    loop.speak("Juoksu!"); // counts as an announcement
    // No timers advanced yet: sink hasn't fired, but bookkeeping already has.
    expect(sink.calls).toHaveLength(0);
    expect(loop.state.announcementCount).toBe(1);
    expect(loop.lastSpeech).toBe("Juoksu!");
  });

  it("measures the delay from each clip's decision time (a floor, not a per-clip cumulative wait) and preserves order", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 1000 }), sink));

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
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 0 }), sink));

    loop.speak("Heti");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].at).toBe(0);
  });
});
