import { execFile } from "node:child_process";
import { closeSync, constants, createWriteStream, openSync, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { logError, logWarn } from "./log.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * FRAME_MS) / 1000; // 3840
/** ~700 ms of silence between consecutive clips, so narration bursts (several
 *  events announced in one poll) don't run together into one long sentence. */
const CLIP_GAP_FRAMES = 700 / FRAME_MS;
/** Kuinka kauan herätyslukupäätä pidetään auki, jos jumissa ollut avaus ei
 *  ehdi valmistua heti. Ks. releaseBlockedOpen. */
const OPEN_RELEASE_HOLD_MS = 250;

function mkfifo(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("mkfifo", [path], (err) => (err ? reject(err) : resolve()));
  });
}

/** Whether a clip may be dropped when the queue is over its ceiling (#57).
 *
 *  **`critical` is the default on purpose.** An announcement nobody classified
 *  is one nobody thought about, and the failure of guessing wrong is asymmetric:
 *  a run that never got spoken is a hole in the broadcast, while an extra
 *  batter-change line is a few seconds of lag. Only what is explicitly known to
 *  be skippable — fillers, periodic summaries, batter changes — is marked
 *  droppable. */
export type ClipPriority = "critical" | "droppable";

interface QueuedClip {
  pcm: Buffer;
  priority: ClipPriority;
}

/** What enforcing the ceiling had to throw away. */
export interface QueueDrop {
  droppedClips: number;
  droppedFrames: number;
  /** Frames still over the ceiling after dropping everything droppable — i.e.
   *  a backlog made entirely of announcements too important to cut. Non-zero
   *  means the cap did NOT bring the queue down, and the operator should hear
   *  about it rather than see a cap that silently failed. */
  overFrames: number;
}

/** Pure frame-slicing logic, split out from NarrationFifo's I/O so it can be
 *  unit-tested without a real pipe/ffmpeg. Clips never bleed into each
 *  other: a clip's final partial frame is padded with silence rather than
 *  reading into the next queued clip, and `gapFrames` of silence separate
 *  consecutive clips so back-to-back announcements stay distinguishable. */
export class NarrationQueue {
  private queue: QueuedClip[] = [];
  private offset = 0;
  private gapRemaining = 0;

  /** @param maxQueuedFrames Backlog ceiling in 20 ms frames, or 0 for none.
   *  Frames rather than milliseconds so this class stays free of a sample rate
   *  it does not otherwise need; NarrationFifo converts. */
  constructor(
    private frameBytes: number,
    private gapFrames = 0,
    private maxQueuedFrames = 0
  ) {}

  /** Queues a clip and enforces the backlog ceiling (issue #57).
   *
   *  Returns what had to be dropped, or null when nothing did — the caller
   *  logs it, because a silently shortened broadcast is worse than a long one.
   *
   *  **The OLDEST droppable clip goes first**, not the newest. In a burst the
   *  oldest clip is the most stale: it describes a game state the viewer has
   *  already watched go past, while the newest describes what is on screen
   *  now. Dropping from the other end would keep the narration reciting
   *  history and never let it catch up. */
  enqueue(pcm: Buffer, priority: ClipPriority = "critical"): QueueDrop | null {
    this.queue.push({ pcm, priority });
    return this.enforceCap();
  }

  get pendingClips(): number {
    return this.queue.length;
  }

  /** Frames still to be played, the partially played head counted from where
   *  playback actually is. Inter-clip gaps are NOT counted: they are 700 ms of
   *  padding the listener hears as breathing room, and counting them would
   *  make the ceiling tighten as the queue grows. */
  get pendingFrames(): number {
    let frames = 0;
    for (const [i, clip] of this.queue.entries()) {
      const remaining = clip.pcm.length - (i === 0 ? this.offset : 0);
      if (remaining > 0) frames += Math.ceil(remaining / this.frameBytes);
    }
    return frames;
  }

  private enforceCap(): QueueDrop | null {
    if (this.maxQueuedFrames <= 0) return null;
    let droppedClips = 0;
    let droppedFrames = 0;
    // `length > 1`: the ceiling governs a BACKLOG, and one clip is not a
    // backlog. A single announcement longer than the ceiling (a long summary
    // against a tight setting) must still be spoken in full — dropping it
    // would mean the queue silently ate the only thing in it.
    while (this.queue.length > 1 && this.pendingFrames > this.maxQueuedFrames) {
      const index = this.queue.findIndex(
        // Never the clip that is already playing: cutting it mid-word is the
        // very defect #67 is about, and a cap must not create one.
        (clip, i) => clip.priority === "droppable" && !(i === 0 && this.offset > 0)
      );
      if (index < 0) break; // Everything left is critical — over the cap on purpose.
      const [dropped] = this.queue.splice(index, 1) as [QueuedClip];
      droppedClips++;
      droppedFrames += Math.ceil(dropped.pcm.length / this.frameBytes);
      // Dropping the clip that was about to start (index 0, offset 0) leaves a
      // gap armed for a clip that no longer exists; the next nextFrame() call
      // simply plays it as silence, which is the correct sound for "nothing to
      // say right now".
    }
    if (droppedClips === 0) return null;
    return { droppedClips, droppedFrames, overFrames: Math.max(0, this.pendingFrames - this.maxQueuedFrames) };
  }

  nextFrame(): Buffer {
    for (;;) {
      if (this.gapRemaining > 0) {
        this.gapRemaining--;
        return Buffer.alloc(this.frameBytes);
      }
      const head = this.queue[0]?.pcm;
      if (!head) return Buffer.alloc(this.frameBytes);
      const remaining = head.length - this.offset;
      if (remaining <= 0) {
        this.finishClip();
        continue;
      }
      if (remaining >= this.frameBytes) {
        const frame = head.subarray(this.offset, this.offset + this.frameBytes);
        this.offset += this.frameBytes;
        return frame;
      }
      const frame = Buffer.alloc(this.frameBytes);
      head.copy(frame, 0, this.offset);
      this.finishClip();
      return frame;
    }
  }

  /** The gap applies only between clips: it is armed when a finished clip
   *  already has a successor queued, never after the last clip (where the
   *  perpetual silence is the gap). */
  private finishClip(): void {
    this.queue.shift();
    this.offset = 0;
    if (this.queue.length > 0) this.gapRemaining = this.gapFrames;
  }
}

/** Owns a named pipe that ffmpeg reads as a raw PCM input, and a perpetual
 *  20ms-frame writer that never stops: silence when nothing is queued,
 *  queued narration audio otherwise. ffmpeg's `amix` needs data from every
 *  input to produce output, so this pipe must never starve it — see
 *  apps/broadcast/DESIGN.md for why an on-demand pusher would stall the whole
 *  filter graph instead. */
export class NarrationFifo {
  private stream: WriteStream | null = null;
  private queue: NarrationQueue;
  private timer: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private startTime = 0;
  private stopped = false;
  /** Ei-null vain niin kauan kuin open() odottaa kernelin avausta. stopIo()
   *  käyttää tätä sekä tunnisteena ("avaus on yhä jumissa") että keinona
   *  päättää roikkuva open()-lupaus. */
  private abortOpen: (() => void) | null = null;

  /** @param maxQueuedMs Backlog ceiling in milliseconds of queued audio, or 0
   *  to keep the old unbounded behaviour (#57). */
  constructor(public readonly path: string, maxQueuedMs = 0) {
    this.queue = new NarrationQueue(FRAME_BYTES, CLIP_GAP_FRAMES, Math.max(0, Math.floor(maxQueuedMs / FRAME_MS)));
  }

  /** Creates the named pipe file. Must complete BEFORE ffmpeg is spawned
   *  (ffmpeg errors immediately if the path doesn't exist yet), and BEFORE
   *  calling open() (see below). */
  async prepare(): Promise<void> {
    await unlink(this.path).catch(() => undefined);
    await mkfifo(this.path);
  }

  /** Opens the pipe for writing and starts the perpetual tick loop. This
   *  blocks until a reader attaches — so it must be called AFTER ffmpeg has
   *  been spawned with this path as one of its -i inputs, never before. */
  async open(): Promise<void> {
    const stream = createWriteStream(this.path);
    this.stream = stream;
    const outcome = await new Promise<"open" | "aborted" | Error>((resolve) => {
      stream.once("open", () => resolve("open"));
      stream.once("error", (err: Error) => resolve(err));
      this.abortOpen = () => resolve("aborted");
    });
    this.abortOpen = null;

    // closeIo()/stop() ehti väliin: stopIo() omistaa nyt streamin, on jo
    // kutsunut end():n ja vapauttanut kernelissä roikkuneen avauksen. Ei
    // tikitystä eikä poikkeusta — molemmat kutsupaikat (ffmpegMixer) ovat
    // hylänneet tämän lupauksen Promise.racessa, ja heitto muuttuisi
    // käsittelemättömäksi rejectioniksi kesken lähetyksen.
    if (outcome === "aborted" || this.stream !== stream) {
      logWarn("fifo.open_aborted", "FIFO-avaus keskeytettiin ennen lukijan liittymistä.");
      return;
    }
    if (outcome !== "open") throw outcome;

    stream.on("error", (err) => logError("fifo.write_failed", `FIFO-kirjoitusvirhe: ${err.message}`));

    this.stopped = false;
    this.tickCount = 0;
    this.startTime = Date.now();
    this.scheduleNextTick();
  }

  /** Queue narration PCM (already 48kHz/stereo/s16le) for playback, in order.
   *  Returns what the backlog ceiling had to drop, or null when nothing did. */
  enqueue(pcm: Buffer, priority: ClipPriority = "critical"): QueueDrop | null {
    return this.queue.enqueue(pcm, priority);
  }

  /** Milliseconds of narration still waiting to be heard. */
  get pendingMs(): number {
    return this.queue.pendingFrames * FRAME_MS;
  }

  /** Clips still queued (not yet handed to the write stream). Used to let a
   *  scheduled ffmpeg respawn wait for a natural gap instead of severing
   *  mid-sentence — see FfmpegMixer's refresh handling. */
  get pendingClips(): number {
    return this.queue.pendingClips;
  }

  /** Tears down the current pipe's I/O without touching the queue, so
   *  pending narration survives a respawn. Caller must prepare()+open()
   *  again around the fresh ffmpeg process. */
  closeIo(): void {
    this.stopIo();
  }

  stop(): void {
    this.stopped = true;
    this.stopIo();
  }

  private stopIo(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;

    // Avaus on yhä jumissa kernelissä (abortOpen elää vain open():n odotuksen
    // ajan). end() ei peru sitä: pyyntö istuu yhdessä libuvin neljästä
    // säiepoolisäikeestä, ja katvekuvasilmukka toistaa tämän kierros
    // kierrokselta, kunnes kaikki fs-operaatiot roikkuvat (#274).
    const blockedOpen = this.abortOpen;
    this.abortOpen = null;
    stream.end();
    if (blockedOpen) {
      this.releaseBlockedOpen(stream);
      blockedOpen();
    }
  }

  /** Herättää kirjoitusavauksen, joka odottaa kernelissä lukijaa.
   *
   *  `openSync(O_RDONLY|O_NONBLOCK)` palaa FIFOlla heti ilman kirjoittajaa
   *  eikä käytä säiepoolia (se on synkroninen), mutta lukijan ilmestyminen
   *  riittää päästämään jumissa olevan kirjoitusavauksen läpi — jolloin sen
   *  säiepoolisäie vapautuu. Sama temppu kuin testiharnessissa (PR #272).
   *
   *  Lukupää pidetään auki kunnes avaus on oikeasti valmistunut, koska
   *  välitön sulkeminen voi ehtiä ennen herätystä ja jättää kirjoittajan
   *  takaisin odottamaan. Kutsutaan VAIN kun avaus ei ollut vielä auennut,
   *  joten se ei koskaan häiritse käynnissä olevaa kirjoitusta. */
  private releaseBlockedOpen(stream: WriteStream): void {
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
      return; // FIFOa ei ole (tai se ei aukea) — ei mitään herätettävää.
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        /* jo suljettu */
      }
    };
    stream.once("open", release);
    stream.once("error", release);
    setTimeout(release, OPEN_RELEASE_HOLD_MS).unref();
  }

  private scheduleNextTick(): void {
    const targetTime = this.startTime + this.tickCount * FRAME_MS;
    const delay = Math.max(0, targetTime - Date.now());
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    if (this.stopped || !this.stream) return;
    this.tickCount++;

    const frame = this.queue.nextFrame();
    this.stream.write(frame, (err) => {
      if (err) logWarn("fifo.tick_failed", `FIFO-tick-virhe: ${err.message}`);
    });

    this.scheduleNextTick();
  }
}

export const FIFO_FRAME_BYTES = FRAME_BYTES;
