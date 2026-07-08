import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./log.js";
import { NarrationFifo } from "./narrationFifo.js";
import { resolveSourceUrl } from "./ytdlpSource.js";

export interface FfmpegMixerOptions {
  youtubeUrl: string;
  rtmpUrl: string;
  streamKey: string;
  narrationGain: number;
  fifoPath: string;
  /** Force a respawn on this cadence even if ffmpeg looks healthy, so a
   *  rotated source URL gets picked up (default 15 min). */
  urlRefreshMs?: number;
}

function buildFfmpegArgs(sourceUrl: string, opts: FfmpegMixerOptions): string[] {
  const rtmpDest = `${opts.rtmpUrl.replace(/\/$/, "")}/${opts.streamKey}`;
  return [
    "-nostdin",
    "-loglevel", "warning",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-reconnect_at_eof", "1",
    "-thread_queue_size", "4096",
    "-i", sourceUrl,
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-thread_queue_size", "4096",
    "-i", opts.fifoPath,
    "-filter_complex",
    `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[orig];` +
      `[1:a]volume=${opts.narrationGain}[narr];` +
      `[orig][narr]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-f", "flv", rtmpDest,
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Supervises the long-running ffmpeg pull+mix+republish process: resolves a
 *  fresh source URL and respawns with exponential backoff whenever ffmpeg
 *  exits (crash, source URL rotation, RTMP drop — ffmpeg has no automatic
 *  reconnect for the RTMP push side, so any exit means a full respawn). */
export class FfmpegMixer {
  private fifo: NarrationFifo;
  private child: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private opts: FfmpegMixerOptions) {
    this.fifo = new NarrationFifo(opts.fifoPath);
  }

  enqueueNarration(pcm: Buffer): void {
    this.fifo.enqueue(pcm);
  }

  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.spawnOnce();
      } catch (err) {
        log(`ffmpeg-käynnistysvirhe: ${err instanceof Error ? err.message : err}`);
      }
      if (this.stopped) break;
      log(`Uudelleenyritys ${this.backoffMs}ms kuluttua…`);
      await delay(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.fifo.stop();
    this.child?.kill("SIGTERM");
  }

  private async spawnOnce(): Promise<void> {
    log("Haetaan lähdeosoite yt-dlp:llä…");
    const sourceUrl = await resolveSourceUrl(this.opts.youtubeUrl);

    // Must exist before ffmpeg is spawned, and before fifo.open() (which
    // blocks until ffmpeg attaches as a reader) — see narrationFifo.ts.
    await this.fifo.prepare();

    log("Käynnistetään ffmpeg…");
    const args = buildFfmpegArgs(sourceUrl, this.opts);
    this.child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    this.child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

    await this.fifo.open();

    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      this.child!.once("exit", (code, signal) => {
        this.fifo.closeIo();
        const ranMs = Date.now() - startedAt;
        if (ranMs > 60000) this.backoffMs = 1000; // reset backoff after a healthy run
        log(`ffmpeg päättyi (code=${code}, signal=${signal}), ajoaika ${Math.round(ranMs / 1000)}s`);
        resolve();
      });

      const refreshMs = this.opts.urlRefreshMs ?? 15 * 60 * 1000;
      this.refreshTimer = setTimeout(() => {
        log("Määräaikainen URL-päivitys — käynnistetään ffmpeg uudelleen.");
        this.child?.kill("SIGTERM");
      }, refreshMs);
    });

    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}
