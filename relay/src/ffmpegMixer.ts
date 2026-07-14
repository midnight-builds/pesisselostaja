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
  /** Give up and stop retrying after this many milliseconds of unbroken
   *  start-up failures — protects against retrying forever once the source
   *  broadcast has genuinely ended (default 5 min). */
  maxFailureWindowMs?: number;
  /** Local-file test mode: write the mixed result to this path instead of
   *  pushing RTMP, so the mix can be reviewed before a second broadcast
   *  exists. Takes precedence over rtmpUrl/streamKey when set. */
  recordFile?: string;
}

/** Shared amix/limiter graph: original audio (input 0) + gained narration
 *  (input 1) -> [aout]. Used both by the live RTMP mixer and simulate.ts's
 *  offline replay, so the two stay acoustically identical. */
export function buildMixFilterComplex(narrationGain: number): string {
  return (
    `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[orig];` +
    `[1:a]volume=${narrationGain}[narr];` +
    `[orig][narr]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
  );
}

function buildFfmpegArgs(sourceUrl: string, opts: FfmpegMixerOptions): string[] {
  const args = [
    "-nostdin",
    "-y",
    "-loglevel", "warning",
    "-thread_queue_size", "4096",
    "-i", sourceUrl,
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-thread_queue_size", "4096",
    "-i", opts.fifoPath,
    "-filter_complex", buildMixFilterComplex(opts.narrationGain),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  ];
  if (opts.recordFile) {
    // Fragmented mp4 stays playable even if the process is killed mid-write
    // (no trailing moov atom to lose), unlike a plain -f mp4 output.
    args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", opts.recordFile);
  } else {
    const rtmpDest = `${opts.rtmpUrl.replace(/\/$/, "")}/${opts.streamKey}`;
    args.push("-f", "flv", rtmpDest);
  }
  return args;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** How often to emit a liveness line during an otherwise quiet healthy run,
 *  so a long eventless stretch is distinguishable from a hang in the logs. */
const HEARTBEAT_MS = 2 * 60 * 1000;

/** Thrown once resolveSourceUrl/ffmpeg-start has failed continuously for too
 *  long — signals the original broadcast is gone for good (not a transient
 *  network blip), so the caller should stop retrying and shut the relay down
 *  instead of hammering yt-dlp every 30s forever. */
export class SourceExhaustedError extends Error {}

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
  /** When the current unbroken run of start-up failures began, or null if
   *  the last attempt succeeded. Used to give up after maxFailureWindowMs. */
  private failingSince: number | null = null;
  private readonly maxFailureWindowMs: number;

  constructor(private opts: FfmpegMixerOptions) {
    this.fifo = new NarrationFifo(opts.fifoPath);
    this.maxFailureWindowMs = opts.maxFailureWindowMs ?? 5 * 60 * 1000;
  }

  enqueueNarration(pcm: Buffer): void {
    this.fifo.enqueue(pcm);
  }

  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.spawnOnce();
        this.failingSince = null;
      } catch (err) {
        log(`ffmpeg-käynnistysvirhe: ${err instanceof Error ? err.message : err}`);
        if (this.failingSince === null) this.failingSince = Date.now();
        if (Date.now() - this.failingSince > this.maxFailureWindowMs) {
          this.stopped = true;
          throw new SourceExhaustedError(
            `Lähde ei ole vastannut ${Math.round(this.maxFailureWindowMs / 60000)} minuuttiin — luovutetaan.`
          );
        }
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

    // Covers both a normal exit and a failed spawn (bad binary/args): if
    // spawn() itself fails, Node emits "error" but never "exit", so without
    // this the supervisor would hang forever awaiting an exit that never
    // comes — no backoff, no log, stuck silently.
    const startedAt = Date.now();
    const childDone = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      this.child!.once("error", (err) => resolve({ code: null, signal: null, error: err }));
      this.child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const raceResult = await Promise.race([
      this.fifo.open().then(() => "opened" as const),
      childDone.then(() => "died" as const),
    ]);

    if (raceResult === "died") {
      // ffmpeg died before the FIFO handshake even completed — the pending
      // open() call will never get a reader now; drop it rather than await it.
      this.fifo.closeIo();
      const result = await childDone;
      const detail = result.error ? result.error.message : `code=${result.code}, signal=${result.signal}`;
      throw new Error(`ffmpeg ei käynnistynyt: ${detail}`);
    }

    const refreshMs = this.opts.urlRefreshMs ?? 15 * 60 * 1000;
    const childForRefresh = this.child;
    this.refreshTimer = setTimeout(() => {
      void this.killForRefresh(childForRefresh);
    }, refreshMs);

    // Liveness heartbeat: during a healthy run with no pesäpallo events for
    // minutes there is otherwise nothing in the log, so "still alive" and
    // "silently hung" look identical. Cleared on exit below.
    const heartbeat = setInterval(() => {
      const up = Math.round((Date.now() - startedAt) / 1000);
      log(`Sydänääni: relay käynnissä ${up}s, selostusjonossa ${this.fifo.pendingClips} klippiä.`);
    }, HEARTBEAT_MS);

    const result = await childDone;
    clearInterval(heartbeat);
    this.fifo.closeIo();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const ranMs = Date.now() - startedAt;
    if (ranMs > 60000) this.backoffMs = 1000; // reset backoff after a healthy run
    const detail = result.error ? result.error.message : `code=${result.code}, signal=${result.signal}`;
    log(`ffmpeg päättyi (${detail}), ajoaika ${Math.round(ranMs / 1000)}s`);
  }

  /** Waits for a natural gap in the narration before killing ffmpeg for a
   *  scheduled URL refresh, so a respawn doesn't cut off a clip mid-word.
   *  ffmpeg crashes/RTMP drops still die immediately (unavoidable) — this
   *  only guards the respawn we schedule ourselves. Bounded so a refresh
   *  can't be postponed forever by back-to-back announcements. */
  private async killForRefresh(childToKill: ChildProcess | null): Promise<void> {
    if (!childToKill || childToKill !== this.child) return;
    const pendingAtStart = this.fifo.pendingClips;
    const waitStart = Date.now();
    const deadline = waitStart + 10000;
    while (this.fifo.pendingClips > 0 && Date.now() < deadline && !this.stopped && this.child === childToKill) {
      await delay(200);
    }
    if (this.stopped || this.child !== childToKill) return;
    // Give ffmpeg a moment to actually drain what's already sitting in the
    // pipe buffer before we pull it out from under it.
    await delay(500);
    if (this.stopped || this.child !== childToKill) return;
    const waited = Date.now() - waitStart;
    const remaining = this.fifo.pendingClips;
    // Whether the queue actually drained is the evidence that the respawn
    // didn't sever a clip mid-word (relay/HANDOFF.md fix #2): "tyhjeni" =
    // clean gap, "EI tyhjentynyt" = the 10s bound cut it off anyway.
    const drainStatus =
      remaining === 0 ? "tyhjeni" : `EI tyhjentynyt (${remaining} klippiä jäljellä, 10s katkaisu)`;
    log(
      `Määräaikainen URL-päivitys — käynnistetään ffmpeg uudelleen. ` +
        `Selostusjono ${drainStatus}; odotettiin ${waited}ms, jonossa ${pendingAtStart} klippiä respawnin alkaessa.`
    );
    childToKill.kill("SIGTERM");
  }
}
