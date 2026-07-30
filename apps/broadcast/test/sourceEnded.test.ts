/** Issue #103: when the source broadcast is over, ours has to end too —
 *  instead of republishing the last DVR window over and over.
 *
 *  Measured 29.7.2026: after the real session (2826 s) the loop respawned and
 *  ffmpeg read the same 34 s tail to a clean end, four times in one match and
 *  twice in another. Viewers heard the end of the match five times.
 *
 *  The fix rests on asking rather than inferring: yt-dlp reports YouTube's own
 *  `live_status`, so "the broadcast is over" is an answer about the source and
 *  not a guess from our own symptoms. Verified against real sources the same
 *  day — an active live answers `is_live`, the finished match `post_live`. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FfmpegMixer, SourceExhaustedError } from "../src/ffmpegMixer.js";
import {
  isEndedStatus,
  parseResolveOutput,
  parseSourceEnded,
  SourceEndedError,
} from "../src/ytdlpSource.js";

/** Verbatim yt-dlp output, captured 29.7.2026. */
const MANIFEST_URL = "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1785364362/x";
const YTDLP_ENDED =
  "ERROR: [youtube] 2u9riozcoRo: Requested format is not available. Use --list-formats for a list of available formats";
const YTDLP_SCHEDULED = "ERROR: [youtube] 2u9riozcoRo: This live event will begin in 103 minutes.";

describe("parseResolveOutput", () => {
  it("reads the status and the URL out of one call", () => {
    // yt-dlp prints --print fields before -g's URLs.
    expect(parseResolveOutput(`is_live\n${MANIFEST_URL}\n`)).toEqual({
      url: MANIFEST_URL,
      liveStatus: "is_live",
    });
  });

  it("finds them regardless of extra output lines", () => {
    const stdout = `WARNING: some web client formats have been skipped\npost_live\n${MANIFEST_URL}\n`;
    expect(parseResolveOutput(stdout)).toEqual({ url: MANIFEST_URL, liveStatus: "post_live" });
  });

  it("reports 'unknown' rather than guessing when the field is missing", () => {
    // An older yt-dlp, or an extraction that got this far without the field.
    expect(parseResolveOutput(`${MANIFEST_URL}\n`)).toEqual({
      url: MANIFEST_URL,
      liveStatus: "unknown",
    });
  });
});

describe("isEndedStatus", () => {
  it("treats the three finished states as ended", () => {
    expect(isEndedStatus("post_live")).toBe(true);
    expect(isEndedStatus("was_live")).toBe(true);
    expect(isEndedStatus("not_live")).toBe(true);
  });

  it("never treats a live, upcoming or unknown source as ended", () => {
    // The dangerous direction is ending a broadcast that is still running.
    // Not knowing must never be enough — uptime first.
    expect(isEndedStatus("is_live")).toBe(false);
    expect(isEndedStatus("is_upcoming")).toBe(false);
    expect(isEndedStatus("unknown")).toBe(false);
  });
});

describe("parseSourceEnded (fallback for a failure that carries no status)", () => {
  it("recognises the message a finished live answers with", () => {
    expect(parseSourceEnded(YTDLP_ENDED)).toBe(true);
  });

  it("does not mistake a scheduled broadcast for a finished one", () => {
    expect(parseSourceEnded(YTDLP_SCHEDULED)).toBe(false);
  });

  it("does not fire on an ordinary network failure", () => {
    expect(parseSourceEnded("ERROR: unable to download video data: HTTP Error 503")).toBe(false);
  });
});

/** A fake ffmpeg that opens the FIFO (so the mixer's handshake completes),
 *  lives for a set time and exits cleanly. */
function fakeFfmpeg(fifoPath: string, lifetimeMs: number, exitCode = 0) {
  const script = `cat ${fifoPath} > /dev/null & sleep ${(lifetimeMs / 1000).toFixed(3)}; kill %1 2>/dev/null; exit ${exitCode}`;
  return spawn("sh", ["-c", script], { stdio: ["ignore", "ignore", "pipe"] });
}

let dir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fifoIn(name: string): string {
  dir = mkdtempSync(join(tmpdir(), "pesis-ended-"));
  return join(dir, `${name}.pcm`);
}

describe("FfmpegMixer when the source has ended", () => {
  it("stops immediately, and names the source's end instead of blaming anyone", async () => {
    const fifoPath = fifoIn("ended");
    let resolves = 0;
    const mixer = new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "", streamKey: "",
      narrationGain: 1.3,
      fifoPath,
      isMatchFinished: () => false,
      // The long window: the point is that it is not waited out at all.
      maxFailureWindowMs: 10 * 60 * 1000,
      minProductiveRunMs: 60_000,
      urlRefreshMs: 15 * 60 * 1000,
      resolveTestSource: () => {
        resolves++;
        throw new SourceEndedError("yt-dlp: live_status=post_live");
      },
    });
    try {
      const err = await mixer.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceExhaustedError);
      expect((err as SourceExhaustedError).reason).toBe("ended");
      expect((err as SourceExhaustedError).message).toMatch(/päättynyt/);
    } finally {
      mixer.stop();
    }
    // Zero replays: it did not resolve a second time, so no part of the tail
    // was ever pushed to viewers.
    expect(resolves).toBe(1);
    expect(mixer.sourceState).toBe("ended");
  }, 20000);

  it("does not end the broadcast for a source that is merely failing", async () => {
    // A dead source can come back, and uptime is the top priority. Without an
    // "ended" answer the give-up window decides, exactly as before.
    const fifoPath = fifoIn("failing");
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
        throw new Error("yt-dlp: HTTP Error 503");
      },
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 4000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
    expect(resolves).toBeGreaterThan(1);
  }, 20000);

  it("keeps running while the source stalls without ending", async () => {
    // The camera phone loses its uplink: YouTube still reports the broadcast
    // live, and ffmpeg reads the frozen window to a clean end again and again.
    // Nothing says "ended", so the relay waits for it to come back.
    const fifoPath = fifoIn("stall");
    const sessions: number[] = [];
    const mixer = new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "", streamKey: "",
      narrationGain: 1.3,
      fifoPath,
      isMatchFinished: () => false,
      maxFailureWindowMs: 10 * 60 * 1000,
      minProductiveRunMs: 60_000,
      urlRefreshMs: 15 * 60 * 1000,
      resolveTestSource: () => "/dev/null",
      spawnMixerProcess: () => fakeFfmpeg(fifoPath, 200, 0),
      onSessionEnd: (_at, ranMs) => sessions.push(ranMs),
    });
    const raced = await Promise.race([
      mixer.start().catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 5000)),
    ]);
    mixer.stop();
    expect(raced).toBe("still-running");
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  }, 20000);
});
