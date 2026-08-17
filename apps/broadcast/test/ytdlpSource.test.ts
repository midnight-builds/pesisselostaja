import { describe, it, expect } from "vitest";
import {
  classifyResolveFailure,
  isHlsManifestUrl,
  parseSourceEndedFinal,
  parseSourceThrottled,
  SourceEndedError,
  SourceNotLiveYetError,
  SourceThrottledError,
  ytdlpExtractorArgs,
  ytdlpSourceArgs,
  ytdlpVodArgs,
} from "../src/ytdlpSource.js";

/** True when `needle` appears as a contiguous run inside `haystack`. */
function containsRun(haystack: string[], needle: string[]): boolean {
  return haystack.some((_, i) => needle.every((v, j) => haystack[i + j] === v));
}

/** Real URLs shortened from a 27.7.2026 resolve of the same video, first
 *  without a JS runtime (progressive fallback) and then with one (HLS). */
const HLS = "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1785170918/ei/hjdnas/ip/10.0.0.1/index.m3u8";
const PROGRESSIVE = "https://rr2---sn-ixh7yn7e.googlevideo.com/videoplayback?expire=1785170902&itag=18&source=youtube&mime=video%2Fmp4";

describe("isHlsManifestUrl", () => {
  it("accepts the manifest URL an m3u8 format pick resolves to", () => {
    expect(isHlsManifestUrl(HLS)).toBe(true);
  });

  it("accepts a plain .m3u8 URL", () => {
    expect(isHlsManifestUrl("https://example.com/live/stream.m3u8?token=x")).toBe(true);
  });

  it("rejects the progressive mp4 that `best` falls back to without a JS runtime", () => {
    expect(isHlsManifestUrl(PROGRESSIVE)).toBe(false);
  });
});

/** The stderr of the 16.8.2026 mid-match resolve that put the slate on air for
 *  ~4 minutes (issue #249). */
const BOT_CHECK_STDERR = [
  "WARNING: [youtube] Failed to download player",
  'ERROR: [youtube] abc123XYZ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. HTTP Error 429: Too Many Requests',
].join("\n");

describe("yt-dlp extractor args (issue #249)", () => {
  it("defaults to the android player client — the workaround that unblocked the live", () => {
    expect(ytdlpExtractorArgs(undefined)).toEqual([
      "--extractor-args",
      "youtube:player_client=android",
    ]);
  });

  it("is carried by the relay's own argv, not by the host's ~/.config/yt-dlp/config", () => {
    expect(ytdlpSourceArgs()).toContain("--extractor-args");
    expect(ytdlpSourceArgs()).toContain("youtube:player_client=android");
  });

  it("lets the operator pick another client without touching the host", () => {
    expect(ytdlpSourceArgs("youtube:player_client=web")).toContain("youtube:player_client=web");
    expect(ytdlpSourceArgs("youtube:player_client=web")).not.toContain(
      "youtube:player_client=android"
    );
  });

  it("takes an empty value as 'no extractor args at all'", () => {
    expect(ytdlpExtractorArgs("")).toEqual([]);
    expect(ytdlpSourceArgs("")).not.toContain("--extractor-args");
  });

  it("splits several specs on whitespace and leaves yt-dlp's own ; and , alone", () => {
    expect(ytdlpExtractorArgs("youtube:player_client=android,web youtubetab:skip=webpage")).toEqual([
      "--extractor-args",
      "youtube:player_client=android,web",
      "--extractor-args",
      "youtubetab:skip=webpage",
    ]);
  });

  it("keeps the format/JS-runtime flags preflight and the relay share", () => {
    expect(ytdlpSourceArgs()).toEqual(
      expect.arrayContaining(["-f", "best[protocol^=m3u8]/best", "--no-playlist", "--js-runtimes"])
    );
  });

  /** simulate.ts downloads a finished VOD through the same YouTube and the
   *  same IP, so the bot check hits it too — but it must NOT inherit the live
   *  m3u8 format pick. The split is deliberate, and therefore worth guarding:
   *  removing the shared extractor args left the whole suite green before. */
  it("shares the extractor args with the VOD download, but not the live format pick", () => {
    const vod = ytdlpVodArgs("/tmp/out.mp4");
    expect(containsRun(vod, ["--extractor-args", "youtube:player_client=android"])).toBe(true);
    // Ei elävän lähetyksen formaattivalintaa eikä JS-runtimea: eri kysymys.
    expect(vod).not.toContain("best[protocol^=m3u8]/best");
    expect(vod).toEqual(expect.arrayContaining(["-f", "bv*+ba/best", "-o", "/tmp/out.mp4"]));
  });

  it("lets the same env key steer the VOD download too", () => {
    process.env.RELAY_YTDLP_EXTRACTOR_ARGS = "youtube:player_client=ios";
    try {
      expect(containsRun(ytdlpVodArgs("/tmp/out.mp4"), ["--extractor-args", "youtube:player_client=ios"])).toBe(true);
    } finally {
      delete process.env.RELAY_YTDLP_EXTRACTOR_ARGS;
    }
  });
});

describe("classifying a failed resolve (issue #249)", () => {
  it("recognises the bot check and the 429 behind it", () => {
    expect(parseSourceThrottled(BOT_CHECK_STDERR)).toBe(true);
    expect(parseSourceThrottled("ERROR: HTTP Error 429: Too Many Requests")).toBe(true);
    expect(parseSourceThrottled("ERROR: [youtube] This live event has ended")).toBe(false);
  });

  it("answers 'throttled' for the real 16.8.2026 stderr", () => {
    expect(classifyResolveFailure(BOT_CHECK_STDERR)).toBeInstanceOf(SourceThrottledError);
  });

  it("never reads a throttled answer as 'the broadcast ended' — that would kill a live relay", () => {
    // "Requested format is not available" is a SYMPTOM of a failed extraction,
    // and failing to list formats is exactly what a bot check causes.
    const both = `${BOT_CHECK_STDERR}\nERROR: Requested format is not available`;
    expect(classifyResolveFailure(both)).toBeInstanceOf(SourceThrottledError);
    expect(classifyResolveFailure(both)).not.toBeInstanceOf(SourceEndedError);
  });

  /** The other half of that rule, and the one that bites the other way: yt-dlp
   *  prints its 429 RETRY warnings on the same stderr it later prints the real
   *  answer on. If the throttle outranked a final ending, the relay would hold
   *  the slate over a finished match for the whole give-up window (#103). */
  it("lets a FINAL ending outrank a 429 in the same stderr", () => {
    const retriedThenEnded = [
      "WARNING: [youtube] Unable to download webpage: HTTP Error 429: Too Many Requests. Retrying (1/3)…",
      "ERROR: [youtube] abc123XYZ: This live event has ended.",
    ].join("\n");
    expect(parseSourceEndedFinal(retriedThenEnded)).toContain("This live event has ended");
    expect(classifyResolveFailure(retriedThenEnded)).toBeInstanceOf(SourceEndedError);
    expect(classifyResolveFailure(retriedThenEnded)).not.toBeInstanceOf(SourceThrottledError);
    // Syyksi se rivi joka ratkaisi, ei viimeistä riviä.
    expect(classifyResolveFailure(retriedThenEnded)?.message).toContain("This live event has ended");
  });

  /** yt-dlp kokeilee useaa player-clientiä ja alentaa yhden clientin
   *  epäonnistumisen VAROITUKSEKSI jatkaen seuraavalla. Jos varoitus kelpaisi
   *  lopulliseksi tuomioksi, relay sammuisi kesken elävän ottelun todisteella,
   *  jonka yt-dlp itse jo päätti sivuuttaa. */
  it("does not end a live broadcast on a WARNING line — only yt-dlp's own verdict counts", () => {
    const warnedThen429 = [
      "WARNING: [youtube] abc123XYZ: This live event has ended.",
      "ERROR: [youtube] abc123XYZ: Sign in to confirm you’re not a bot. HTTP Error 429: Too Many Requests",
    ].join("\n");
    expect(parseSourceEndedFinal(warnedThen429)).toBeNull();
    expect(classifyResolveFailure(warnedThen429)).toBeInstanceOf(SourceThrottledError);
    expect(classifyResolveFailure(warnedThen429)).not.toBeInstanceOf(SourceEndedError);
  });

  it("keeps the ambiguous wordings ambiguous — they are symptoms, not statements", () => {
    expect(parseSourceEndedFinal("ERROR: Requested format is not available")).toBeNull();
    expect(parseSourceEndedFinal("ERROR: This live stream recording is not available")).toBeNull();
    // …but on their own, with no throttle in sight, they still end the run.
    expect(classifyResolveFailure("ERROR: Requested format is not available")).toBeInstanceOf(
      SourceEndedError
    );
  });

  it("still waits when a scheduled start arrives alongside a 429", () => {
    const scheduledAnd429 = [
      "WARNING: HTTP Error 429: Too Many Requests. Retrying (1/3)…",
      "ERROR: This live event will begin in 12 minutes",
    ].join("\n");
    expect(classifyResolveFailure(scheduledAnd429)).toBeInstanceOf(SourceNotLiveYetError);
  });

  it("still ends on a plain ended answer, and still waits for a scheduled one", () => {
    expect(classifyResolveFailure("ERROR: This live event has ended")).toBeInstanceOf(
      SourceEndedError
    );
    expect(
      classifyResolveFailure("ERROR: This live event will begin in 12 minutes")
    ).toBeInstanceOf(SourceNotLiveYetError);
  });

  it("leaves an unrecognised failure to the caller's own error", () => {
    expect(classifyResolveFailure("ERROR: unable to download webpage")).toBeNull();
  });
});
