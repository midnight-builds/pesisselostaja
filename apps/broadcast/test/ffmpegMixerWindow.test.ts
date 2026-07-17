import { describe, it, expect } from "vitest";
import { FfmpegMixer, SourceExhaustedError } from "../src/ffmpegMixer.js";

/** Drives the real supervisor loop with a source resolver that always throws,
 *  so no ffmpeg process is ever spawned — only the give-up window logic runs.
 *  Real timers: the first retry backoff is 1 s, so windows under ~1 s decide
 *  the outcome on the second failure. */
function failingMixer(opts: { finished: boolean; maxWindowMs: number; finishedWindowMs: number }) {
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    narrationGain: 1.3,
    fifoPath: "/tmp/pesis-test-mixer-window.pcm",
    maxFailureWindowMs: opts.maxWindowMs,
    finishedFailureWindowMs: opts.finishedWindowMs,
    isMatchFinished: () => opts.finished,
    resolveTestSource: () => {
      throw new Error("ei lähdettä (testin tarkoituksella)");
    },
  });
}

describe("FfmpegMixer give-up window after match end (HANDOFF.md 16.7. kohta 6.2)", () => {
  it("gives up after the SHORT window when the match has finished", async () => {
    // finished window 50 ms < first backoff (1 s) → the second failed attempt
    // already exceeds it; without the finished window the 10 min max would
    // keep this retrying far past the test timeout.
    const mixer = failingMixer({ finished: true, maxWindowMs: 10 * 60 * 1000, finishedWindowMs: 50 });
    await expect(mixer.start()).rejects.toThrow(SourceExhaustedError);
  }, 10000);

  it("keeps the generous window while the match is still running", async () => {
    const mixer = failingMixer({ finished: false, maxWindowMs: 10 * 60 * 1000, finishedWindowMs: 50 });
    const outcome = await Promise.race([
      mixer.start().then(() => "resolved", () => "rejected"),
      new Promise<string>((r) => setTimeout(() => r("still-retrying"), 2500)),
    ]);
    mixer.stop();
    expect(outcome).toBe("still-retrying"); // same failures, but no give-up inside the short window
  }, 10000);
});
