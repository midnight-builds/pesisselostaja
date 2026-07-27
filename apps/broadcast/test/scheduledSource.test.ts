import { describe, it, expect, vi } from "vitest";
import { parseScheduledStart, SourceNotLiveYetError } from "../src/ytdlpSource.js";
import { FfmpegMixer, SourceExhaustedError, scheduledRecheckDelayMs } from "../src/ffmpegMixer.js";

/** Verbatim yt-dlp output from the match 144918 preparation, 27.7.2026. */
const YTDLP_SCHEDULED = "ERROR: [youtube] 2u9riozcoRo: This live event will begin in 103 minutes.";
const YTDLP_SOON = "ERROR: [youtube] 2u9riozcoRo: This live event will begin in 4 minutes.";
const YTDLP_ENDED =
  "ERROR: [youtube] 2u9riozcoRo: Requested format is not available. Use --list-formats for a list of available formats";

describe("parseScheduledStart", () => {
  it("reads the announced wait in minutes", () => {
    expect(parseScheduledStart(YTDLP_SCHEDULED)).toEqual({ startsInMs: 103 * 60 * 1000 });
    expect(parseScheduledStart(YTDLP_SOON)).toEqual({ startsInMs: 4 * 60 * 1000 });
  });

  it("handles the other units yt-dlp uses", () => {
    expect(parseScheduledStart("This live event will begin in 30 seconds.")).toEqual({ startsInMs: 30_000 });
    expect(parseScheduledStart("This live event will begin in 2 hours.")).toEqual({ startsInMs: 7_200_000 });
  });

  it("still recognizes a scheduled start whose amount does not parse", () => {
    expect(parseScheduledStart("This live event will begin in a few moments.")).toEqual({ startsInMs: null });
  });

  it("does NOT treat a real failure as scheduled — that source is gone", () => {
    expect(parseScheduledStart(YTDLP_ENDED)).toBeNull();
    expect(parseScheduledStart("ERROR: [youtube] xyz: Private video. Sign in if you've been granted access")).toBeNull();
    expect(parseScheduledStart("")).toBeNull();
  });
});

describe("scheduledRecheckDelayMs", () => {
  it("lands ~20 s before a near start", () => {
    expect(scheduledRecheckDelayMs(90_000)).toBe(70_000);
  });

  it("caps a far-off start at 5 min instead of hammering yt-dlp", () => {
    expect(scheduledRecheckDelayMs(103 * 60 * 1000)).toBe(5 * 60 * 1000);
    expect(scheduledRecheckDelayMs(null)).toBe(5 * 60 * 1000);
  });

  it("never drops below 5 s, even past the announced time", () => {
    expect(scheduledRecheckDelayMs(1000)).toBe(5000);
    expect(scheduledRecheckDelayMs(0)).toBe(5000);
  });
});

function scheduledMixer(resolveTestSource: () => Promise<string>, finishedWindowMs = 50) {
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    narrationGain: 1.3,
    fifoPath: "/tmp/pesis-test-scheduled-source.pcm",
    // Absurdly short windows: if a scheduled answer counted toward them, the
    // very next attempt would give up. It must not.
    maxFailureWindowMs: 50,
    finishedFailureWindowMs: finishedWindowMs,
    resolveTestSource,
  });
}

describe("FfmpegMixer waiting for a scheduled source", () => {
  it("does not burn the give-up window while yt-dlp says the event is scheduled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const mixer = scheduledMixer(async () => {
        // 25 s out → recheck in 5 s, so the test's own window decides the race.
        throw new SourceNotLiveYetError("This live event will begin in 1 minutes.", 25_000);
      });
      const outcome = await Promise.race([
        mixer.start().then(() => "resolved", (e) => (e instanceof SourceExhaustedError ? "gave-up" : "other-error")),
        new Promise<string>((r) => setTimeout(() => r("still-waiting"), 2000)),
      ]);
      mixer.stop();
      expect(outcome).toBe("still-waiting");
      const waited = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Lähde ei ole vielä livenä"));
      expect(waited[0]).toContain("alkaa noin 25 s kuluttua");
      // The alarming failure wording is reserved for genuine failures.
      expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("ffmpeg-käynnistysvirhe");
    } finally {
      logSpy.mockRestore();
    }
  }, 10000);

  it("still gives up promptly once the source fails for real after being scheduled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let calls = 0;
      const mixer = scheduledMixer(async () => {
        calls++;
        if (calls === 1) throw new SourceNotLiveYetError("will begin in 1 seconds.", 1000);
        throw new Error("ei lähdettä (testin tarkoituksella)");
      });
      // maxFailureWindowMs is 50 ms, so the first genuine failure plus one
      // backoff already exceeds it — the earlier scheduled answer must not
      // have left the mixer in some forgiving state.
      await expect(mixer.start()).rejects.toThrow(SourceExhaustedError);
      expect(calls).toBeGreaterThan(1);
    } finally {
      logSpy.mockRestore();
    }
  }, 15000);
});
