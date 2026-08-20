import { describe, it, expect } from "vitest";
import { NarrationQueue, NarrationFifo } from "../src/narrationFifo.js";

const FRAME_BYTES = 8;

describe("NarrationQueue", () => {
  it("returns silence when nothing is queued", () => {
    const q = new NarrationQueue(FRAME_BYTES);
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
  });

  it("slices a queued clip into frame-sized chunks in order", () => {
    const q = new NarrationQueue(FRAME_BYTES);
    const clip = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    q.enqueue(clip);
    expect(q.nextFrame()).toEqual(clip.subarray(0, 8));
    expect(q.nextFrame()).toEqual(clip.subarray(8, 16));
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
  });

  it("pads a clip's final partial frame with silence instead of bleeding into the next clip", () => {
    const q = new NarrationQueue(FRAME_BYTES);
    q.enqueue(Buffer.from([1, 2, 3])); // shorter than one frame
    q.enqueue(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]));

    const first = q.nextFrame();
    expect(first.subarray(0, 3)).toEqual(Buffer.from([1, 2, 3]));
    expect(first.subarray(3)).toEqual(Buffer.alloc(5));

    expect(q.nextFrame()).toEqual(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]));
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
  });

  it("plays queued clips back-to-back in enqueue order when no gap is configured", () => {
    const q = new NarrationQueue(FRAME_BYTES);
    q.enqueue(Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]));
    q.enqueue(Buffer.from([2, 2, 2, 2, 2, 2, 2, 2]));
    expect(q.nextFrame()[0]).toBe(1);
    expect(q.nextFrame()[0]).toBe(2);
  });

  it("inserts the configured silence gap between consecutive clips, but not after the last one", () => {
    const q = new NarrationQueue(FRAME_BYTES, 2);
    q.enqueue(Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]));
    q.enqueue(Buffer.from([2, 2, 2])); // partial final frame
    q.enqueue(Buffer.from([3, 3, 3, 3, 3, 3, 3, 3]));
    expect(q.nextFrame()[0]).toBe(1);
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
    expect(q.nextFrame()[0]).toBe(2);
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
    expect(q.nextFrame()[0]).toBe(3);
    // Last clip done: plain perpetual silence, no extra armed gap state left.
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES));
  });

  it("does not arm a gap when the next clip arrives only after the previous one drained", () => {
    const q = new NarrationQueue(FRAME_BYTES, 3);
    q.enqueue(Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]));
    expect(q.nextFrame()[0]).toBe(1);
    expect(q.nextFrame()).toEqual(Buffer.alloc(FRAME_BYTES)); // queue idle
    q.enqueue(Buffer.from([2, 2, 2, 2, 2, 2, 2, 2]));
    expect(q.nextFrame()[0]).toBe(2); // starts immediately, silence already elapsed
  });
});

/** Issue #57: in a run burst the queue grew to 3–4 clips, narration fell behind
 *  the picture on top of the deliberate `narrationDelayMs`, and it did not come
 *  back into sync until the burst was over. A ceiling ends the burst instead of
 *  waiting it out — but only by dropping what nobody misses. */
describe("NarrationQueue backlog ceiling (#57)", () => {
  /** One frame per clip, so "frames" and "clips" line up and the numbers below
   *  read as what they are. */
  const clip = (fill: number) => Buffer.alloc(FRAME_BYTES, fill);

  it("does not drop anything without a ceiling — the old behaviour is intact", () => {
    const q = new NarrationQueue(FRAME_BYTES);
    for (let i = 0; i < 20; i++) expect(q.enqueue(clip(i), "droppable")).toBeNull();
    expect(q.pendingClips).toBe(20);
  });

  it("stays quiet while the backlog is under the ceiling", () => {
    const q = new NarrationQueue(FRAME_BYTES, 0, 3);
    expect(q.enqueue(clip(1), "droppable")).toBeNull();
    expect(q.enqueue(clip(2), "droppable")).toBeNull();
    expect(q.enqueue(clip(3), "droppable")).toBeNull();
    expect(q.pendingClips).toBe(3);
  });

  it("drops the OLDEST droppable clip, not the newest", () => {
    // The newest describes what is on screen now; the oldest describes a game
    // state the viewer already watched go past.
    const q = new NarrationQueue(FRAME_BYTES, 0, 2);
    q.enqueue(clip(1), "droppable");
    q.enqueue(clip(2), "droppable");
    const drop = q.enqueue(clip(3), "droppable");

    expect(drop).toEqual({ droppedClips: 1, droppedFrames: 1, overFrames: 0 });
    expect(q.nextFrame()[0]).toBe(2);
    expect(q.nextFrame()[0]).toBe(3);
  });

  it("never drops a critical clip, even when it is the oldest", () => {
    const q = new NarrationQueue(FRAME_BYTES, 0, 2);
    q.enqueue(clip(1), "critical"); // juoksu — the whole point of the broadcast
    q.enqueue(clip(2), "droppable"); // lyöjänvaihto
    const drop = q.enqueue(clip(3), "critical");

    expect(drop?.droppedClips).toBe(1);
    expect(q.nextFrame()[0]).toBe(1);
    expect(q.nextFrame()[0]).toBe(3);
  });

  it("reports being stuck over the ceiling rather than cutting something critical", () => {
    const q = new NarrationQueue(FRAME_BYTES, 0, 1);
    q.enqueue(clip(1), "critical");
    q.enqueue(clip(2), "critical");
    const drop = q.enqueue(clip(3), "critical");

    // Nothing was droppable, so nothing was dropped — and the caller is told
    // nothing was, rather than seeing a cap that silently failed.
    expect(drop).toBeNull();
    expect(q.pendingClips).toBe(3);
  });

  it("says how far over the ceiling the remaining critical backlog is", () => {
    const q = new NarrationQueue(FRAME_BYTES, 0, 1);
    q.enqueue(clip(1), "droppable");
    q.enqueue(clip(2), "critical");
    const drop = q.enqueue(clip(3), "critical");

    // The droppable one went at clip(2)'s arrival; by clip(3) only criticals
    // are left, so the ceiling can no longer be honoured and says so.
    expect(drop).toBeNull();
    expect(q.pendingClips).toBe(2);
  });

  it("says how far over it still is when dropping everything droppable was not enough", () => {
    const q = new NarrationQueue(FRAME_BYTES, 0, 2);
    q.enqueue(Buffer.alloc(FRAME_BYTES * 2, 1), "critical"); // juoksu
    q.enqueue(Buffer.alloc(FRAME_BYTES * 2, 2), "critical"); // toinen juoksu
    const drop = q.enqueue(clip(3), "droppable");

    // The droppable one goes, and the two criticals are still double the
    // ceiling. The operator needs to know the cap did not fix it.
    expect(drop?.droppedClips).toBe(1);
    expect(drop?.overFrames).toBe(2);
  });

  it("speaks a single clip in full even when it alone exceeds the ceiling", () => {
    // One clip is not a backlog. Dropping it would mean the queue silently ate
    // the only thing in it.
    const q = new NarrationQueue(FRAME_BYTES, 0, 1);
    expect(q.enqueue(Buffer.alloc(FRAME_BYTES * 3, 7), "droppable")).toBeNull();
    expect(q.nextFrame()[0]).toBe(7);
    expect(q.nextFrame()[0]).toBe(7);
    expect(q.nextFrame()[0]).toBe(7);
  });

  it("never cuts the clip that is already playing", () => {
    // Cutting mid-word is the defect #67 is about; a ceiling must not create one.
    const q = new NarrationQueue(FRAME_BYTES, 0, 3);
    q.enqueue(Buffer.alloc(FRAME_BYTES * 3, 1), "droppable");
    q.nextFrame(); // playback started — one of three frames consumed

    q.enqueue(clip(2), "droppable");
    q.enqueue(clip(3), "droppable");

    // The head survives to its last frame; the ceiling took the later ones.
    expect(q.nextFrame()[0]).toBe(1);
    expect(q.nextFrame()[0]).toBe(1);
    expect(q.nextFrame()[0]).toBe(3);
  });

  it("counts the playing clip from where playback actually is", () => {
    const q = new NarrationQueue(FRAME_BYTES, 0, 5);
    q.enqueue(Buffer.alloc(FRAME_BYTES * 4, 1), "droppable");
    expect(q.pendingFrames).toBe(4);
    q.nextFrame();
    q.nextFrame();
    expect(q.pendingFrames).toBe(2);
  });

  it("treats an unclassified clip as critical", () => {
    // The default is the safe one: an announcement nobody classified is one
    // nobody thought about.
    const q = new NarrationQueue(FRAME_BYTES, 0, 1);
    q.enqueue(clip(1));
    const drop = q.enqueue(clip(2));
    expect(drop).toBeNull();
    expect(q.pendingClips).toBe(2);
  });
});

describe("NarrationFifo backlog ceiling (#57)", () => {
  it("converts the millisecond ceiling into frames", () => {
    // 40 ms = two 20 ms frames. A 20 ms clip is one frame, so the third one
    // pushes the queue over.
    const fifo = new NarrationFifo("/tmp/unused-cap-test.pcm", 40);
    const frame = Buffer.alloc(3840); // exactly 20 ms at 48 kHz stereo s16le
    expect(fifo.enqueue(frame, "droppable")).toBeNull();
    expect(fifo.enqueue(frame, "droppable")).toBeNull();
    expect(fifo.enqueue(frame, "droppable")?.droppedClips).toBe(1);
    expect(fifo.pendingMs).toBe(40);
  });

  it("is unbounded by default, so an unconfigured relay behaves as before", () => {
    const fifo = new NarrationFifo("/tmp/unused-cap-test-2.pcm");
    for (let i = 0; i < 50; i++) expect(fifo.enqueue(Buffer.alloc(3840), "droppable")).toBeNull();
    expect(fifo.pendingClips).toBe(50);
  });
});

describe("NarrationFifo.pendingClips", () => {
  it("reports queued clips without requiring an open pipe, so a scheduled ffmpeg refresh can wait for a narration gap", () => {
    const fifo = new NarrationFifo("/tmp/unused-for-this-test.pcm");
    expect(fifo.pendingClips).toBe(0);
    fifo.enqueue(Buffer.from([1, 2, 3, 4]));
    expect(fifo.pendingClips).toBe(1);
    fifo.enqueue(Buffer.from([5, 6, 7, 8]));
    expect(fifo.pendingClips).toBe(2);
  });
});
