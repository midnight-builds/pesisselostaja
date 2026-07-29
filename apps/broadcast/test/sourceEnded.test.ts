/** Issue #103: when the source is ended on purpose, the narrated broadcast has
 *  to end too — instead of republishing the last DVR window over and over.
 *
 *  Measured 29.7.2026: after the real session (2826 s) the loop respawned and
 *  ffmpeg read the same 34 s tail to a clean `code=0` end, four times in one
 *  match and twice in another. Viewers heard the end of the match five times.
 *
 *  Two mechanisms are tested here, in the order the relay relies on them:
 *  the direct signal (yt-dlp says the live is over) and the fallback heuristic
 *  (the same tail twice in a row). */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FfmpegMixer, SourceExhaustedError } from "../src/ffmpegMixer.js";
import { parseSourceEnded, SourceEndedError } from "../src/ytdlpSource.js";

/** Verbatim yt-dlp output from a finished YouTube live. */
const YTDLP_ENDED =
  "ERROR: [youtube] 2u9riozcoRo: Requested format is not available. Use --list-formats for a list of available formats";
const YTDLP_SCHEDULED = "ERROR: [youtube] 2u9riozcoRo: This live event will begin in 103 minutes.";

describe("parseSourceEnded", () => {
  it("recognises the message a finished live answers with", () => {
    expect(parseSourceEnded(YTDLP_ENDED)).toBe(true);
  });

  it("does not mistake a scheduled broadcast for a finished one", () => {
    // "Not yet" and "not any more" both arrive as a nonzero exit with prose on
    // stderr; confusing them would end the relay before the match started.
    expect(parseSourceEnded(YTDLP_SCHEDULED)).toBe(false);
  });

  it("does not fire on an ordinary network failure", () => {
    expect(parseSourceEnded("ERROR: unable to download video data: HTTP Error 503")).toBe(false);
  });
});

/** A fake ffmpeg that opens the FIFO (so the mixer's handshake completes),
 *  lives for a set time and exits cleanly — the exact shape of reading a
 *  finished stream's leftover window. */
function fakeFfmpeg(fifoPath: string, lifetimeMs: number, exitCode = 0) {
  const script = `cat ${fifoPath} > /dev/null & sleep ${(lifetimeMs / 1000).toFixed(3)}; kill %1 2>/dev/null; exit ${exitCode}`;
  return spawn("sh", ["-c", script], { stdio: ["ignore", "ignore", "pipe"] });
}

interface TailMixerOpts {
  fifoPath: string;
  /** Session lengths in ms; the last value repeats. */
  lifetimesMs: number[];
  exitCode?: number;
  minProductiveRunMs: number;
  minTailMs?: number;
  tailFailureWindowMs?: number;
  onSession?: (ranMs: number) => void;
}

function tailMixer(o: TailMixerOpts): FfmpegMixer {
  let index = 0;
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    narrationGain: 1.3,
    fifoPath: o.fifoPath,
    // Deliberately the LONG window and an unfinished match: the camera
    // operator stopping early is the common case, and the whole point is that
    // the tail is caught without waiting a give-up window out.
    isMatchFinished: () => false,
    maxFailureWindowMs: 10 * 60 * 1000,
    finishedFailureWindowMs: 2 * 60 * 1000,
    minProductiveRunMs: o.minProductiveRunMs,
    // Millisecond sessions stand in for the measured 34 s tails.
    minTailMs: o.minTailMs ?? 100,
    // Millisecond stand-in for the two-minute production window.
    tailFailureWindowMs: o.tailFailureWindowMs ?? 50,
    urlRefreshMs: 15 * 60 * 1000,
    resolveTestSource: () => "/dev/null",
    spawnMixerProcess: () => {
      const lifetime = o.lifetimesMs[Math.min(index, o.lifetimesMs.length - 1)]!;
      index++;
      return fakeFfmpeg(o.fifoPath, lifetime, o.exitCode ?? 0);
    },
    onSessionEnd: (_at, ranMs) => o.onSession?.(ranMs),
  });
}

let dir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fifoIn(name: string): string {
  dir = mkdtempSync(join(tmpdir(), "pesis-tail-"));
  return join(dir, `${name}.pcm`);
}

describe("source ended deliberately", () => {
  it("stops when yt-dlp says the live is over — after the answer is confirmed", async () => {
    const fifoPath = fifoIn("ended");
    let resolves = 0;
    const mixer = new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "", streamKey: "",
      narrationGain: 1.3,
      fifoPath,
      isMatchFinished: () => false,
      maxFailureWindowMs: 10 * 60 * 1000,
      minProductiveRunMs: 60_000,
      urlRefreshMs: 15 * 60 * 1000,
      resolveTestSource: () => {
        resolves++;
        // First resolve works — this is a source that WAS live.
        if (resolves === 1) return "/dev/null";
        throw new SourceEndedError(YTDLP_ENDED);
      },
      spawnMixerProcess: () => fakeFfmpeg(fifoPath, 200, 0),
    });
    try {
      const err = await mixer.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceExhaustedError);
      expect((err as SourceExhaustedError).reason).toBe("ended");
      expect((err as SourceExhaustedError).message).toMatch(/päättynyt/);
    } finally {
      mixer.stop();
    }
    // Resolve 1 succeeded, 2 was the unconfirmed answer, 3 confirmed it.
    expect(resolves).toBeGreaterThanOrEqual(3);
  }, 20000);

  it("does NOT end a broadcast on a single yt-dlp hiccup", async () => {
    // One bad answer between two good ones is what retries exist for. Ending
    // the relay on it would kill a live broadcast that was never in trouble.
    const fifoPath = fifoIn("hiccup");
    let resolves = 0;
    const mixer = new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "", streamKey: "",
      narrationGain: 1.3,
      fifoPath,
      isMatchFinished: () => false,
      maxFailureWindowMs: 10 * 60 * 1000,
      minProductiveRunMs: 100,
      urlRefreshMs: 15 * 60 * 1000,
      resolveTestSource: () => {
        resolves++;
        if (resolves === 2) throw new SourceEndedError(YTDLP_ENDED);
        return "/dev/null";
      },
      spawnMixerProcess: () => fakeFfmpeg(fifoPath, 300, 0),
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 4000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
    expect(resolves).toBeGreaterThan(2); // it kept going after the hiccup
  }, 20000);

  it("does not trust the ended message before the source has ever opened", async () => {
    // The relay is routinely started long before kickoff. A format error from
    // a source that has never resolved means the extraction failed, not that
    // a broadcast finished — and it must not end the run.
    const fifoPath = fifoIn("premature");
    let resolves = 0;
    const mixer = new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "", streamKey: "",
      narrationGain: 1.3,
      fifoPath,
      isMatchFinished: () => false,
      maxFailureWindowMs: 10 * 60 * 1000,
      minProductiveRunMs: 60_000,
      urlRefreshMs: 15 * 60 * 1000,
      resolveTestSource: () => {
        resolves++;
        throw new SourceEndedError(YTDLP_ENDED);
      },
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 4000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
    expect(resolves).toBeGreaterThan(2);
  }, 20000);

  it("stops after the same tail is republished twice, without waiting out the give-up window", async () => {
    const fifoPath = fifoIn("tail");
    const sessions: number[] = [];
    // A real broadcast, then the same short tail again and again.
    const mixer = tailMixer({
      fifoPath,
      lifetimesMs: [700, 200, 200, 200, 200],
      minProductiveRunMs: 500,
      onSession: (ms) => sessions.push(ms),
    });
    try {
      const err = await mixer.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceExhaustedError);
      expect((err as SourceExhaustedError).reason).toBe("ended");
      expect((err as SourceExhaustedError).message).toMatch(/toisti saman/);
    } finally {
      mixer.stop();
    }
    // Bounded: the tail window ends the run within a few replays instead of
    // the twelve minutes a plain failure would get.
    expect(sessions.length).toBeLessThanOrEqual(5);
  }, 20000);

  it("survives an upstream stall that recovers inside the tail window", async () => {
    // The camera phone loses LTE, YouTube keeps serving the frozen window, and
    // ffmpeg reads it to the same clean end twice — physically identical to a
    // finished broadcast. The source can still come back, so the window has to
    // be what decides, not the pattern.
    const fifoPath = fifoIn("stall");
    const sessions: number[] = [];
    const mixer = tailMixer({
      fifoPath,
      // Two identical tails, then the source recovers into a long session.
      lifetimesMs: [700, 200, 200, 900, 900],
      minProductiveRunMs: 500,
      tailFailureWindowMs: 60_000, // a stall that recovers within the window
      onSession: (ms) => sessions.push(ms),
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 8000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
    // It kept running past the pair of identical tails.
    expect(sessions.length).toBeGreaterThanOrEqual(3);
  }, 20000);

  it("does not call a stuttering source a tail — varying lengths keep it running", async () => {
    // The failure mode to avoid: cutting a broadcast that was merely blipping.
    // A dead source can come back, and uptime is the top priority.
    const fifoPath = fifoIn("varying");
    const sessions: number[] = [];
    const mixer = tailMixer({
      fifoPath,
      lifetimesMs: [700, 150, 400, 150, 400, 150],
      minProductiveRunMs: 500,
      onSession: (ms) => sessions.push(ms),
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 4000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
    // At least one tail candidate followed the productive session, i.e. the
    // heuristic really did get the chance to fire and declined.
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  }, 20000);

  it("does not call a crash a tail — a clean exit is part of the signature", async () => {
    const fifoPath = fifoIn("crash");
    const mixer = tailMixer({
      fifoPath,
      lifetimesMs: [700, 200],
      exitCode: 1,
      minProductiveRunMs: 500,
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 4000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
  }, 20000);

  it("recognises a tail that is LONGER than a productive run", async () => {
    // 34 s was one phone's encoder settings. A 90 s leftover window would be
    // counted as healthy broadcast by the old rule, resetting the give-up
    // window on every replay — republishing the end of the match forever.
    const fifoPath = fifoIn("longtail");
    const mixer = tailMixer({
      fifoPath,
      lifetimesMs: [700, 700, 700, 700],
      minProductiveRunMs: 500, // every session counts as "productive"
      onSession: () => undefined,
    });
    try {
      const err = await mixer.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceExhaustedError);
      expect((err as SourceExhaustedError).reason).toBe("ended");
    } finally {
      mixer.stop();
    }
  }, 20000);

  it("breaks the streak on anything that is not a clean session", async () => {
    // Two tails separated by unrelated failures are not "peräkkäin". Without
    // this, a tail from before a four-minute outage pairs with one after it.
    const fifoPath = fifoIn("streak");
    let index = 0;
    const mixer = new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "", streamKey: "",
      narrationGain: 1.3,
      fifoPath,
      isMatchFinished: () => false,
      maxFailureWindowMs: 10 * 60 * 1000,
      minProductiveRunMs: 500,
      minTailMs: 100,
      tailFailureWindowMs: 50,
      urlRefreshMs: 15 * 60 * 1000,
      resolveTestSource: () => {
        index++;
        // 1: long session. 2: tail. 3: resolve fails. 4: tail again.
        if (index === 3) throw new Error("yt-dlp: temporary failure");
        return "/dev/null";
      },
      spawnMixerProcess: () => fakeFfmpeg(fifoPath, index === 1 ? 700 : 200, 0),
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 5000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
  }, 20000);

  it("leaves issue #45's never-started case to its own verdict", async () => {
    // Repeated clean short sessions with NO productive session before them are
    // a source that never got going. That has its own wording and its own
    // window, and this heuristic must not take it over.
    const fifoPath = fifoIn("neverstarted");
    const mixer = tailMixer({
      fifoPath,
      lifetimesMs: [200],
      minProductiveRunMs: 10_000,
      minTailMs: 100,
      // Short window so the original path still reaches its verdict quickly.
    });
    (mixer as unknown as { maxFailureWindowMs: number }).maxFailureWindowMs = 50;
    try {
      const err = await mixer.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceExhaustedError);
      expect((err as SourceExhaustedError).reason).toBe("exhausted");
      expect((err as SourceExhaustedError).message).toMatch(/kuolleet alle/);
    } finally {
      mixer.stop();
    }
  }, 20000);
});
