import { describe, it, expect } from "vitest";
import { NarrationQueue } from "../src/narrationFifo.js";

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

  it("plays queued clips back-to-back in enqueue order", () => {
    const q = new NarrationQueue(FRAME_BYTES);
    q.enqueue(Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]));
    q.enqueue(Buffer.from([2, 2, 2, 2, 2, 2, 2, 2]));
    expect(q.nextFrame()[0]).toBe(1);
    expect(q.nextFrame()[0]).toBe(2);
  });
});
