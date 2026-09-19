/** Jonoutuneiden selostusten yhdistäminen (#246).
 *
 *  Kun tapahtumia tulee ryöppynä, jono kasvaa ja selostus laahaa. Sääntö
 *  yhdistää VAIN palot ja lyöjänvaihdot, eikä se saa koskaan pudottaa
 *  tapahtumaa: jokainen syöterivi on tasan yhden tuloksen `sources`-listassa,
 *  ja yhdistetyn lauseen on mainittava jokainen niistä.
 *
 *  Keksityt joukkueet ja pelaajat (julkinen repo, otteluissa alaikäisiä). */

import { describe, expect, it } from "vitest";
import { mergeQueuedNarration, type MergedNarration, type QueuedNarration } from "../src/speech.js";

const TURN_A = "0:0:0:100";
const TURN_B = "0:0:1:200";

function palo(outNumber: number, turnKey = TURN_A, teamName = "Ketut"): QueuedNarration<string> {
  return {
    text: `Palo! ${teamName}. ${outNumber}. palo.`,
    kind: "palo",
    turnKey,
    teamName,
    outNumber,
    payload: `palo-${turnKey}-${outNumber}`,
  };
}

function batter(name: string, turnKey = TURN_A): QueuedNarration<string> {
  return { text: `Vuorossa ${name}.`, kind: "batter-change", turnKey, playerName: name, payload: `batter-${name}` };
}

function other(text: string, turnKey = TURN_A): QueuedNarration<string> {
  return { text, kind: "other", turnKey, payload: text };
}

/** Yhdistely ei saa pudottaa mitään: jokainen syöte esiintyy tasan kerran. */
function assertNothingDropped(input: QueuedNarration<string>[], output: MergedNarration<string>[]) {
  const seen = output.flatMap((o) => o.sources.map((s) => s.payload));
  expect(seen).toEqual(input.map((i) => i.payload));
}

describe("mergeQueuedNarration — palot", () => {
  it("yhdistää kaksi peräkkäistä paloa yhdeksi selostukseksi, joka mainitsee molemmat", () => {
    const input = [palo(2), palo(3)];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(1);
    expect(out[0].merged).toBe(true);
    expect(out[0].kind).toBe("palo");
    expect(out[0].sources).toHaveLength(2);
    // Molemmat palot on mainittava — muuten kuulija menettää toisen.
    expect(out[0].text.toLowerCase()).toContain("toinen");
    expect(out[0].text.toLowerCase()).toContain("kolmas");
    expect(out[0].text).toContain("Ketut");
    expect(out[0].text.toLowerCase()).toContain("kaksi");
    assertNothingDropped(input, out);
  });

  it("yhdistää myös kolme paloa ja mainitsee kaikki", () => {
    const input = [palo(1), palo(2), palo(3)];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(1);
    for (const ord of ["ensimmäinen", "toinen", "kolmas"]) expect(out[0].text.toLowerCase()).toContain(ord);
    assertNothingDropped(input, out);
  });

  it("ei yhdistä kun palojen välissä on muu tapahtuma", () => {
    const input = [palo(1), other("Milla Mäyrä löi juoksun, tuojana Aino Ilves."), palo(2)];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(3);
    expect(out.every((o) => !o.merged)).toBe(true);
    expect(out.map((o) => o.text)).toEqual(input.map((i) => i.text));
    assertNothingDropped(input, out);
  });

  it("ei yhdistä vuoronvaihdon yli — palot nollautuvat joka vuoronvaihdossa", () => {
    const input = [palo(3, TURN_A, "Ketut"), palo(1, TURN_B, "Sudet")];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(2);
    expect(out.every((o) => !o.merged)).toBe(true);
    expect(out.map((o) => o.text)).toEqual(input.map((i) => i.text));
    assertNothingDropped(input, out);
  });

  it("ei yhdistä kun sama järjestysluku toistuu (kirjurin kaksoismerkintä)", () => {
    const input = [palo(2), palo(2)];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(2);
    assertNothingDropped(input, out);
  });

  it("yksittäinen palo menee läpi ennallaan", () => {
    const input = [palo(2)];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(1);
    expect(out[0].merged).toBe(false);
    expect(out[0].text).toBe(input[0].text);
    expect(out[0].sources).toEqual([input[0]]);
  });

  it("jokainen palo-variantti kantaa samat faktat (varianttipariteetti)", () => {
    const texts = new Set<string>();
    for (let i = 0; i < 60; i++) texts.add(mergeQueuedNarration([palo(2), palo(3)])[0].text);
    expect(texts.size).toBeGreaterThan(1);
    for (const t of texts) {
      expect(t).toContain("Ketut");
      expect(t.toLowerCase()).toContain("toinen");
      expect(t.toLowerCase()).toContain("kolmas");
      expect(t.toLowerCase()).toContain("kaksi");
    }
  });
});

describe("mergeQueuedNarration — lyöjänvaihdot", () => {
  it("yhdistää kaksi peräkkäistä lyöjänvaihtoa ja mainitsee molemmat pelaajat", () => {
    const input = [batter("Milla Mäyrä"), batter("Aino Ilves")];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(1);
    expect(out[0].merged).toBe(true);
    expect(out[0].text).toContain("Milla Mäyrä");
    expect(out[0].text).toContain("Aino Ilves");
    assertNothingDropped(input, out);
  });

  it("ei yhdistä lyöjänvaihtoja vuoronvaihdon yli", () => {
    const input = [batter("Milla Mäyrä", TURN_A), batter("Veera Karhu", TURN_B)];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(2);
    expect(out.every((o) => !o.merged)).toBe(true);
    assertNothingDropped(input, out);
  });

  it("ei yhdistä palon ja lyöjänvaihdon välillä — eri lajit", () => {
    const input = [palo(1), batter("Milla Mäyrä")];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(2);
    expect(out.every((o) => !o.merged)).toBe(true);
    assertNothingDropped(input, out);
  });

  it("yksittäinen lyöjänvaihto menee läpi ennallaan", () => {
    const input = [batter("Milla Mäyrä")];
    const out = mergeQueuedNarration(input);
    expect(out[0].merged).toBe(false);
    expect(out[0].text).toBe("Vuorossa Milla Mäyrä.");
  });

  it("viimeisin lyöjä on se, joka on vuorossa", () => {
    const out = mergeQueuedNarration([batter("Milla Mäyrä"), batter("Aino Ilves")]);
    // "Aino Ilves" esiintyy nyt-vuorossa-lauseessa, "Milla Mäyrä" menneenä.
    expect(out[0].text.indexOf("Milla Mäyrä")).toBeLessThan(out[0].text.indexOf("Aino Ilves"));
  });

  it("jokainen lyöjänvaihtovariantti kantaa samat faktat (varianttipariteetti)", () => {
    const texts = new Set<string>();
    for (let i = 0; i < 60; i++) {
      texts.add(mergeQueuedNarration([batter("Milla Mäyrä"), batter("Aino Ilves")])[0].text);
    }
    expect(texts.size).toBeGreaterThan(1);
    for (const t of texts) {
      expect(t).toContain("Milla Mäyrä");
      expect(t).toContain("Aino Ilves");
    }
  });
});

describe("mergeQueuedNarration — muut tapahtumat", () => {
  it("ei koske juoksuihin eikä harhaheittoihin", () => {
    const input = [
      other("Milla Mäyrä löi juoksun, tuojana Aino Ilves."),
      other("Veera Karhu toi juoksun harhaheitolla."),
    ];
    const out = mergeQueuedNarration(input);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.text)).toEqual(input.map((i) => i.text));
    assertNothingDropped(input, out);
  });

  it("tyhjä jono tuottaa tyhjän tuloksen", () => {
    expect(mergeQueuedNarration([])).toEqual([]);
  });
});
