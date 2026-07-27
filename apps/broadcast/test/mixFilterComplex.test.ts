import { describe, expect, it } from "vitest";
import { buildMixFilterComplex } from "../src/ffmpegMixer.js";

describe("buildMixFilterComplex (issue #56)", () => {
  it("limits with level=disabled so alimiter does not lift the signal back over the limit", () => {
    const filter = buildMixFilterComplex(1.3);
    expect(filter).toContain("alimiter=limit=0.95:level=disabled");
    // Guards against the option being dropped again by a later edit of the chain.
    expect(filter).not.toMatch(/alimiter=(?![^,[]*level=disabled)/);
  });

  it("still mixes the gained narration onto the original audio", () => {
    expect(buildMixFilterComplex(1.3)).toContain("[1:a]volume=1.3[narr]");
  });
});
