import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";

export interface ElevenLabsTtsOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** Persistent text→PCM cache; repeated phrases ("Palo! KPL.") cost credits
   *  only once, also across matches. */
  cacheDir: string;
  fetchImpl?: typeof fetch;
  decode?: (mp3: Buffer) => Promise<Buffer>;
}

/** Synthesizes Finnish text to 48kHz stereo s16le PCM via the ElevenLabs API.
 *  Unlike PiperTts this gets the *readable* text (no pronunciation
 *  substitutions) — ElevenLabs reads abbreviations like KPL correctly.
 *  Callers handle fallback to Piper on failure. */
export class ElevenLabsTts {
  private charsUsed = 0;
  /** Most recently synthesized text, sent as `previous_text` on the next
   *  request. It conditions the model without being spoken, which stabilizes
   *  very short inputs — EL is known to hallucinate extra syllables at the
   *  start of short standalone phrases ("reewer lyömässä X", HANDOFF.md 16.7.
   *  kohta 3). Updated on cache hits too: the cached clip still precedes the
   *  next one acoustically. Note the cache key deliberately ignores
   *  previous_text — identical text = same cached clip. */
  private lastText: string | null = null;

  constructor(private opts: ElevenLabsTtsOptions) {
    mkdirSync(opts.cacheDir, { recursive: true });
  }

  /** Characters actually sent to the API this run (≈ credits on multilingual v2). */
  get totalCharsUsed(): number {
    return this.charsUsed;
  }

  async synthesize(text: string): Promise<Buffer> {
    const key = createHash("sha256")
      .update(`${this.opts.modelId}|${this.opts.voiceId}|${text}`)
      .digest("hex");
    const cachePath = join(this.opts.cacheDir, `${key}.pcm`);
    try {
      const cached = await readFile(cachePath);
      this.lastText = text;
      return cached;
    } catch {
      /* cache miss */
    }

    const previousText = this.lastText;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.opts.voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": this.opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: this.opts.modelId,
          // Context only — not spoken. previous_text is the documented
          // text-to-speech body field for conditioning on preceding speech.
          ...(previousText ? { previous_text: previousText } : {}),
        }),
      }
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`ElevenLabs HTTP ${res.status}: ${detail}`);
    }
    const mp3 = Buffer.from(await res.arrayBuffer());
    this.lastText = text;
    this.charsUsed += text.length;
    log(`ElevenLabs-synteesi: ${text.length} merkkiä (ajon aikana yhteensä ${this.charsUsed})`);

    const pcm = await (this.opts.decode ?? mp3ToPcm)(mp3);
    await writeFile(cachePath, pcm).catch((err) =>
      log(`TTS-cachen kirjoitus epäonnistui: ${err instanceof Error ? err.message : err}`)
    );
    return pcm;
  }
}

/** Decodes mp3 to the 48kHz stereo s16le PCM the FfmpegMixer FIFO expects
 *  (same target format as PiperTts). */
function mp3ToPcm(mp3: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-i", "pipe:0", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg mp3-dekoodaus päättyi koodiin ${code}`));
    });
    child.stdin.on("error", () => undefined); // EPIPE if ffmpeg dies first; close() reports it
    child.stdin.end(mp3);
  });
}
