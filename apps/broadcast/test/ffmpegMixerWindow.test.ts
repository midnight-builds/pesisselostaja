import { describe, it, expect, vi } from "vitest";
import { SourceThrottledError } from "../src/ytdlpSource.js";
import {
  BACKOFF_MAX_MS,
  FfmpegMixer,
  nextBackoffMs,
  SourceExhaustedError,
  THROTTLED_BACKOFF_MAX_MS,
  THROTTLED_BACKOFF_MIN_MS,
} from "../src/ffmpegMixer.js";

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

describe("FfmpegMixer give-up window after match end", () => {
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

/** Issue #249: on 16.8.2026 YouTube answered a mid-match re-resolve with HTTP
 *  429 + the bot check. At the ordinary 30 s cap the relay would knock twice a
 *  minute for as long as the block lasted. */
describe("respawn backoff against YouTube's bot check / 429", () => {
  const MID_MATCH_WINDOW = 12 * 60 * 1000;
  const FINISHED_WINDOW = 2 * 60 * 1000;

  it("keeps the ordinary fast backoff for an ordinary outage", () => {
    expect(nextBackoffMs(1000, { throttled: false, giveUpWindowMs: MID_MATCH_WINDOW })).toBe(2000);
    expect(nextBackoffMs(20000, { throttled: false, giveUpWindowMs: MID_MATCH_WINDOW })).toBe(
      BACKOFF_MAX_MS
    );
  });

  it("jumps straight to a minute when YouTube throttled us — no creeping up from 1 s", () => {
    expect(nextBackoffMs(1000, { throttled: true, giveUpWindowMs: MID_MATCH_WINDOW })).toBe(
      THROTTLED_BACKOFF_MIN_MS
    );
  });

  it("backs off well past the ordinary cap instead of hammering the block", () => {
    let ms = 1000;
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      ms = nextBackoffMs(ms, { throttled: true, giveUpWindowMs: MID_MATCH_WINDOW });
      seen.push(ms);
    }
    expect(Math.min(...seen)).toBeGreaterThan(BACKOFF_MAX_MS);
    expect(Math.max(...seen)).toBe(THROTTLED_BACKOFF_MAX_MS);
  });

  it("never sleeps past half the give-up window — the window owns the give-up decision", () => {
    // A finished match cleans up in 2 min; a 5 min nap would decide that by
    // oversleeping instead.
    expect(
      nextBackoffMs(60000, { throttled: true, giveUpWindowMs: FINISHED_WINDOW })
    ).toBeLessThanOrEqual(FINISHED_WINDOW / 2);
  });

  it("caps at half the window for EVERY window, including short ones", () => {
    // Aiempi versio piti 30 s lattian myös silloin kun ikkuna oli 30 s, eli
    // yksi uni söi koko ikkunan. Katto on katto, ei toive.
    for (const windowMs of [50, 2000, 30_000, 59_000, 120_000, 12 * 60 * 1000]) {
      let ms = 1000;
      for (let i = 0; i < 8; i++) {
        ms = nextBackoffMs(ms, { throttled: true, giveUpWindowMs: windowMs });
        expect(ms).toBeLessThanOrEqual(Math.max(1, Math.floor(windowMs / 2)));
      }
    }
  });

  it("tells the operator which END is in trouble, not just 'lähde failed'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mixer = new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "", streamKey: "",
      narrationGain: 1.3,
      fifoPath: "/tmp/pesis-test-mixer-throttled.pcm",
      resolveTestSource: () => {
        throw new SourceThrottledError("ERROR: Sign in to confirm you’re not a bot. HTTP Error 429");
      },
    });
    void mixer.start().catch(() => undefined);
    for (let i = 0; i < 40 && mixer.sourceDetail === null; i++) await new Promise((r) => setTimeout(r, 50));
    const detail = mixer.sourceDetail ?? "";
    mixer.stop();

    // The state itself stays in the union the ohjaamo already mirrors…
    expect(mixer.sourceState).toBe("failed");
    // …but the wording no longer sends the operator after the camera phone,
    // which is the one end of the chain nobody can reach mid-match (#249).
    expect(detail).toMatch(/YouTube torjuu haun/i);
    expect(detail).toMatch(/raakalähetyksen omasta tilasta ei tietoa/i);
  }, 10000);
});
