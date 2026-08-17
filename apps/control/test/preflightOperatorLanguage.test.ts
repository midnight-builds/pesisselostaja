/** Preflight puhuu operaattorin kieltä, ja korjaa sen minkä voi (#176, #184).
 *
 *  Kaksi väitettä, jotka molemmat maksoivat ottelupäivän kerran:
 *
 *  1. **Rivit eivät mainitse env-avaimia.** Käyttöliittymä ei näytä niitä
 *     missään — käsikentät ja "Kirjoita .env.relay" -nappi ovat poissa, joten
 *     rivi "RELAY_STREAM_KEY puuttuu" olisi ohje tekoon jota ei ole olemassa.
 *     Raaka rivi säilyy `technical`-kentässä huoltopintaa varten.
 *  2. **Väärä sidonta korjataan ja korjaus näkyy.** 31.7.2026 preflight
 *     raportoi vihreänä eiliseen otteluun sidotusta relaysta (#155). Nyt
 *     ohjaamo sitoo itsensä valittuun otteluun — mutta vain kun kutsuja antaa
 *     siihen luvan, ja teko jää riviksi ("Korjattiin: …"), ei hiljaiseksi. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG } from "../src/server/config.js";
import { writeRelayEnv } from "../src/server/relay.js";
import type { Job } from "../src/shared/types.js";

// runPreflight itse ajaa yt-dlp:tä, statfs:ää ja verkkoa — tässä testataan sen
// ympärillä olevaa käännöstä ja korjausta, joten se korvataan. Kaikki muu
// (parseEnvFile, summarize) on aitoa.
vi.mock("../../broadcast/src/preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../broadcast/src/preflight.js")>();
  return { ...actual, runPreflight: async () => [] };
});
// Push-ilmoitukset eivät kuulu tähän eivätkä saa kirjoittaa tilatiedostoja.
vi.mock("../src/server/notifications.js", () => ({ notifyPreflightBlockers: async () => undefined }));

const { runControlPreflight, toOperatorCheck, redactEnvKeys } = await import("../src/server/preflight.js");

let tmpDir: string;
const realEnvPath = CONFIG.relayEnvPath;

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-184",
    status: "scheduled",
    createdAt: "2026-08-04T05:00:00.000Z",
    matchId: 146210,
    home: "Kuvitteellisen Kylän Veikot",
    away: "Lapinlahden Peikot",
    seriesName: null,
    stadium: null,
    startsAt: "2026-08-04T10:30:00.000Z",
    sourceUrl: "https://example.invalid/raakalahetys",
    targetStreamKey: "avain-tanaan",
    targetRtmpUrl: "rtmp://example.invalid/live2",
    targetVideoId: "VIDEO1",
    armedAt: null,
    startedAt: null,
    endedAt: null,
    cleanup: null,
    note: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "preflight-"));
  CONFIG.relayEnvPath = join(tmpDir, ".env.relay");
});

afterEach(() => {
  CONFIG.relayEnvPath = realEnvPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("operaattorin kieli", () => {
  it("ei päästä env-avainta läpi edes rivistä jolle ei ole omaa käännöstä", () => {
    const wire = toOperatorCheck({
      name: "Jokin uusi tarkistus",
      status: "fail",
      detail: "RELAY_STREAM_KEY puuttuu — ei mihin pushata",
    });
    expect(wire.detail).not.toContain("RELAY_");
    // Raaka rivi ei katoa: huoltopinta on ainoa paikka jossa se näkyy (#176/9).
    expect(wire.technical).toBe("RELAY_STREAM_KEY puuttuu — ei mihin pushata");
  });

  it("tuntematon RELAY-avain korvautuu yleisellä sanalla", () => {
    expect(redactEnvKeys("RELAY_UUSI_KYTKIN puuttuu")).toBe("ohjaamon sidonta puuttuu");
  });

  it("kääntää kohteen puuttumisen teoksi jonka operaattori voi tehdä", () => {
    const wire = toOperatorCheck({
      name: "Kohde",
      status: "fail",
      detail: "RELAY_STREAM_KEY puuttuu — ei mihin pushata",
    });
    expect(wire.detail).toBe("Selostetulla lähetyksellä ei ole kohdetta — luo lähetyspari.");
  });

  /** #249: relayn oma rivi neuvoo kokeilemaan toista player_clientiä
   *  `RELAY_YTDLP_EXTRACTOR_ARGS`:lla. Yleiskorvaus teki siitä ruudulle
   *  lauseen "Kokeile toista player_clientiä ohjaamon sidonta:lla" — ohje, joka
   *  osoittaa väärään asetukseen. Rivi tulee relayn omasta preflightista asti,
   *  jottei tämä testaa keksittyä tekstiä. */
  it("ei silvo relayn bottitarkistusriviä ohjaamon sidonnaksi", async () => {
    const { checkSource } = await import("../../broadcast/src/preflight.js");
    const raw = await checkSource("https://example.invalid/live", {
      runYtdlp: async () => {
        throw Object.assign(new Error("yt-dlp failed"), {
          stderr: "ERROR: Sign in to confirm you’re not a bot. HTTP Error 429: Too Many Requests",
        });
      },
    });

    const wire = toOperatorCheck(raw);

    expect(wire.detail).not.toContain("RELAY_");
    expect(wire.detail).not.toContain("ohjaamon sidonta");
    // Operaattori saa tietää kumpi pää on vialla — ei "lähde ei vastaa", joka
    // lähettäisi hänet kuvaajan perään kesken ottelun.
    expect(wire.detail).toMatch(/bottitarkistus/i);
    expect(wire.detail).toMatch(/raakalähetys voi silti/i);
    // Raaka rivi säilyy huoltopinnalle.
    expect(wire.technical).toBe(raw.detail);
  });

  it("antaa tuntemattomallekin hakutapa-avaimelle oman sanansa", () => {
    // Viimeinen suoja sille varalta ettei rivillä ole omaa käännöstä.
    expect(redactEnvKeys("Kokeile toista player_clientiä RELAY_YTDLP_EXTRACTOR_ARGS:lla")).not.toContain(
      "ohjaamon sidonta"
    );
    expect(redactEnvKeys("RELAY_YTDLP_EXTRACTOR_ARGS")).toBe("relayn hakutavan asetus");
  });

  it("ei jätä technicalia riville joka on jo operaattorin kieltä", () => {
    const wire = toOperatorCheck({ name: "ffmpeg", status: "ok", detail: "löytyy polusta" });
    expect(wire.technical).toBeUndefined();
  });
});

describe("sidonnan itsekorjaus", () => {
  it("korjaa väärän sidonnan ja jättää teon näkyviin", async () => {
    // Eilinen ottelu, tämän päivän valinta — 31.7.2026:n tilanne.
    writeFileSync(
      CONFIG.relayEnvPath,
      ["RELAY_MATCH_ID=145905", "RELAY_YOUTUBE_URL=https://example.invalid/eilinen", "RELAY_STREAM_KEY=avain-eilen", ""].join("\n"),
    );
    const target = job();

    const result = await runControlPreflight(target, { bindJob: writeRelayEnv });

    const binding = result.checks[0];
    expect(binding.status).toBe("ok");
    expect(binding.fixed).toBe(true);
    expect(binding.detail).toContain("Korjattiin");
    expect(result.blockers).toBe(0);
    // Korjaus on oikeasti tehty tiedostoon, ei vain raportoitu.
    expect(readFileSync(CONFIG.relayEnvPath, "utf8")).toContain("RELAY_MATCH_ID=146210");
  });

  it("ei koske mihinkään ilman korjauslupaa", async () => {
    const before = ["RELAY_MATCH_ID=145905", ""].join("\n");
    writeFileSync(CONFIG.relayEnvPath, before);

    const result = await runControlPreflight(job());

    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].detail).not.toContain("RELAY_");
    expect(result.blockers).toBe(1);
    expect(readFileSync(CONFIG.relayEnvPath, "utf8")).toBe(before);
  });

  it("kertoo esteen jäävän, kun korjaus ei pure", async () => {
    // Sama avain kahdesti: kirjoittaja korvaa ensimmäisen, systemd lukee
    // viimeisen — korjaus ajetaan, eikä se auta. Rivi ei saa väittää muuta.
    writeFileSync(
      CONFIG.relayEnvPath,
      ["RELAY_MATCH_ID=146210", "RELAY_MATCH_ID=145905", ""].join("\n"),
    );

    const result = await runControlPreflight(job(), { bindJob: writeRelayEnv });

    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].fixed).toBeUndefined();
    expect(result.checks[0].detail).toContain("ilmoita ylläpitoon");
    expect(result.checks[0].detail).not.toContain("RELAY_");
  });
});
