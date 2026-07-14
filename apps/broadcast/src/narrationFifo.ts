import { execFile } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { log } from "./log.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * FRAME_MS) / 1000; // 3840

function mkfifo(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("mkfifo", [path], (err) => (err ? reject(err) : resolve()));
  });
}

/** Pure frame-slicing logic, split out from NarrationFifo's I/O so it can be
 *  unit-tested without a real pipe/ffmpeg. Clips never bleed into each
 *  other: a clip's final partial frame is padded with silence rather than
 *  reading into the next queued clip. */
export class NarrationQueue {
  private queue: Buffer[] = [];
  private offset = 0;

  constructor(private frameBytes: number) {}

  enqueue(pcm: Buffer): void {
    this.queue.push(pcm);
  }

  get pendingClips(): number {
    return this.queue.length;
  }

  nextFrame(): Buffer {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const remaining = head.length - this.offset;
      if (remaining <= 0) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      if (remaining >= this.frameBytes) {
        const frame = head.subarray(this.offset, this.offset + this.frameBytes);
        this.offset += this.frameBytes;
        return frame;
      }
      const frame = Buffer.alloc(this.frameBytes);
      head.copy(frame, 0, this.offset);
      this.queue.shift();
      this.offset = 0;
      return frame;
    }
    return Buffer.alloc(this.frameBytes);
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
  private queue = new NarrationQueue(FRAME_BYTES);
  private timer: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private startTime = 0;
  private stopped = false;

  constructor(public readonly path: string) {}

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
    this.stream = createWriteStream(this.path);
    await new Promise<void>((resolve, reject) => {
      this.stream!.once("open", () => resolve());
      this.stream!.once("error", reject);
    });
    this.stream.on("error", (err) => log(`FIFO-kirjoitusvirhe: ${err.message}`));

    this.stopped = false;
    this.tickCount = 0;
    this.startTime = Date.now();
    this.scheduleNextTick();
  }

  /** Queue narration PCM (already 48kHz/stereo/s16le) for playback, in order. */
  enqueue(pcm: Buffer): void {
    this.queue.enqueue(pcm);
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
    this.stream?.end();
    this.stream = null;
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
      if (err) log(`FIFO-tick-virhe: ${err.message}`);
    });

    this.scheduleNextTick();
  }
}

export const FIFO_FRAME_BYTES = FRAME_BYTES;
