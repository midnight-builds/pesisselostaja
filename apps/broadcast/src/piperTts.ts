import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

const VOICE_FILES: Record<string, string> = {
  "harri-medium": "fi_FI-harri-medium.onnx",
  "harri-low": "fi_FI-harri-low.onnx",
  "asmo-medium": "fi_FI-asmo-medium.onnx",
};

export interface PiperTtsOptions {
  piperBin: string;
  voice: string;
  voicesDir: string;
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
      log(`Piper-synteesivirhe: ${err instanceof Error ? err.message : err}`);
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
