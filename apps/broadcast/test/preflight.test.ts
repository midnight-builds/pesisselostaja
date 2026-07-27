import { describe, it, expect } from "vitest";
import { parseEnvFile, summarize, type Check } from "../src/preflight.js";

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
