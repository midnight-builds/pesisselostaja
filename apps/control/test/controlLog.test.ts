/** Ohjaamon oma loki (#232).
 *
 *  Tämä on sopimustesti kahden asian välillä, jotka ovat eri tiedostoissa ja
 *  jotka menivät 5.8.2026 erilleen huomaamatta: `log.ts` kirjoittaa rivin
 *  stdoutiin, ja `journal.ts` lukee sen takaisin journaldista lokinäkymään. Jos
 *  muoto rikkoutuu, seuraus ei ole kaatuminen vaan hiljaisuus — täsmälleen se
 *  tila, jonka takia ottelun 136765 kulkua ei voinut jälkikäteen rekonstruoida.
 *
 *  Siksi testit ajavat rivin läpi MOLEMMISTA päistä: `formatLine` sisään,
 *  `toLogLine` ulos. */

import { describe, expect, it } from "vitest";
import { formatLine, resetJournaldDetection } from "../src/server/log.js";
import { toLogLine, type JournalRecord } from "../src/server/journal.js";
import { CONFIG } from "../src/server/config.js";

/** 2026-08-05T15:00:00Z journaldin mikrosekunteina. */
const USEC = "1785942000000000";

function record(
  message: string,
  opts: { priority?: string; unit?: string; aboutUnit?: string } = {}
): JournalRecord {
  return {
    MESSAGE: message,
    PRIORITY: opts.priority,
    __REALTIME_TIMESTAMP: USEC,
    _SYSTEMD_USER_UNIT: opts.unit,
    USER_UNIT: opts.aboutUnit,
  };
}

describe("ohjaamon rivi luetaan takaisin sellaisena kuin se kirjoitettiin", () => {
  it("säilyttää koodin ja viestin", () => {
    resetJournaldDetection();
    const written = formatLine("info", "scheduler.start", "Relay käynnistetty: Pesä Ysit – IPV.", "17.58.02");

    const line = toLogLine(record(written, { priority: "6", unit: CONFIG.controlUnit }));

    expect(line).toMatchObject({
      code: "scheduler.start",
      msg: "Relay käynnistetty: Pesä Ysit – IPV.",
      level: "info",
      unit: "control",
    });
  });

  /** Ilman journaldia prefiksiä ei tule, ja rivi on silti luettava: sama koodi
   *  tulostuu myös `npm run dev` -ajossa terminaaliin. */
  it("ei tulosta syslog-prioriteettia kun stdout ei ole journald", () => {
    resetJournaldDetection();
    expect(formatLine("warn", "preflight.blocked", "x", "12.00.00")).toBe("[12.00.00] preflight.blocked: x");
  });

  /** Tason on tultava prioriteetista eikä sanoista. Rivi, jossa lukee
   *  "epäonnistui", on tässä tarkoituksella info: sanahaku luokittelisi sen
   *  virheeksi, ja juuri se arvaus haluttiin pois. */
  it("lukee tason prioriteetista, ei sanamuodosta", () => {
    const written = formatLine("info", "job.status", "Edellinen yritys epäonnistui, tämä ei.", "12.00.00");
    expect(toLogLine(record(written, { priority: "6", unit: CONFIG.controlUnit }))?.level).toBe("info");
  });
});

describe("kumpi unit rivin kirjoitti", () => {
  it("tunnistaa ohjaamon rivin", () => {
    expect(toLogLine(record("[1.00.00] job.created: x", { priority: "6", unit: CONFIG.controlUnit }))?.unit).toBe(
      "control"
    );
  });

  it("tunnistaa relayn rivin", () => {
    expect(toLogLine(record("[1.00.00] relay.start: x", { priority: "6", unit: CONFIG.relayUnit }))?.unit).toBe(
      "relay"
    );
  });

  /** journalctl hyväksyy unitin nimen sekä `.service`-päätteellä että ilman, ja
   *  CONFIGin arvo voi tulla ympäristömuuttujasta kummassa muodossa tahansa.
   *  Vertailu ei saa riippua siitä. */
  it("vertaa unitin nimeä ilman .service-päätettä", () => {
    const bare = CONFIG.controlUnit.replace(/\.service$/, "");
    expect(toLogLine(record("[1.00.00] job.created: x", { priority: "6", unit: `${bare}.service` }))?.unit).toBe(
      "control"
    );
  });

  /** Tuntematon tai puuttuva unit luetaan relayksi, koska lokinäkymä on ollut
   *  relayn loki koko olemassaolonsa ajan: väärä "ohjaamo"-merkintä väittäisi
   *  ohjaamon tehneen jotain mitä se ei tehnyt, mikä on tämän koko tiketin
   *  vastakohta. */
  it("ei väitä tuntematonta riviä ohjaamon kirjoittamaksi", () => {
    expect(toLogLine(record("[1.00.00] ffmpeg.exit: x", { priority: "6" }))?.unit).toBe("relay");
  });

  /** systemdin oma rivi ohjaamon unitista tulee managerilta: kirjoittaja on
   *  `init.scope`, ja unit josta rivi kertoo on `USER_UNIT`issa. Ilman sitä
   *  ohjaamon käynnistys- ja pysäytysrivit näkyisivät relayn riveinä — havaittu
   *  livenä lokinäkymää tarkistettaessa. */
  it("lukee systemdin oman rivin siitä unitista, JOSTA rivi kertoo", () => {
    const line = toLogLine(
      record(`Started ${CONFIG.controlUnit} - Pesisselostaja Ohjaamo.`, {
        priority: "6",
        unit: "init.scope",
        aboutUnit: CONFIG.controlUnit,
      })
    );
    expect(line?.unit).toBe("control");
  });
});
