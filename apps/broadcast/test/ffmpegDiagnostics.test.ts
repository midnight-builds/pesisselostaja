import { describe, it, expect } from "vitest";
import {
  classifyFfmpegFailure,
  createStderrTail,
  describeFailureSide,
  hasWeakTargetSignal,
  redactStreamKey,
  STDERR_TAIL_BYTES,
} from "../src/ffmpegDiagnostics.js";

/** Shapes taken from real ffmpeg output, with the stream key and the
 *  googlevideo host replaced. */
const TARGET_TAIL = [
  "[rtmp @ 0x55f1a0] Server error: Authentication Failed.",
  "rtmp://a.rtmp.youtube.com/live2/xxxx-yyyy: Operation not permitted",
  "Could not write header for output file #0 (incorrect codec parameters ?)",
].join("\n");

const SOURCE_TAIL = [
  "[https @ 0x55f1a0] HTTP error 403 Forbidden",
  "https://rr3---sn-example.googlevideo.com/videoplayback?expire=1: Server returned 403 Forbidden",
].join("\n");

/** What ffmpeg says when the INPUT ended and it is tearing the graph down —
 *  the output complains too, which is exactly why this must not read as a
 *  target failure. */
const ORDINARY_SHUTDOWN_TAIL = [
  "frame= 1234 fps= 30 q=-1.0 size=   45000kB time=00:00:41.00 bitrate=8900.0kbits/s speed=   1x",
  "av_interleaved_write_frame(): Broken pipe",
  "Error writing trailer: Broken pipe",
].join("\n");

describe("classifyFfmpegFailure (issue #51)", () => {
  it("names the target when only RTMP-side errors appear", () => {
    expect(classifyFfmpegFailure(TARGET_TAIL)).toBe("target");
  });

  it("names the source when only input-side errors appear", () => {
    expect(classifyFfmpegFailure(SOURCE_TAIL)).toBe("source");
  });

  it("refuses to guess when both sides errored", () => {
    // Cause and consequence are indistinguishable here; a confident answer
    // would send the operator to the wrong end of the chain mid-match.
    expect(classifyFfmpegFailure(`${SOURCE_TAIL}\n${TARGET_TAIL}`)).toBeNull();
  });

  it("does NOT call an ordinary end-of-source shutdown a target failure", () => {
    // The regression that matters: "Broken pipe" on the output happens every
    // time the input ends, so counting it would label every dead phone a
    // stream-key problem.
    expect(classifyFfmpegFailure(ORDINARY_SHUTDOWN_TAIL)).toBeNull();
    expect(hasWeakTargetSignal(ORDINARY_SHUTDOWN_TAIL)).toBe(true);
  });

  it("says nothing about an empty or progress-only tail", () => {
    expect(classifyFfmpegFailure("")).toBeNull();
    expect(classifyFfmpegFailure("frame= 10 fps=30 q=-1.0 size=1kB")).toBeNull();
    expect(hasWeakTargetSignal("frame= 10 fps=30 q=-1.0 size=1kB")).toBe(false);
  });
});

describe("describeFailureSide", () => {
  it("points at the stream key for a target failure", () => {
    expect(describeFailureSide("target", false)).toMatch(/stream key/i);
  });

  it("points at the phone for a source failure", () => {
    expect(describeFailureSide("source", false)).toMatch(/puhelimen/i);
  });

  it("explicitly declines to blame either side on weak signals alone", () => {
    expect(describeFailureSide(null, true)).toMatch(/kumpaakaan puolta ei voi/i);
  });

  it("stays silent when there is nothing to say", () => {
    expect(describeFailureSide(null, false)).toBeNull();
  });
});

describe("redactStreamKey", () => {
  it("removes the key from an ffmpeg error line", () => {
    const key = "abcd-efgh-ijkl-mnop";
    const line = `rtmp://a.rtmp.youtube.com/live2/${key}: Operation not permitted`;
    const out = redactStreamKey(line, key);
    expect(out).not.toContain(key);
    expect(out).toContain("<stream-key>");
  });

  it("replaces every occurrence, not just the first", () => {
    const key = "abcd-efgh-ijkl-mnop";
    expect(redactStreamKey(`${key} ... ${key}`, key)).toBe("<stream-key> ... <stream-key>");
  });

  it("leaves text alone for missing or implausibly short keys", () => {
    // A dry-run placeholder like "x" would otherwise redact every stray letter.
    expect(redactStreamKey("x marks the spot", "x")).toBe("x marks the spot");
    expect(redactStreamKey("untouched", undefined)).toBe("untouched");
    expect(redactStreamKey("untouched", "")).toBe("untouched");
  });
});

describe("createStderrTail", () => {
  it("keeps only the last maxBytes across many chunks", () => {
    const tail = createStderrTail(10);
    for (const c of ["aaaaa", "bbbbb", "ccccc"]) tail.push(c);
    expect(tail.text()).toBe("bbbbbccccc");
  });

  it("keeps short output whole", () => {
    const tail = createStderrTail(10);
    tail.push("abc");
    expect(tail.text()).toBe("abc");
  });

  it("defaults to a tail big enough to hold ffmpeg's final error block", () => {
    expect(STDERR_TAIL_BYTES).toBeGreaterThanOrEqual(4096);
  });
});
