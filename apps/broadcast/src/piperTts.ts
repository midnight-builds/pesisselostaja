import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logError } from "./log.js";

const VOICE_FILES: Record<string, string> = {
  "harri-medium": "fi_FI-harri-medium.onnx",
  "harri-low": "fi_FI-harri-low.onnx",
  "asmo-medium": "fi_FI-asmo-medium.onnx",
};

export interface PiperTtsOptions {
  piperBin: string;
  voice: string;
  voicesDir: string;
  /** Randomness source for the per-line noise_w jitter; injectable so tests are
   *  deterministic. Must return a value in [0, 1). Defaults to Math.random. */
  rng?: () => number;
}

/** Approved per-line `noise_w` jitter range (issue #69).
 *
 *  Piper's own default is 0.8. Varying it slightly line by line keeps
 *  consecutive same-shaped announcements ("Palo! …", "Vuorossa …") from being
 *  acoustically identical over a 90-minute match. The 0.75 / 0.95 / 0.85 values
 *  of segment 6 in `experiments/voice-tuning-demo.ts` were listened to on
 *  fi_FI-harri-medium on 9.7.2026 and accepted (see voice-tuning-demo.md,
 *  "Palaute"); this is that range, applied continuously.
 *
 *  Do NOT widen the range and do NOT add `--length_scale` here: the 1.15
 *  slowdown from the same listening session was explicitly REJECTED — it sounds
 *  bad on this voice. Widening `noise_w` (e.g. towards 1.3) is an open question
 *  that needs a human listening test, not a code change. */
export const NOISE_W_MIN = 0.75;
export const NOISE_W_MAX = 0.95;

/** The exact argv the relay runs `piper` with — a pure function so the
 *  inference parameters are testable without spawning the binary. */
export function piperArgs(modelPath: string, outputPath: string, rng: () => number = Math.random): string[] {
  const r = Math.min(Math.max(rng(), 0), 1);
  const noiseW = NOISE_W_MIN + r * (NOISE_W_MAX - NOISE_W_MIN);
  return [
    "--model", modelPath,
    "--output_file", outputPath,
    "--noise_w", noiseW.toFixed(3),
  ];
}

function execFileP(cmd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as unknown as Buffer);
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** Synthesizes Finnish text to 48kHz stereo s16le PCM using the same stock
 *  Piper voice files v2's browser TTS uses, via the upstream `piper` CLI
 *  instead of onnxruntime-web — one synthesis at a time (internal queue),
 *  since `piper` is a one-shot-per-invocation binary, not a server. */
export class PiperTts {
  private queue: Promise<void> = Promise.resolve();

  constructor(private opts: PiperTtsOptions) {}

  synthesize(text: string): Promise<Buffer> {
    const run = this.queue.then(() => this.synthesizeNow(text));
    // Keep the chain alive even if this call rejects, so later calls still run.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async synthesizeNow(text: string): Promise<Buffer> {
    const modelFile = VOICE_FILES[this.opts.voice];
    if (!modelFile) throw new Error(`Unknown voice: ${this.opts.voice}`);
    const modelPath = join(this.opts.voicesDir, modelFile);

    const dir = await mkdtemp(join(tmpdir(), "pesis-relay-tts-"));
    const wavPath = join(dir, "out.wav");
    try {
      await execFileP(this.opts.piperBin, ["--model", modelPath, "--output_file", wavPath], text);
      const pcm = await execFileP("ffmpeg", ["-y", "-i", wavPath, "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"]);
      return pcm;
    } catch (err) {
      logError("tts.piper_failed", `Piper-synteesivirhe: ${err instanceof Error ? err.message : err}`);
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
