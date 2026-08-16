import { describe, it, expect } from "vitest";
import {
  classifyResolveFailure,
  isHlsManifestUrl,
  parseSourceThrottled,
  SourceEndedError,
  SourceNotLiveYetError,
  SourceThrottledError,
  ytdlpExtractorArgs,
  ytdlpSourceArgs,
} from "../src/ytdlpSource.js";

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
    const both = `${BOT_CHECK_STDERR}\nERROR: Requested format is not available`;
    expect(classifyResolveFailure(both)).toBeInstanceOf(SourceThrottledError);
    expect(classifyResolveFailure(both)).not.toBeInstanceOf(SourceEndedError);
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
