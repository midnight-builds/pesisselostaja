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
  it("stops at once when yt-dlp says the live is over, without blaming anyone", async () => {
    const fifoPath = fifoIn("ended");
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
        throw new SourceEndedError(YTDLP_ENDED);
      },
    });
    try {
      const err = await mixer.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceExhaustedError);
      // The reason is what the relay's shutdown log keys on: this is a normal
      // end of broadcast, not a fault to go looking for.
      expect((err as SourceExhaustedError).reason).toBe("ended");
      expect((err as SourceExhaustedError).message).toMatch(/päättynyt/);
    } finally {
      mixer.stop();
    }
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
    // One productive session plus exactly two tails: the second tail is what
    // identifies the pattern, and nothing after it is pushed out.
    expect(sessions).toHaveLength(3);
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
