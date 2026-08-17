import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOISE_W_MAX, NOISE_W_MIN, PiperTts } from "../src/piperTts.js";

/** Issue #69, second half: `piperArgs` being correct proves nothing if the
 *  synthesis call doesn't use it. The unit tests in piperArgs.test.ts pin the
 *  function; this file pins the *call site* — hardcoding the argv back into
 *  `synthesizeNow` leaves every one of those unit tests green, which is exactly
 *  the failure mode issue #69 is about (a parameter that exists and is tested
 *  but never reaches the process that makes the sound).
 *
 *  The seam is the `piper` binary itself: `piperBin` points at a stub script
 *  that records the argv it was handed. Synthesis then fails at the ffmpeg step
 *  (the stub writes no wav) — irrelevant here, since the recording already
 *  happened; the assertions are about what `piper` was called with.
 *
 *  `rng` is injected, so the expected value is exact and the test cannot flake
 *  (cf. issue #255). */

let dir: string;
let argvLog: string;
let piperBin: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pesis-piper-argv-"));
  argvLog = join(dir, "argv.txt");
  piperBin = join(dir, "fake-piper.sh");
  // Records argv one-per-line, drains stdin (the relay pipes the text in), and
  // deliberately produces no wav.
  await writeFile(piperBin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvLog}'\ncat > /dev/null\n`, {
    mode: 0o755,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function synthesizeWith(rng: () => number): Promise<string[]> {
  const tts = new PiperTts({ piperBin, voice: "harri-medium", voicesDir: "/voices", rng });
  // The ffmpeg step has nothing to convert, so this rejects; the argv the stub
  // recorded is what this test is about.
  await tts.synthesize("Kolmas palo.").catch(() => undefined);
  const recorded = await readFile(argvLog, "utf8");
  return recorded.split("\n").filter((line) => line !== "");
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("piper call site (issue #69)", () => {
  it("hands --noise_w to the piper process that actually synthesizes", async () => {
    const args = await synthesizeWith(() => 0.5);
    expect(args).toContain("--noise_w");
    const n = Number(valueOf(args, "--noise_w"));
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(NOISE_W_MIN);
    expect(n).toBeLessThanOrEqual(NOISE_W_MAX);
    // rng 0.5 sits in the middle of the approved range — exact, not sampled.
    expect(n).toBeCloseTo((NOISE_W_MIN + NOISE_W_MAX) / 2, 3);
  });

  it("uses the injected rng, so the jitter reaching piper really varies", async () => {
    const low = Number(valueOf(await synthesizeWith(() => 0), "--noise_w"));
    const high = Number(valueOf(await synthesizeWith(() => 0.999999), "--noise_w"));
    expect(low).toBeCloseTo(NOISE_W_MIN, 3);
    expect(high).toBeGreaterThan(0.94);
    expect(high).toBeLessThanOrEqual(NOISE_W_MAX);
  });

  it("still passes the model and output file, and never --length_scale", async () => {
    const args = await synthesizeWith(() => 0.25);
    expect(valueOf(args, "--model")).toBe("/voices/fi_FI-harri-medium.onnx");
    expect(valueOf(args, "--output_file")).toMatch(/\.wav$/);
    expect(args).not.toContain("--length_scale");
  });
});
