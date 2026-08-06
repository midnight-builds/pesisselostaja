import { describe, expect, it } from "vitest";
import { scoreValue } from "../src/client/components/MatchGlance";
import type { MatchState } from "../src/shared/types";

/** Ottelusta 136765 (5.8.2026): kortti sanoi "6 – 12" samalla kun selostus
 *  sanoi oikein "toinen jakso, tilanne 0–2". Summa ei ole jaksopelissä ottelun
 *  tilanne missään vaiheessa (#229).
 *
 *  Fikstuurin `totalHome`/`totalAway` pidetään tarkoituksella ERI lukuina kuin
 *  jakson tilanne — muuten testi menisi läpi myös vanhalla summarivillä eikä
 *  erottaisi mitään. */
function match(overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: 136765,
    home: "HP",
    away: "Ysit",
    periodScores: [
      { home: 6, away: 10 },
      { home: 0, away: 2 },
    ],
    totalHome: 6,
    totalAway: 12,
    periodsWonHome: 0,
    periodsWonAway: 1,
    currentPeriod: 1,
    palot: 2,
    battingTeam: "HP",
    finished: false,
    eventCount: 40,
    lastEventAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("scoreValue", () => {
  it("näyttää jaksovoitot ja käynnissä olevan jakson, ei juoksujen summaa", () => {
    const value = scoreValue(match());
    expect(value).toBe("HP 0 – 1 Ysit jaksoissa · 2. jakso 0–2");
    // Summa 6–12 ei saa esiintyä rivillä missään muodossa.
    expect(value).not.toContain("12");
  });

  it("ennen ensimmäisen jakson ratkeamista rivi on pelkkä jakson tilanne", () => {
    const value = scoreValue(
      match({
        periodScores: [{ home: 6, away: 10 }],
        totalHome: 6,
        totalAway: 10,
        periodsWonAway: 0,
        currentPeriod: 0,
      })
    );
    expect(value).toBe("HP 6 – 10 Ysit");
  });

  it("yhden jakson ottelu (leirimuoto) ei tarvitse erikoistapausta", () => {
    const value = scoreValue(
      match({
        periodScores: [{ home: 3, away: 4 }],
        totalHome: 3,
        totalAway: 4,
        periodsWonAway: 0,
        currentPeriod: 0,
        palot: 1,
      })
    );
    expect(value).toBe("HP 3 – 4 Ysit");
  });

  // `periodsWon` laskee päättyneessä ottelussa mukaan myös viimeisen jakson,
  // joten jaksovoittoihin sidottu ehto olisi sanonut "HP 1 – 0 Ysit jaksoissa"
  // yhden jakson leiriottelun lopussa. Leirimuoto on ainoa formaatti, joka on
  // oikeasti ajettu livenä — tämän on pysyttävä oikein.
  it("päättynyt yhden jakson ottelu näyttää juoksut, ei kuviteltua jaksovoittoa", () => {
    const value = scoreValue(
      match({
        periodScores: [{ home: 5, away: 3 }],
        totalHome: 5,
        totalAway: 3,
        periodsWonHome: 1,
        periodsWonAway: 0,
        currentPeriod: 0,
        finished: true,
        battingTeam: null,
        palot: null,
      })
    );
    expect(value).toBe("HP 5 – 3 Ysit");
    expect(value).not.toContain("jaksoissa");
  });

  // Tasan mennyt jakso ei tuota voittoa kummallekaan. Rivi ei silti saa pudota
  // paljaaksi kahdeksi luvuksi, joka näyttää samalta kuin 1. jakson tilanne.
  it("tasan mennyt jakso ei piilota sitä että jakso on pelattu", () => {
    const value = scoreValue(
      match({
        periodScores: [
          { home: 5, away: 5 },
          { home: 0, away: 2 },
        ],
        totalHome: 5,
        totalAway: 7,
        periodsWonHome: 0,
        periodsWonAway: 0,
        currentPeriod: 1,
      })
    );
    expect(value).toBe("HP 0 – 0 Ysit jaksoissa · 2. jakso 0–2");
  });

  it("supervuoro nimetään oikein", () => {
    const value = scoreValue(
      match({
        periodScores: [
          { home: 6, away: 10 },
          { home: 5, away: 1 },
          { home: 1, away: 0 },
        ],
        totalHome: 12,
        totalAway: 11,
        periodsWonHome: 1,
        periodsWonAway: 1,
        currentPeriod: 2,
      })
    );
    expect(value).toBe("HP 1 – 1 Ysit jaksoissa · supervuoro 1–0");
  });

  // Palvelin EI nollaa `currentPeriod`ia ottelun päättyessä (`matches.ts:278`
  // palauttaa aina numeron kun tapahtumia on), joten päättyminen on luettava
  // `finished`istä. Aiempi versio tästä testistä asetti `currentPeriod: null`
  // ja vartioi siten haaraa, jota tuotannossa ei ajeta koskaan.
  it("päättyneessä jaksopelissä jaksovoitot ovat lopputulos, eikä perään tule mitään", () => {
    const value = scoreValue(
      match({
        periodsWonHome: 0,
        periodsWonAway: 2,
        currentPeriod: 1,
        finished: true,
        battingTeam: null,
        palot: null,
      })
    );
    expect(value).toBe("HP 0 – 2 Ysit jaksoissa");
    expect(value).not.toContain("2. jakso");
  });

  it("tuntemattomat joukkueet eivät riko riviä", () => {
    const value = scoreValue(match({ home: null, away: null }));
    expect(value).toBe("Koti 0 – 1 Vieras jaksoissa · 2. jakso 0–2");
  });
});
