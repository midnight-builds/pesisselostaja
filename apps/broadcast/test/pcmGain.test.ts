import { describe, it, expect } from "vitest";
import { applyPcmGain } from "../src/pcmGain.js";

/** s16le-puskuri annetuista näytteistä. */
function pcm(...samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function samplesOf(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

describe("applyPcmGain (#244)", () => {
  it("palauttaa SAMAN puskurin kertoimella 1 — ei kopiota eikä läpikäyntiä", () => {
    const input = pcm(100, -100, 32767);
    const result = applyPcmGain(input, 1);
    // Identiteetti, ei pelkkä sisällön yhtäsuuruus: säätämätön ajo on
    // tavallisin tapaus, eikä sen kuulu maksaa mitään.
    expect(result.pcm).toBe(input);
    expect(result.clipped).toBe(0);
  });

  it("vaimentaa näytteet eikä koskaan leikkaa alaspäin skaalatessa", () => {
    const result = applyPcmGain(pcm(1000, -1000, 32767, -32768), 0.5);
    expect(samplesOf(result.pcm)).toEqual([500, -500, 16384, -16384]);
    expect(result.clipped).toBe(0);
  });

  it("voimistaa näytteet", () => {
    const result = applyPcmGain(pcm(1000, -2000), 1.5);
    expect(samplesOf(result.pcm)).toEqual([1500, -3000]);
    expect(result.clipped).toBe(0);
  });

  it("leikkaa int16:n rajaan ja kertoo montako näytettä leikkautui", () => {
    // 30000 × 1.5 = 45000 > 32767, ja -30000 × 1.5 = -45000 < -32768.
    const result = applyPcmGain(pcm(30000, -30000, 100), 1.5);
    expect(samplesOf(result.pcm)).toEqual([32767, -32768, 150]);
    expect(result.clipped).toBe(2);
  });

  it("ei koskaan tuota näytettä rajojen ulkopuolelle, olipa kerroin mikä tahansa", () => {
    const result = applyPcmGain(pcm(32767, -32768, 12345, -12345), 4);
    for (const s of samplesOf(result.pcm)) {
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
    }
  });

  it("kerroin 0 vaientaa klipin", () => {
    const result = applyPcmGain(pcm(5000, -5000), 0);
    expect(samplesOf(result.pcm)).toEqual([0, 0]);
    expect(result.clipped).toBe(0);
  });

  it("jättää epäkelvon kertoimen huomiotta sen sijaan että kirjoittaisi NaN-näytteitä", () => {
    // Puolikas editti control-tiedostossa ei saa vaientaa selostusta
    // lopullisesti — NaN-näyte kirjoittuisi nollaksi ja klippi olisi mykkä.
    const input = pcm(1000, -1000);
    expect(applyPcmGain(input, NaN).pcm).toBe(input);
    expect(applyPcmGain(input, Infinity).pcm).toBe(input);
  });

  it("katkaisee parittoman tavumäärän parilliseen eikä kaadu", () => {
    const odd = Buffer.concat([pcm(1000), Buffer.from([0x7f])]);
    const result = applyPcmGain(odd, 2);
    expect(samplesOf(result.pcm)).toEqual([2000]);
    expect(result.pcm.length).toBe(2);
  });
});
