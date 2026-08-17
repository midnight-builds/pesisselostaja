import { describe, expect, it } from "vitest";
import { NOISE_W_MAX, NOISE_W_MIN, piperArgs } from "../src/piperTts.js";

/** Issue #69: the approved noise_w jitter has to reach the real `piper` argv,
 *  and the rejected length_scale slowdown must never join it. */

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("piper argv (issue #69)", () => {
  it("keeps the model and output file the synthesis needs", () => {
    const args = piperArgs("/voices/fi_FI-harri-medium.onnx", "/tmp/out.wav", () => 0.5);
    expect(valueOf(args, "--model")).toBe("/voices/fi_FI-harri-medium.onnx");
    expect(valueOf(args, "--output_file")).toBe("/tmp/out.wav");
  });

  it("passes --noise_w inside the approved 0.75–0.95 range on every draw", () => {
    // Real randomness, many draws: the jitter must never leave the range that
    // was actually listened to.
    for (let i = 0; i < 500; i++) {
      const args = piperArgs("/m.onnx", "/tmp/out.wav");
      const noiseW = valueOf(args, "--noise_w");
      expect(noiseW).toBeDefined();
      const n = Number(noiseW);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(NOISE_W_MIN);
      expect(n).toBeLessThanOrEqual(NOISE_W_MAX);
    }
  });

  it("hits both ends of the range at the rng's extremes", () => {
    expect(Number(valueOf(piperArgs("/m.onnx", "/o.wav", () => 0), "--noise_w"))).toBeCloseTo(NOISE_W_MIN, 3);
    // rng() is [0,1), so the max is approached, never reached — but must stay inside.
    const high = Number(valueOf(piperArgs("/m.onnx", "/o.wav", () => 0.999999), "--noise_w"));
    expect(high).toBeLessThanOrEqual(NOISE_W_MAX);
    expect(high).toBeGreaterThan(0.94);
  });

  it("actually varies between calls, so consecutive lines are not identical", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(String(valueOf(piperArgs("/m.onnx", "/o.wav"), "--noise_w")));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("never passes --length_scale — 1.15 was listened to and rejected 9.7.2026", () => {
    for (let i = 0; i < 50; i++) {
      expect(piperArgs("/m.onnx", "/o.wav")).not.toContain("--length_scale");
    }
  });

  it("keeps the approved range itself unwidened", () => {
    expect(NOISE_W_MIN).toBe(0.75);
    expect(NOISE_W_MAX).toBe(0.95);
  });
});
