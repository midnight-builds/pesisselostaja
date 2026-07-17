import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElevenLabsTts } from "../src/elevenLabsTts.js";

function fakeFetch(calls: { url: string; body: string }[], status = 200) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(status === 200 ? Buffer.from("mp3-data") : "credits exhausted", { status });
  }) as typeof fetch;
}

const decode = async (mp3: Buffer) => Buffer.concat([Buffer.from("pcm:"), mp3]);

describe("ElevenLabsTts", () => {
  let cacheDir: string;
  let calls: { url: string; body: string }[];

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "el-tts-test-"));
    calls = [];
  });
  afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

  const makeTts = (status = 200) =>
    new ElevenLabsTts({
      apiKey: "k",
      voiceId: "voice1",
      modelId: "model1",
      cacheDir,
      fetchImpl: fakeFetch(calls, status),
      decode,
    });

  it("synthesizes via the API and returns decoded PCM", async () => {
    const tts = makeTts();
    const pcm = await tts.synthesize("Palo! KPL.");
    expect(pcm.toString()).toBe("pcm:mp3-data");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/text-to-speech/voice1");
    expect(JSON.parse(calls[0].body)).toEqual({ text: "Palo! KPL.", model_id: "model1" });
  });

  it("serves repeated text from the file cache without a second API call", async () => {
    const tts = makeTts();
    await tts.synthesize("Palo! KPL.");
    const again = await tts.synthesize("Palo! KPL.");
    expect(again.toString()).toBe("pcm:mp3-data");
    expect(calls).toHaveLength(1);
    expect(tts.totalCharsUsed).toBe("Palo! KPL.".length);
  });

  it("cache persists across instances (same voice+model+text)", async () => {
    await makeTts().synthesize("Kunnari!");
    const second = makeTts();
    await second.synthesize("Kunnari!");
    expect(calls).toHaveLength(1);
    expect(second.totalCharsUsed).toBe(0);
  });

  it("throws on HTTP errors and counts no characters", async () => {
    const tts = makeTts(401);
    await expect(tts.synthesize("Palo!")).rejects.toThrow("ElevenLabs HTTP 401");
    expect(tts.totalCharsUsed).toBe(0);
  });

  it("counts characters cumulatively for distinct texts", async () => {
    const tts = makeTts();
    await tts.synthesize("abc");
    await tts.synthesize("defg");
    expect(tts.totalCharsUsed).toBe(7);
  });

  describe("previous_text context (HANDOFF.md 16.7. kohta 3)", () => {
    it("sends no previous_text on the first request, then the prior text on the next", async () => {
      const tts = makeTts();
      await tts.synthesize("Palo! KPL.");
      await tts.synthesize("Lyömässä Mäyrä.");
      expect(JSON.parse(calls[0].body)).toEqual({ text: "Palo! KPL.", model_id: "model1" });
      expect(JSON.parse(calls[1].body)).toEqual({
        text: "Lyömässä Mäyrä.",
        model_id: "model1",
        previous_text: "Palo! KPL.",
      });
    });

    it("updates the context on a cache hit too — the cached clip still precedes the next one", async () => {
      const tts = makeTts();
      await tts.synthesize("Kunnari!"); // API call 1
      await tts.synthesize("Juoksu!");  // API call 2
      await tts.synthesize("Kunnari!"); // cache hit, no API call — but becomes the context
      await tts.synthesize("Palo!");    // API call 3
      expect(calls).toHaveLength(3);
      expect(JSON.parse(calls[2].body).previous_text).toBe("Kunnari!");
    });

    it("does not vary the cache key by context: same text = same cached clip", async () => {
      const tts = makeTts();
      await tts.synthesize("Palo!");
      await tts.synthesize("Juoksu!");
      await tts.synthesize("Palo!"); // different previous_text than the first time
      expect(calls).toHaveLength(2); // still served from cache
    });
  });
});
