import { describe, it, expect } from "vitest";
import { finnishCardinal, finnishOrdinal, spellOutNumbers } from "../src/numberSpeech.js";

describe("finnishCardinal", () => {
  it("units and teens", () => {
    expect(finnishCardinal(0)).toBe("nolla");
    expect(finnishCardinal(1)).toBe("yksi");
    expect(finnishCardinal(7)).toBe("seitsemän");
    expect(finnishCardinal(10)).toBe("kymmenen");
    expect(finnishCardinal(11)).toBe("yksitoista");
    expect(finnishCardinal(19)).toBe("yhdeksäntoista");
  });

  it("tens are written together", () => {
    expect(finnishCardinal(20)).toBe("kaksikymmentä");
    expect(finnishCardinal(21)).toBe("kaksikymmentäyksi");
    expect(finnishCardinal(58)).toBe("viisikymmentäkahdeksan");
    expect(finnishCardinal(99)).toBe("yhdeksänkymmentäyhdeksän");
  });

  it("hundreds and thousands", () => {
    expect(finnishCardinal(100)).toBe("sata");
    expect(finnishCardinal(112)).toBe("satakaksitoista");
    expect(finnishCardinal(200)).toBe("kaksisataa");
    expect(finnishCardinal(345)).toBe("kolmesataaneljäkymmentäviisi");
    expect(finnishCardinal(1000)).toBe("tuhat");
    expect(finnishCardinal(1100)).toBe("tuhatsata");
    expect(finnishCardinal(9999)).toBe("yhdeksäntuhattayhdeksänsataayhdeksänkymmentäyhdeksän");
  });

  it("rejects out-of-range input", () => {
    expect(() => finnishCardinal(-1)).toThrow(RangeError);
    expect(() => finnishCardinal(10000)).toThrow(RangeError);
    expect(() => finnishCardinal(1.5)).toThrow(RangeError);
  });
});

describe("spellOutNumbers (EL path normalization)", () => {
  it("spells out the score phrases EL misread live", () => {
    expect(spellOutNumbers("Tasan 4, 4.")).toBe("Tasan neljä, neljä.");
    expect(spellOutNumbers("4, 3, Ysit johtaa")).toBe("neljä, kolme, Ysit johtaa");
    expect(spellOutNumbers("Sisävuorossa KaKa, 3 paloa.")).toBe("Sisävuorossa KaKa, kolme paloa.");
  });

  it("handles multiple numbers and leaves the rest of the text alone", () => {
    expect(spellOutNumbers("Tilasto kertoo tilanteeksi 2, 4, Ysit johtaa.")).toBe(
      "Tilasto kertoo tilanteeksi kaksi, neljä, Ysit johtaa."
    );
  });

  it("converts digits inside stadium-style names too", () => {
    expect(spellOutNumbers("pelikenttänä 12 Tupos B")).toBe("pelikenttänä kaksitoista Tupos B");
  });

  it("leaves text without digits untouched", () => {
    const s = "Palo! Kolmas palo. Lyömässä Mäyrä.";
    expect(spellOutNumbers(s)).toBe(s);
  });

  it("leaves digit runs above 9999 as-is instead of guessing", () => {
    expect(spellOutNumbers("ottelu 144742")).toBe("ottelu 144742");
  });
});

describe("finnishOrdinal (issue #50: palo ordinals have no ceiling)", () => {
  it("units and tens", () => {
    expect(finnishOrdinal(1)).toBe("ensimmäinen");
    expect(finnishOrdinal(3)).toBe("kolmas");
    expect(finnishOrdinal(9)).toBe("yhdeksäs");
    expect(finnishOrdinal(10)).toBe("kymmenes");
  });

  it("teens use the compound stem, not the standalone ordinal", () => {
    expect(finnishOrdinal(11)).toBe("yhdestoista");
    expect(finnishOrdinal(12)).toBe("kahdestoista");
    expect(finnishOrdinal(13)).toBe("kolmastoista");
    expect(finnishOrdinal(19)).toBe("yhdeksästoista");
  });

  it("keeps going past the old 12-entry table", () => {
    expect(finnishOrdinal(20)).toBe("kahdeskymmenes");
    expect(finnishOrdinal(21)).toBe("kahdeskymmenesensimmäinen");
    expect(finnishOrdinal(32)).toBe("kolmaskymmenestoinen");
    expect(finnishOrdinal(99)).toBe("yhdeksäskymmenesyhdeksäs");
  });

  it("produces a word for every ordinal a turn could ever need", () => {
    for (let n = 1; n <= 99; n++) expect(finnishOrdinal(n)).toMatch(/^[a-zäö]+$/);
  });

  it("rejects out-of-range input instead of guessing", () => {
    expect(() => finnishOrdinal(0)).toThrow(RangeError);
    expect(() => finnishOrdinal(100)).toThrow(RangeError);
    expect(() => finnishOrdinal(1.5)).toThrow(RangeError);
  });
});
