import { describe, it, expect } from "vitest";
import {
  applyPronunciations,
  preventOrdinalReading,
  sanitize,
  DEFAULT_PRONUNCIATIONS,
} from "../src/pronunciation.js";

describe("applyPronunciations", () => {
  it("replaces a whole-word term everywhere it appears", () => {
    expect(applyPronunciations("Palo! KPL. Kolmas palo.", DEFAULT_PRONUNCIATIONS))
      .toBe("Palo! Koo Pee Äl. Kolmas palo.");
  });

  it("does not replace the term inside a longer word", () => {
    const rules = [{ from: "KPL", to: "Koo Pee Äl" }];
    expect(applyPronunciations("MAILAKPL voitti", rules)).toBe("MAILAKPL voitti");
    expect(applyPronunciations("KPL2 voitti", rules)).toBe("KPL2 voitti");
  });

  it("matches a word term adjacent to punctuation", () => {
    const rules = [{ from: "KPL", to: "Koo Pee Äl" }];
    expect(applyPronunciations("Sisävuoroon KPL.", rules)).toBe("Sisävuoroon Koo Pee Äl.");
    expect(applyPronunciations("KPL:n vuoro päättyi", rules)).toBe("Koo Pee Äl:n vuoro päättyi");
  });

  it("treats a term with non-word characters as a plain substring", () => {
    const rules = [{ from: "V-P", to: "Vee Pee" }];
    expect(applyPronunciations("Vuorossa V-P Mäki", rules)).toBe("Vuorossa Vee Pee Mäki");
  });

  it("does not treat regex metacharacters in the term as patterns", () => {
    const rules = [{ from: "A.B", to: "Aa Bee" }];
    expect(applyPronunciations("AXB pelaa", rules)).toBe("AXB pelaa");
    expect(applyPronunciations("A.B pelaa", rules)).toBe("Aa Bee pelaa");
  });

  it("skips rules whose from-term is blank", () => {
    const rules = [{ from: "   ", to: "roskaa" }];
    expect(applyPronunciations("Palo! Ketut.", rules)).toBe("Palo! Ketut.");
  });

  it("applies rules in order to the running result", () => {
    const rules = [
      { from: "KPL", to: "Koo Pee Äl" },
      { from: "Äl", to: "äl" },
    ];
    expect(applyPronunciations("KPL johtaa", rules)).toBe("Koo Pee äl johtaa");
  });
});

describe("preventOrdinalReading", () => {
  it("detaches a sentence-final period from the preceding digit", () => {
    expect(preventOrdinalReading("Tilanne 6, 3, Ketut johtaa 6.")).toBe(
      "Tilanne 6, 3, Ketut johtaa 6 ."
    );
  });

  it("detaches a digit-period before a following word too", () => {
    expect(preventOrdinalReading("Tilanne 6. Sisävuorossa Sudet.")).toBe(
      "Tilanne 6 . Sisävuorossa Sudet."
    );
  });

  it("leaves decimals untouched", () => {
    expect(preventOrdinalReading("keskiarvo 6.5 pistettä")).toBe("keskiarvo 6.5 pistettä");
  });

  it("leaves text without digit-periods untouched", () => {
    expect(preventOrdinalReading("Palo! Ketut. Kolmas palo.")).toBe(
      "Palo! Ketut. Kolmas palo."
    );
  });
});

describe("sanitize", () => {
  it("keeps only objects with string from/to and a non-blank from", () => {
    const out = sanitize([
      { from: "KPL", to: "Koo Pee Äl" },
      { from: "  ", to: "tyhjä" },
      { from: 5, to: "numero" },
      { from: "OK", to: 7 },
      "pelkkä merkkijono",
      null,
      { from: "  IPV ", to: "" },
    ]);
    expect(out).toEqual([
      { from: "KPL", to: "Koo Pee Äl" },
      { from: "IPV", to: "" },
    ]);
  });

  it("returns an empty list for an empty input", () => {
    expect(sanitize([])).toEqual([]);
  });
});
