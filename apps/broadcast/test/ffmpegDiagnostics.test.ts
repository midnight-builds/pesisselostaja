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

/** The tail from matches 145900 and 145905 (30.7.2026), where the ONLY thing
 *  resembling an error was the FLV muxer closing the output — and the relay
 *  read it as "the target refused us" and told the operator to go check a
 *  stream key that was fine. The phone had stopped sending. Issue #122. */
const FLV_TEARDOWN_TAIL = [
  "frame= 1020 fps= 30 q=-1.0 size=   34000kB time=00:00:34.00 bitrate=8100.0kbits/s speed=   1x",
  "[flv @ 0x5581c0] Failed to update header with correct duration.",
  "[flv @ 0x5581c0] Failed to update header with correct filesize.",
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

  it("does NOT call the FLV muxer's closing complaint a target failure (#122)", () => {
    // The live regression, twice in one day. The muxer prints these while it
    // closes the output, which it does on EVERY teardown — including the one
    // where the input ended first. As a TARGET pattern it produced a confident
    // verdict from the one line that carries no information about the target.
    expect(classifyFfmpegFailure(FLV_TEARDOWN_TAIL)).toBeNull();
    expect(hasWeakTargetSignal(FLV_TEARDOWN_TAIL)).toBe(true);
  });

  it("still names the target when a real RTMP-level error is present (#51 unbroken)", () => {
    // Weakening the FLV line must not cost us the case it was there for: an
    // actual refusal says so at the rtmp/connection level, and that still wins.
    expect(classifyFfmpegFailure(`${FLV_TEARDOWN_TAIL}\n${TARGET_TAIL}`)).toBe("target");
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

  it("refuses to blame anyone when ffmpeg exited 0, whatever the tail says (#122)", () => {
    // A clean exit means ffmpeg read its input to EOF. A target that refuses
    // or drops the push makes it exit non-zero, so on code=0 the tail can only
    // hold teardown noise — and this is the sentence the operator acted on
    // twice on 30.7.2026 while the phone, not the stream key, was the problem.
    const clean = describeFailureSide("target", true, 0);
    expect(clean).toMatch(/syöte loppui/i);
    expect(clean).not.toMatch(/tarkista stream key/i);
    expect(describeFailureSide("source", false, 0)).toMatch(/syöte loppui/i);
  });

  it("still reads the tail on a non-zero exit", () => {
    expect(describeFailureSide("target", false, 1)).toMatch(/stream key/i);
    // A spawn error has no exit code at all; the tail is then all we have.
    expect(describeFailureSide("target", false, null)).toMatch(/stream key/i);
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
