import { describe, it, expect } from "vitest";
import { venueDisplayName, stadiumSpeechName } from "../src/index.js";

/** Issue #132 (otsikot) ja #101:n sivuhavainto (puhe) ovat sama raakamerkkijono:
 *  tulospalvelun kenttänimi sisäisessä muodossaan. Nämä ovat oikeita arvoja
 *  30.7.2026 ajetuista otteluista. */

describe("venueDisplayName", () => {
  it("pudottaa sekä kenttänumeron että tuotantomerkinnän", () => {
    // Tämä päätyi sellaisenaan luodun lähetyksen otsikkoon, katkaistuna
    // kesken merkinnän: "… 30.7.2026 01 - Viinijärven pallokenttä, tekonurmi 1|".
    expect(venueDisplayName("01 - Viinijärven pallokenttä, tekonurmi 1| LEIRITUOTANTO")).toBe(
      "Viinijärven pallokenttä, tekonurmi 1"
    );
  });

  it("pudottaa kenttänumeron myös ilman ajatusviivaa", () => {
    // Leirimuodon oma kirjoitusasu, speech.ts:n alkuperäisestä kommentista.
    expect(venueDisplayName("12 Tupos B | LEIRITUOTANTO")).toBe("Tupos B");
  });

  it("pudottaa kenttänumeron myös ilman tuotantomerkintää", () => {
    // #101: puhuttuna tämä kuului "nolla viisi viiva Liperin kirkonkylän
    // kenttä viisi".
    expect(venueDisplayName("05 - Liperin kirkonkylän kenttä 5")).toBe("Liperin kirkonkylän kenttä 5");
  });

  it("jättää tavallisen kenttänimen rauhaan", () => {
    expect(venueDisplayName("Kisapuisto")).toBe("Kisapuisto");
    expect(venueDisplayName("Pesä Ysien kenttä 2")).toBe("Pesä Ysien kenttä 2");
  });

  it("ei syö numeroa, jota ei seuraa nimeä", () => {
    // Suojaa siltä että sääntö nakertaisi nimen, joka on pelkkää numeroa tai
    // alkaa vuosiluvulla ilman kenttänimeä — tyhjä nimi on pahempi kuin
    // siivoamaton.
    expect(venueDisplayName("12")).toBe("12");
    expect(venueDisplayName("2024 - 2025")).toBe("2024 - 2025");
  });

  it("siivoaa roikkuvan välimerkin liitteen edeltä", () => {
    expect(venueDisplayName("Kisapuisto, | LEIRITUOTANTO")).toBe("Kisapuisto");
  });

  it("kumpikin sääntö on kytkettävissä erikseen", () => {
    const raw = "01 - Viinijärven pallokenttä| LEIRITUOTANTO";
    expect(venueDisplayName(raw, { stripFieldNumber: false })).toBe("01 - Viinijärven pallokenttä");
    expect(venueDisplayName(raw, { stripQualifier: false })).toBe("Viinijärven pallokenttä| LEIRITUOTANTO");
    expect(venueDisplayName(raw, { stripFieldNumber: false, stripQualifier: false })).toBe(raw);
  });

  it("tyhjä ja puuttuva syöte palautuvat tyhjänä", () => {
    expect(venueDisplayName("")).toBe("");
    expect(venueDisplayName(null)).toBe("");
    expect(venueDisplayName(undefined)).toBe("");
    // Pelkkä merkintä ilman nimeä: kutsuja jättää kentän mainitsematta.
    expect(venueDisplayName("| LEIRITUOTANTO")).toBe("");
  });
});

describe("stadiumSpeechName (#101)", () => {
  it("puhuu saman nimen kuin otsikkoon kirjoitetaan", () => {
    const raw = "05 - Liperin kirkonkylän kenttä 5| LEIRITUOTANTO";
    expect(stadiumSpeechName(raw)).toBe("Liperin kirkonkylän kenttä 5");
    expect(stadiumSpeechName(raw)).toBe(venueDisplayName(raw));
  });
});
