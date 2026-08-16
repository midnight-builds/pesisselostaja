import { describe, it, expect } from "vitest";
import { checkSource, parseEnvFile, summarize, type Check } from "../src/preflight.js";
import { ytdlpSourceArgs } from "../src/ytdlpSource.js";

/** True when `needle` appears as a contiguous run inside `haystack`. */
function containsRun(haystack: string[], needle: string[]): boolean {
  return haystack.some((_, i) => needle.every((v, j) => haystack[i + j] === v));
}

/** Preflight must ask YouTube the SAME question the relay will ask. The two
 *  argument lists were copies until #249, and a copy is exactly how preflight
 *  can bless a source the relay then fails to fetch: the host-level
 *  `--extractor-args` workaround was invisible to both.
 *
 *  yt-dlp is never executed here — the argv is the assertion. */
describe("preflight resolves the source exactly like the relay (#249)", () => {
  async function argvOf(): Promise<string[]> {
    let seen: string[] = [];
    await checkSource("https://example.invalid/live", {
      runYtdlp: async (args) => {
        seen = args;
        return { stdout: "https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8\n" };
      },
    });
    return seen;
  }

  it("passes the relay's own flag list, not a copy of it", async () => {
    expect(containsRun(await argvOf(), ytdlpSourceArgs())).toBe(true);
  });

  it("carries the JS runtime and the extractor args — the two that have bitten us", async () => {
    const argv = await argvOf();
    expect(argv).toContain("--js-runtimes");
    expect(containsRun(argv, ["--extractor-args", "youtube:player_client=android"])).toBe(true);
  });

  it("says which end is in trouble when YouTube bot-checks the check itself", async () => {
    const check = await checkSource("https://example.invalid/live", {
      runYtdlp: async () => {
        throw Object.assign(new Error("yt-dlp failed"), {
          stderr: "ERROR: Sign in to confirm you’re not a bot. HTTP Error 429: Too Many Requests",
        });
      },
    });
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/bottitarkistus/i);
    expect(check.detail).toMatch(/raakalähetyksen omasta tilasta\s*\n?\s*ei tietoa/i);
  });
});

describe("parseEnvFile", () => {
  it("reads the .env.relay shapes systemd accepts", () => {
    const env = parseEnvFile(
      [
        "# comment",
        "",
        "RELAY_MATCH_ID=144918",
        "RELAY_YOUTUBE_URL=https://www.youtube.com/watch?v=abc123",
        '  RELAY_RTMP_URL = "rtmp://a.rtmp.youtube.com/live2"  ',
        "#RELAY_STREAM_KEY=commented-out",
        "MALFORMED",
        "=novalue",
      ].join("\n")
    );
    expect(env).toEqual({
      RELAY_MATCH_ID: "144918",
      RELAY_YOUTUBE_URL: "https://www.youtube.com/watch?v=abc123",
      RELAY_RTMP_URL: "rtmp://a.rtmp.youtube.com/live2",
    });
  });

  it("keeps a commented-out key out — a cleaned-up file must not look configured", () => {
    expect(parseEnvFile("#RELAY_MATCH_ID=\n#RELAY_STREAM_KEY=old-key")).toEqual({});
  });

  it("does not mangle values containing = (stream keys, query strings)", () => {
    const env = parseEnvFile("RELAY_YOUTUBE_URL=https://youtu.be/x?v=1&t=2");
    expect(env.RELAY_YOUTUBE_URL).toBe("https://youtu.be/x?v=1&t=2");
  });
});

const check = (status: Check["status"], name = "X"): Check => ({ name, status, detail: "d" });

describe("summarize", () => {
  it("exits nonzero only when something actually blocks the broadcast", () => {
    expect(summarize([check("ok"), check("ok")]).exitCode).toBe(0);
    expect(summarize([check("ok"), check("warn")]).exitCode).toBe(0);
    expect(summarize([check("ok"), check("fail")]).exitCode).toBe(1);
  });

  it("names the outcome so the operator does not have to count marks", () => {
    expect(summarize([check("ok")]).text).toContain("Kaikki kunnossa");
    expect(summarize([check("warn")]).text).toContain("1 huomautus");
    expect(summarize([check("warn"), check("warn")]).text).toContain("2 huomautusta");
    expect(summarize([check("fail")]).text).toContain("1 este —");
    expect(summarize([check("fail"), check("fail")]).text).toContain("2 estettä");
  });

  it("a warning next to a failure does not soften the verdict", () => {
    const { text, exitCode } = summarize([check("warn"), check("fail")]);
    expect(exitCode).toBe(1);
    expect(text).toContain("älä käynnistä");
  });
});
