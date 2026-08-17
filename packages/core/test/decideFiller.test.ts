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
