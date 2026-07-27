import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./log.js";
import { NarrationFifo } from "./narrationFifo.js";
import { resolveSourceUrl, SourceNotLiveYetError } from "./ytdlpSource.js";

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
   *  unproductive attempts — a start-up failure, or a session that died in
   *  under minProductiveRunMs — which protects against retrying forever once
   *  the source broadcast has genuinely ended (default 5 min). */
  maxFailureWindowMs?: number;
  /** Shorter give-up window used in place of maxFailureWindowMs while
   *  isMatchFinished() reports true — after "Ottelu päättyi" a dead source
   *  won't come back, so waiting the full generous window only delays
   *  cleanup (default 2 min). Applies to the same unproductive-attempt
   *  accounting. */
  finishedFailureWindowMs?: number;
  /** Shortest ffmpeg run that counts as the source actually producing
   *  broadcast (default 60 s). A session that ends sooner is counted as a
   *  failed attempt even when ffmpeg exited cleanly with code=0 — see
   *  minProductiveRunMs below / issue #45. */
  minProductiveRunMs?: number;
  /** Lets the supervisor know the match has ended (the commentary loop owns
   *  that state), for finishedFailureWindowMs. Absent → always false. */
  isMatchFinished?: () => boolean;
  /** Extra fragment appended to the heartbeat line — the commentary loop's
   *  poll statistics (HANDOFF.md 17.7.), since 304 skips and full-fetch
   *  fallbacks are otherwise invisible in the log. Absent → plain heartbeat. */
  heartbeatExtra?: () => string;
  /** Local-file test mode: write the mixed result to this path instead of
   *  pushing RTMP, so the mix can be reviewed before a second broadcast
   *  exists. Takes precedence over rtmpUrl/streamKey when set. Each spawn
   *  gets its own session-indexed filename (foo.mp4 -> foo.session0.mp4,
   *  foo.session1.mp4, …) since every respawn starts a fresh ffmpeg process
   *  that would otherwise overwrite (-y) the previous session's recording. */
  recordFile?: string;
  /** Test-only: when set, skips resolveSourceUrl/yt-dlp entirely and calls
   *  this instead to get the -i source for each spawn attempt (a function,
   *  not a static string, so a harness can vary the source per respawn —
   *  e.g. a longer fixture on one respawn to test amix's short-session
   *  behaviour). The source is read with -re (native rate) rather than the
   *  production reconnect/http-persistent flags, since those are HTTP/HLS-
   *  specific and meaningless (at best) against a local file. Never set in
   *  production — see apps/broadcast/docs/adr/0001-ffmpeg-mixer-test-source-seam.md. */
  resolveTestSource?: () => Promise<string> | string;
  /** Test-only: fired with the wall-clock epoch once a session's FIFO
   *  handshake completes, so a harness can align its own timers to actual
   *  session boundaries instead of parsing log text. */
  onSessionStart?: (epochMs: number) => void;
  /** Test-only: fired once a session's ffmpeg process has exited. */
  onSessionEnd?: (epochMs: number, ranMs: number) => void;
  /** Test-only: spawns the mixing process in place of ffmpeg, given the exact
   *  argv the real ffmpeg would have received. Lets a test drive the whole
   *  supervisor loop — FIFO handshake, session accounting, respawn, give-up —
   *  with a stand-in process whose lifetime and exit code it controls, without
   *  any ffmpeg binary or real broadcast. Never set in production; see
   *  apps/broadcast/docs/adr/0002-ffmpeg-mixer-process-seam.md. */
  spawnMixerProcess?: (args: string[]) => ChildProcess;
}

/** A finished ffmpeg session, as reported back to the supervisor loop. */
interface SessionResult {
  /** Monotonic milliseconds from spawn to process exit. */
  ranMs: number;
  /** True when *we* ended the session on purpose (scheduled URL refresh), so
   *  its length says nothing about the source's health. */
  refreshKill: boolean;
}

/** foo.mp4 -> foo.session3.mp4, so successive respawns never overwrite each
 *  other's recording. Exported so a test harness can compute the exact same
 *  filename FfmpegMixer wrote, without duplicating the naming rule. */
export function indexedRecordPath(recordFile: string, index: number): string {
  const m = recordFile.match(/^(.*?)(\.[^./]+)?$/);
  const base = m?.[1] ?? recordFile;
  const ext = m?.[2] ?? "";
  return `${base}.session${index}${ext}`;
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

function buildFfmpegArgs(
  sourceUrl: string,
  opts: FfmpegMixerOptions,
  recordFilePath: string | undefined,
  realtimeSource: boolean
): string[] {
  const args = ["-nostdin", "-y", "-loglevel", "warning", "-thread_queue_size", "4096"];
  if (realtimeSource) {
    // Test-only local-file source (see resolveTestSource): without -re
    // ffmpeg reads the file as fast as disk/CPU allow instead of at its real
    // playback rate, which would collapse the "frozen DVR window" cadence
    // we're deliberately reproducing and desync it from the FIFO's
    // real-time narration clock.
    args.push("-re");
  } else {
    // SOURCE input only (options apply to the -i that follows). The source is a
    // YouTube HLS pull, and YouTube rotates the CDN host inside the playlist;
    // ffmpeg's default -http_persistent 1 then tries to reuse a keepalive
    // connection against a different host, fails, and floods the log with
    // "Cannot reuse HTTP connection for different host" + "keepalive request
    // failed … retrying" every ~5s segment. Disabling persistent HTTP silences
    // that with no functional downside (source stayed real-time in testing);
    // the reconnect flags harden the pull against brief source blips.
    args.push(
      "-http_persistent", "0",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"
    );
  }
  args.push(
    "-i", sourceUrl,
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-thread_queue_size", "4096",
    "-i", opts.fifoPath,
    "-filter_complex", buildMixFilterComplex(opts.narrationGain),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  );
  if (recordFilePath) {
    // Fragmented mp4 stays playable even if the process is killed mid-write
    // (no trailing moov atom to lose), unlike a plain -f mp4 output.
    args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", recordFilePath);
  } else {
    const rtmpDest = `${opts.rtmpUrl.replace(/\/$/, "")}/${opts.streamKey}`;
    args.push("-f", "flv", rtmpDest);
  }
  return args;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Monotonic milliseconds. Every *duration* the supervisor measures uses this
 *  rather than Date.now(): an NTP step backwards would otherwise make a
 *  healthy hour-long session look like a seconds-long failed one (→ false
 *  self-shutdown), and a step forwards could blow through the give-up window
 *  in one tick. Wall-clock time is kept only where an actual epoch is reported
 *  outward (firstAttachedAt, onSessionStart/onSessionEnd). */
function monoNow(): number {
  return performance.now();
}

/** How often to emit a liveness line during an otherwise quiet healthy run,
 *  so a long eventless stretch is distinguishable from a hang in the logs. */
const HEARTBEAT_MS = 2 * 60 * 1000;

/** Thrown once resolveSourceUrl/ffmpeg-start has failed continuously for too
 *  long — signals the original broadcast is gone for good (not a transient
 *  network blip), so the caller should stop retrying and shut the relay down
 *  instead of hammering yt-dlp every 30s forever. */
export class SourceExhaustedError extends Error {}

/** Total time a merely-*scheduled* source may keep not starting before the
 *  relay gives up anyway. Waiting is the right default — YouTube is telling us
 *  the broadcast exists — but an unbounded wait would leave a forgotten relay
 *  polling yt-dlp for days if the broadcaster silently cancels. */
const SCHEDULED_WAIT_MAX_MS = 3 * 60 * 60 * 1000;
/** Re-check cadence while waiting for a scheduled start: aim to land ~20 s
 *  before the announced time, but never sleep longer than this (YouTube's
 *  estimate moves, and a far-off start shouldn't mean hammering yt-dlp). */
const SCHEDULED_RECHECK_MAX_MS = 5 * 60 * 1000;
const SCHEDULED_RECHECK_MIN_MS = 5000;

/** How long to wait before asking yt-dlp again about a scheduled source. */
export function scheduledRecheckDelayMs(startsInMs: number | null): number {
  if (startsInMs === null) return SCHEDULED_RECHECK_MAX_MS;
  return Math.min(Math.max(startsInMs - 20_000, SCHEDULED_RECHECK_MIN_MS), SCHEDULED_RECHECK_MAX_MS);
}

function formatEta(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return mins >= 1 ? `${mins} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
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
  /** When the current unbroken run of *unproductive* attempts began, or null
   *  if the source has since produced a real run. Used to give up after
   *  maxFailureWindowMs. An attempt is unproductive when it either never
   *  started (yt-dlp/ffmpeg start-up failure) or started and then ended in
   *  under minProductiveRunMs. A successful *start* on its own must never
   *  clear this: when the source device dies mid-match (issue #45) yt-dlp
   *  keeps handing out a valid URL, every spawn succeeds, and ffmpeg exits
   *  cleanly (code=0) seconds later — an endless respawn loop in which the
   *  old "reset on any successful spawn" rule meant the window never accrued
   *  and the relay never shut itself down. */
  private failingSince: number | null = null;
  private readonly maxFailureWindowMs: number;
  /** Shortest run that counts as the source actually producing broadcast.
   *  Chosen well above a respawn's start-up cost but well below any believable
   *  broadcast segment (the scheduled URL refresh runs every 15 min, and is
   *  exempt from this accounting anyway), because a false give-up mid-match is
   *  worse than a relay left standing. */
  private readonly minProductiveRunMs: number;
  /** Set while a kill we requested ourselves (URL refresh) is in flight, so
   *  the resulting short session isn't mistaken for a dying source. */
  private refreshKillRequested = false;
  /** Counts spawn attempts so recordFile can be indexed per session. */
  private sessionIndex = 0;
  /** True only while an ffmpeg session is attached as a FIFO reader (between a
   *  completed handshake and the process exiting). */
  private sessionActive = false;
  /** Wall clock of the FIRST completed FIFO handshake ever, never reset —
   *  the commentary loop's first-speech grace period (RELAY_FIRST_SPEECH_DELAY_MS)
   *  is measured from this, so respawns don't restart the wait. */
  private firstAttachedAtMs: number | null = null;
  /** When the current unbroken run of "scheduled, not live yet" answers began,
   *  or null if the source has since responded some other way. Bounds the wait
   *  via SCHEDULED_WAIT_MAX_MS. */
  private scheduledSince: number | null = null;

  constructor(private opts: FfmpegMixerOptions) {
    this.fifo = new NarrationFifo(opts.fifoPath);
    this.maxFailureWindowMs = opts.maxFailureWindowMs ?? 5 * 60 * 1000;
    this.minProductiveRunMs = opts.minProductiveRunMs ?? 60 * 1000;
  }

  enqueueNarration(pcm: Buffer): void {
    this.fifo.enqueue(pcm);
  }

  /** True while ffmpeg is attached and reading the FIFO, i.e. queued narration
   *  actually drains in real time. The commentary loop reads this to avoid
   *  synthesizing pre-game filler nobody would hear yet — otherwise those
   *  welcome clips pile up in the FIFO before ffmpeg attaches and all play
   *  back-to-back on connect (HANDOFF.md 7). */
  get isReaderAttached(): boolean {
    return this.sessionActive;
  }

  /** Narration clips still waiting in the FIFO queue (not yet handed to the
   *  write stream). */
  get pendingClips(): number {
    return this.fifo.pendingClips;
  }

  /** Wall clock of the first time ffmpeg ever attached as a FIFO reader, or
   *  null before that. Never reset across respawns. */
  get firstAttachedAt(): number | null {
    return this.firstAttachedAtMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        const session = await this.spawnOnce();
        this.scheduledSince = null;
        if (this.stopped) break;
        this.noteSessionEnd(session);
      } catch (err) {
        // Our own give-up verdict (from noteSessionEnd above) passes straight
        // through: it is not a start-up failure, and letting it fall into the
        // handling below would log "ffmpeg-käynnistysvirhe" and replace the
        // real reason with the misleading "Lähde ei ole vastannut" wording,
        // even though ffmpeg started every single time.
        if (err instanceof SourceExhaustedError) throw err;
        // A broadcast scheduled to start later is not a failure: YouTube is
        // confirming the source exists. Counting those answers toward the
        // give-up window is what forced starting the relay in a narrow slot
        // just before kickoff (match 144918, 27.7.) — wait instead.
        if (err instanceof SourceNotLiveYetError) {
          if (this.scheduledSince === null) this.scheduledSince = monoNow();
          if (monoNow() - this.scheduledSince > SCHEDULED_WAIT_MAX_MS) {
            this.stopped = true;
            throw new SourceExhaustedError(
              `Lähde on ollut "alkaa pian" -tilassa yli ${Math.round(SCHEDULED_WAIT_MAX_MS / 3600000)} h ` +
                "eikä ole alkanut — luovutetaan."
            );
          }
          this.failingSince = null;
          this.backoffMs = 1000; // fresh backoff for when it does go live
          const waitMs = scheduledRecheckDelayMs(err.startsInMs);
          const eta = err.startsInMs === null ? "" : ` — alkaa noin ${formatEta(err.startsInMs)} kuluttua`;
          log(`Lähde ei ole vielä livenä${eta}. Tarkistetaan uudelleen ${Math.round(waitMs / 1000)} s kuluttua.`);
          await this.interruptibleDelay(waitMs);
          continue;
        }
        this.scheduledSince = null;
        log(`ffmpeg-käynnistysvirhe: ${err instanceof Error ? err.message : err}`);
        this.noteUnproductiveAttempt((mins) => `Lähde ei ole vastannut ${mins} minuuttiin`);
      }
      if (this.stopped) break;
      log(`Uudelleenyritys ${this.backoffMs}ms kuluttua…`);
      await delay(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    }
  }

  /** Judges a finished ffmpeg session: a run long enough to be real broadcast
   *  clears the give-up window (and the backoff). A session that died right
   *  after starting counts as a failed attempt no matter how cleanly ffmpeg
   *  exited — that is exactly the shape of a source whose broadcast has ended
   *  abnormally while yt-dlp still resolves a URL (issue #45).
   *
   *  Order matters: the productive-run check comes FIRST, so a healthy session
   *  that happens to end in our own scheduled URL refresh still clears the
   *  window. In production every healthy session ends that way (urlRefreshMs
   *  15 min > maxFailureWindowMs 12 min), so treating a refresh kill as
   *  neutral up front would mean a once-set failingSince never cleared again
   *  and the next brief blip would shut a perfectly healthy relay down
   *  mid-match. refreshKill only excuses a SHORT session: there the kill, not
   *  the source, is why the run was short. */
  private noteSessionEnd(session: SessionResult): void {
    if (session.ranMs >= this.minProductiveRunMs) {
      this.failingSince = null;
      this.backoffMs = 1000; // fresh backoff after a healthy run
      return;
    }
    if (session.refreshKill) return;
    log(
      `ffmpeg kuoli alle ${Math.round(this.minProductiveRunMs / 1000)} s käynnistyksestä — ` +
        "lasketaan epäonnistuneeksi yritykseksi (lähde ei tuota lähetystä)."
    );
    this.noteUnproductiveAttempt(
      (mins) =>
        `Lähde on käynnistynyt mutta kuollut alle ${Math.round(this.minProductiveRunMs / 1000)} sekunnissa ` +
        `${mins} minuutin ajan`
    );
  }

  /** Records an attempt that produced no broadcast and gives up (throws
   *  SourceExhaustedError, which the caller turns into a relay shutdown) once
   *  the unbroken run of such attempts outlasts the give-up window. A finished
   *  match's source won't come back, so it uses the much shorter window
   *  (HANDOFF.md 16.7. kohta 6.2). */
  private noteUnproductiveAttempt(describe: (windowMins: number) => string): void {
    if (this.failingSince === null) this.failingSince = monoNow();
    const finished = this.opts.isMatchFinished?.() ?? false;
    const windowMs = finished
      ? (this.opts.finishedFailureWindowMs ?? 2 * 60 * 1000)
      : this.maxFailureWindowMs;
    if (monoNow() - this.failingSince > windowMs) {
      this.stopped = true;
      throw new SourceExhaustedError(
        `${describe(Math.round(windowMs / 60000))}${finished ? " ja ottelu on päättynyt" : ""} — luovutetaan.`
      );
    }
  }

  /** Sleeps in short slices so a stop() during a multi-minute scheduled wait
   *  is still honoured within a second — the plain backoff delay is capped at
   *  30 s and can afford to block, this one can't. */
  private async interruptibleDelay(ms: number): Promise<void> {
    const until = monoNow() + ms;
    while (!this.stopped && monoNow() < until) {
      await delay(Math.min(1000, until - monoNow()));
    }
  }

  stop(): void {
    this.stopped = true;
    this.sessionActive = false;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.fifo.stop();
    this.child?.kill("SIGTERM");
  }

  private async spawnOnce(): Promise<SessionResult> {
    this.refreshKillRequested = false;
    const sourceUrl = this.opts.resolveTestSource
      ? await this.opts.resolveTestSource()
      : await (async () => {
          log("Haetaan lähdeosoite yt-dlp:llä…");
          return resolveSourceUrl(this.opts.youtubeUrl);
        })();

    // Must exist before ffmpeg is spawned, and before fifo.open() (which
    // blocks until ffmpeg attaches as a reader) — see narrationFifo.ts.
    await this.fifo.prepare();

    log("Käynnistetään ffmpeg…");
    const recordFilePath = this.opts.recordFile
      ? indexedRecordPath(this.opts.recordFile, this.sessionIndex++)
      : undefined;
    const args = buildFfmpegArgs(sourceUrl, this.opts, recordFilePath, !!this.opts.resolveTestSource);
    this.child = this.opts.spawnMixerProcess
      ? this.opts.spawnMixerProcess(args)
      : spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    this.child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

    // Covers both a normal exit and a failed spawn (bad binary/args): if
    // spawn() itself fails, Node emits "error" but never "exit", so without
    // this the supervisor would hang forever awaiting an exit that never
    // comes — no backoff, no log, stuck silently.
    const startedAt = monoNow();
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

    this.sessionActive = true;
    if (this.firstAttachedAtMs === null) this.firstAttachedAtMs = Date.now();
    this.opts.onSessionStart?.(Date.now());

    const refreshMs = this.opts.urlRefreshMs ?? 15 * 60 * 1000;
    const childForRefresh = this.child;
    this.refreshTimer = setTimeout(() => {
      void this.killForRefresh(childForRefresh);
    }, refreshMs);

    // Liveness heartbeat: during a healthy run with no pesäpallo events for
    // minutes there is otherwise nothing in the log, so "still alive" and
    // "silently hung" look identical. Cleared on exit below.
    const heartbeat = setInterval(() => {
      const up = Math.round((monoNow() - startedAt) / 1000);
      const extra = this.opts.heartbeatExtra?.();
      log(`Sydänääni: relay käynnissä ${up}s, selostusjonossa ${this.fifo.pendingClips} klippiä${extra ? `, ${extra}` : ""}.`);
    }, HEARTBEAT_MS);

    const result = await childDone;
    this.sessionActive = false;
    clearInterval(heartbeat);
    this.fifo.closeIo();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const ranMs = monoNow() - startedAt;
    const detail = result.error ? result.error.message : `code=${result.code}, signal=${result.signal}`;
    log(`ffmpeg päättyi (${detail}), ajoaika ${Math.round(ranMs / 1000)}s`);
    this.opts.onSessionEnd?.(Date.now(), ranMs);
    // The caller judges the run (noteSessionEnd): backoff and give-up window
    // both hang off whether this was real broadcast, not off the exit code.
    return { ranMs, refreshKill: this.refreshKillRequested };
  }

  /** Waits for a natural gap in the narration before killing ffmpeg for a
   *  scheduled URL refresh, so a respawn doesn't cut off a clip mid-word.
   *  ffmpeg crashes/RTMP drops still die immediately (unavoidable) — this
   *  only guards the respawn we schedule ourselves. Bounded so a refresh
   *  can't be postponed forever by back-to-back announcements. */
  private async killForRefresh(childToKill: ChildProcess | null): Promise<void> {
    if (!childToKill || childToKill !== this.child) return;
    const pendingAtStart = this.fifo.pendingClips;
    const waitStart = monoNow();
    const deadline = waitStart + 10000;
    while (this.fifo.pendingClips > 0 && monoNow() < deadline && !this.stopped && this.child === childToKill) {
      await delay(200);
    }
    if (this.stopped || this.child !== childToKill) return;
    // Give ffmpeg a moment to actually drain what's already sitting in the
    // pipe buffer before we pull it out from under it.
    await delay(500);
    if (this.stopped || this.child !== childToKill) return;
    const waited = monoNow() - waitStart;
    const remaining = this.fifo.pendingClips;
    // Whether the queue actually drained is the evidence that the respawn
    // didn't sever a clip mid-word (apps/broadcast/HANDOFF.md fix #2): "tyhjeni" =
    // clean gap, "EI tyhjentynyt" = the 10s bound cut it off anyway.
    const drainStatus =
      remaining === 0 ? "tyhjeni" : `EI tyhjentynyt (${remaining} klippiä jäljellä, 10s katkaisu)`;
    log(
      `Määräaikainen URL-päivitys — käynnistetään ffmpeg uudelleen. ` +
        `Selostusjono ${drainStatus}; odotettiin ${waited}ms, jonossa ${pendingAtStart} klippiä respawnin alkaessa.`
    );
    this.refreshKillRequested = true;
    childToKill.kill("SIGTERM");
  }
}
