import { describe, it, expect } from "vitest";
import { isHlsManifestUrl } from "../src/ytdlpSource.js";

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
