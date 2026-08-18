import { describe, it, expect } from "vitest";
import {
  decideFiller,
  type FillerTimingState,
  type FillerThresholds,
} from "../src/index.js";

/** Webin kynnykset (apps/web/src/watcher.ts). */
const WEB: FillerThresholds = {
  welcomeFillerMs: 90 * 1000,
  idleFillerMs: 2 * 60 * 1000,
  summaryEveryN: 10,
};

/** Lähetysputken kynnykset (apps/broadcast/src/commentaryLoop.ts). Ero webiin
 *  on tarkoituksellinen, ks. issue #62. */
const BROADCAST: FillerThresholds = {
  welcomeFillerMs: 90 * 1000,
  idleFillerMs: 90 * 1000,
  summaryEveryN: 10,
};

function state(overrides: Partial<FillerTimingState> = {}): FillerTimingState {
  return {
    finished: false,
    matchStarted: true,
    now: 1_000_000,
    lastSpeechAt: 1_000_000,
    announcementCount: 1,
    lastSummaryCount: 0,
    currentPeriod: 0,
    // Oletus: esittely on jo annettu käynnissä olevalle jaksolle, jotta muiden
    // haarojen testit koettelevat sitä mitä ne väittävät koettelevansa.
    lastIntroPeriod: 0,
    speechQueueEmpty: true,
    ...overrides,
  };
}

describe("decideFiller", () => {
  describe("null-haara", () => {
    it("vaikenee loppuselostuksen jälkeen, vaikka kaikki muu erääntyisi", () => {
      const s = state({
        finished: true,
        matchStarted: false,
        lastSpeechAt: 0,
        announcementCount: 99,
        lastSummaryCount: 0,
      });
      expect(decideFiller(s, WEB)).toBeNull();
      expect(decideFiller(s, BROADCAST)).toBeNull();
    });

    it("vaikenee ennen ensimmäistä selostusta, vaikka olisi hiljaista", () => {
      const s = state({ announcementCount: 0, lastSpeechAt: 0 });
      expect(decideFiller(s, WEB)).toBeNull();
    });

    it("vaikenee kun mikään ei erääntynyt", () => {
      const s = state({
        announcementCount: 3,
        lastSummaryCount: 0,
        lastSpeechAt: 1_000_000 - 10_000,
      });
      expect(decideFiller(s, WEB)).toBeNull();
    });
  });

  describe("welcome-haara", () => {
    it("odottaa welcomeFillerMs:n verran ennen ensimmäistä tervetulotäytettä", () => {
      const justUnder = state({
        matchStarted: false,
        lastSpeechAt: 1_000_000 - (90 * 1000 - 1),
      });
      expect(decideFiller(justUnder, WEB)).toBeNull();

      const atThreshold = state({
        matchStarted: false,
        lastSpeechAt: 1_000_000 - 90 * 1000,
      });
      expect(decideFiller(atThreshold, WEB)).toBe("welcome");
    });

    it("voittaa katsauksen ja täytteen ennen ottelun alkua", () => {
      // announcementCount > 0 ei ole ennen ottelua mahdollinen tila, mutta
      // varmistetaan silti että esiportti on ehdoton.
      const s = state({
        matchStarted: false,
        lastSpeechAt: 0,
        announcementCount: 50,
        lastSummaryCount: 0,
      });
      expect(decideFiller(s, WEB)).toBe("welcome");
    });
  });

  // ------------------------------------------------------------- issue #247
  // Selostaja esittelee itsensä ottelun alussa ja jaksojen välissä. Esittely on
  // parinkymmenen sekunnin puheenvuoro, joten se ei saa kiilata tapahtumien
  // väliin — ja se on kertaluontoinen, joten se ei saa toistua samassa
  // kohdassa.
  describe("intro-haara", () => {
    /** Ottelu on juuri alkanut: esittelyä ei ole vielä annettu kertaakaan. */
    function freshMatch(overrides: Partial<FillerTimingState> = {}) {
      return state({ currentPeriod: 0, lastIntroPeriod: null, ...overrides });
    }

    it("esittelee itsensä ottelun alussa", () => {
      expect(decideFiller(freshMatch(), WEB)).toBe("intro");
      expect(decideFiller(freshMatch(), BROADCAST)).toBe("intro");
    });

    it("esittelee itsensä ennen ensimmäistäkin selostusta", () => {
      // matchStarted riittää: ensimmäinen tapahtuma ei välttämättä tuota
      // puhetta, eikä esittelyn tarvitse odottaa sitä.
      const s = freshMatch({ announcementCount: 0 });
      expect(decideFiller(s, WEB)).toBe("intro");
    });

    it("ei toistu samassa jaksossa uudelleen", () => {
      const s = state({ currentPeriod: 0, lastIntroPeriod: 0 });
      expect(decideFiller(s, WEB)).toBeNull();
    });

    it("esittelee itsensä uudelleen jaksojen välissä", () => {
      const s = state({ currentPeriod: 1, lastIntroPeriod: 0 });
      expect(decideFiller(s, WEB)).toBe("intro");
      expect(decideFiller(s, BROADCAST)).toBe("intro");
    });

    it("jää yhteen esittelyyn kun jaksoja on vain yksi (leirimuoto)", () => {
      // Leiri- ja turnausmuodoissa 2. jaksoa ei tule lainkaan, jolloin
      // väliesittelyä ei myöskään saa syntyä tyhjästä.
      let lastIntroPeriod: number | null = null;
      let intros = 0;
      for (let poll = 0; poll < 20; poll++) {
        const decision = decideFiller(
          state({ currentPeriod: 0, lastIntroPeriod }),
          WEB,
        );
        if (decision === "intro") {
          intros++;
          lastIntroPeriod = 0;
        }
      }
      expect(intros).toBe(1);
    });

    it("ei kiilaa tapahtumaryöpyn väliin, eikä kulu odottaessaan", () => {
      const busy = freshMatch({ speechQueueEmpty: false });
      expect(decideFiller(busy, WEB)).toBeNull();

      // Ryöppy ohi, jono tyhjä → esittely on yhä velkaa ja tulee nyt.
      const quiet = freshMatch({ speechQueueEmpty: true });
      expect(decideFiller(quiet, WEB)).toBe("intro");
    });

    it("väistää täytteet ryöpyn aikana sen sijaan että vaientaisi ne", () => {
      // Jono täynnä JA katsaus erääntynyt: esittely lykkääntyy, muttei estä
      // katsausta — muuten esittely söisi kierroksen jolla oli muutakin sanottavaa.
      const s = freshMatch({
        speechQueueEmpty: false,
        announcementCount: 10,
        lastSummaryCount: 0,
      });
      expect(decideFiller(s, WEB)).toBe("recap");
    });

    it("voittaa katsauksen ja täytteen kun molemmat erääntyvät samalla kierroksella", () => {
      const s = freshMatch({
        announcementCount: 10,
        lastSummaryCount: 0,
        lastSpeechAt: 0,
      });
      expect(decideFiller(s, WEB)).toBe("intro");
    });

    // ------------------------------------------------- vain jaksoissa
    // CLAUDE.md ("Scoring"): period 0 = 1. jakso, 1 = 2. jakso, 2 = supervuoro,
    // 3 = kotiutuslyöntikilpailu. Issue #247 pyytää esittelyä "ottelun alussa
    // ja jaksojen välissä" — supervuoro ja kotiutuslyöntikilpailu eivät ole
    // jaksoja, ja ne ovat ottelun kireimmät kohdat.

    it("ei esittele itseään supervuorossa", () => {
      // Esittely annettu 2. jaksossa, ottelu jatkuu supervuoroon.
      const s = state({ currentPeriod: 2, lastIntroPeriod: 1 });
      expect(decideFiller(s, WEB)).toBeNull();
      expect(decideFiller(s, BROADCAST)).toBeNull();

      // Ei myöskään silloin kun esittelyä ei ole annettu kertaakaan: kyse ei
      // ole "jo tehty" -kirjanpidosta vaan siitä ettei supervuoro ole jakso.
      const never = state({ currentPeriod: 2, lastIntroPeriod: null });
      expect(decideFiller(never, WEB)).toBeNull();
    });

    it("ei esittele itseään kotiutuslyöntikilpailussa", () => {
      const s = state({ currentPeriod: 3, lastIntroPeriod: 2 });
      expect(decideFiller(s, WEB)).toBeNull();
      expect(decideFiller(s, BROADCAST)).toBeNull();

      const never = state({ currentPeriod: 3, lastIntroPeriod: null });
      expect(decideFiller(never, WEB)).toBeNull();
    });

    it("lykätty esittely ei kanna ratkaisuvaiheisiin", () => {
      // 2. jakso: esittely olisi vuorossa, mutta tapahtumaryöppy lykkää sen.
      const deferred = state({
        currentPeriod: 1,
        lastIntroPeriod: 0,
        speechQueueEmpty: false,
      });
      expect(decideFiller(deferred, WEB)).toBeNull();

      // Hiljainen hetki tuli vasta supervuorossa. Velka ei siirry sinne.
      for (const currentPeriod of [2, 3]) {
        const quiet = state({
          currentPeriod,
          lastIntroPeriod: 0,
          speechQueueEmpty: true,
        });
        expect(decideFiller(quiet, WEB), `period ${currentPeriod}`).toBeNull();
      }
    });

    it("odottaa ottelun alkua: ennen sitä puhutaan tervetulotäytettä", () => {
      const s = freshMatch({ matchStarted: false, lastSpeechAt: 0 });
      expect(decideFiller(s, WEB)).toBe("welcome");
    });

    it("vaikenee loppuselostuksen jälkeen", () => {
      const s = freshMatch({ finished: true });
      expect(decideFiller(s, WEB)).toBeNull();
    });
  });

  describe("recap-haara", () => {
    it("laukeaa joka summaryEveryN:s selostus", () => {
      const notYet = state({ announcementCount: 9, lastSummaryCount: 0 });
      expect(decideFiller(notYet, WEB)).toBeNull();

      const due = state({ announcementCount: 10, lastSummaryCount: 0 });
      expect(decideFiller(due, WEB)).toBe("recap");
    });

    it("voittaa idlen kun molemmat erääntyvät samalla kierroksella", () => {
      const s = state({
        announcementCount: 10,
        lastSummaryCount: 0,
        lastSpeechAt: 0,
      });
      expect(decideFiller(s, WEB)).toBe("recap");
      expect(decideFiller(s, BROADCAST)).toBe("recap");
    });
  });

  describe("idle-haara", () => {
    it("laukeaa vasta kun hiljaisuus YLITTÄÄ idleFillerMs:n", () => {
      const atThreshold = state({
        lastSpeechAt: 1_000_000 - 2 * 60 * 1000,
      });
      expect(decideFiller(atThreshold, WEB)).toBeNull();

      const justOver = state({
        lastSpeechAt: 1_000_000 - (2 * 60 * 1000 + 1),
      });
      expect(decideFiller(justOver, WEB)).toBe("idle");
    });

    it("kunnioittaa sovelluskohtaista kynnystä: 100 s hiljaisuus on täyte vain broadcastissa", () => {
      // Tämä on issue #62:n RAJA: kynnykset EIVÄT ole samat, eikä niitä saa
      // yhtenäistää. 100 s ylittää broadcastin 90 s:n mutta ei webin 2 min.
      const s = state({ lastSpeechAt: 1_000_000 - 100 * 1000 });
      expect(decideFiller(s, BROADCAST)).toBe("idle");
      expect(decideFiller(s, WEB)).toBeNull();
    });
  });
});
