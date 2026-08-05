/** Ottelunaikainen kertasilmäys tilakortissa (#186).
 *
 *  Väitteet vastaavat yksi yhteen niitä päätöksiä, jotka tämän tilan muodon
 *  ratkaisivat:
 *
 *  - Ottelun aikana katsotaan viittä tietoa ja kosketaan kahta säätöä (#169),
 *    ja kaiken on mahduttava 393 px:n ruudulle ILMAN vieritystä (#173). Tämä
 *    tiedosto on se lupaus testinä.
 *  - Viive säädetään olemassa olevan control-tiedostosauman kautta (#172):
 *    napit ovat suhteellisia, ja ohjaamosta relayyn ei avata uutta kanavaa.
 *  - Koneen kieli ei näy ottelupäivän polulla (#176): ei ffmpegiä, ei
 *    yt-dlp:tä, ei stream keytä, ei commit-tunnusta.
 *  - Katvekuva ja irronnut ffmpeg ovat ne kaksi tilaa, joissa lähetys näyttää
 *    ulospäin sujuvalta mutta ei ole — kumpikaan ei saa näyttää vihreältä
 *    (#104, ottelun 145889 viisi hiljaista minuuttia). */

import { expect, horizontalOverflow, test } from "./support/harness";
import * as fixture from "./support/state";

function liveJob() {
  return fixture.job({ id: "job-ottelu", status: "live", startedAt: "2026-07-29T04:48:00.000Z" });
}

function openLive(
  openApp: (state: ReturnType<typeof fixture.liveState>) => Promise<void>,
  p: Partial<ReturnType<typeof fixture.liveState>> = {},
) {
  return openApp(fixture.liveState({ job: liveJob(), ...p }));
}

/** Vierisikö sivu pystysuunnassa. Selostuslista vierii omassa laatikossaan —
 *  se on tarkoitus — mutta sivu itse ei saa vieriä, koska silloin säädöt
 *  valuisivat ruudun alapuolelle juuri kun niitä tarvitaan. */
async function pageScrolls(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".scroll");
    if (!scroller) return true;
    return scroller.scrollHeight > scroller.clientHeight + 1;
  });
}

test.describe("ottelunaikainen", () => {
  test("viisi tietoa ja kaksi säätöä mahtuvat ruudulle ilman vieritystä", async ({
    page,
    api,
    openApp,
  }) => {
    api.jobs = [liveJob()];
    await openLive(openApp);

    const glance = page.getByTestId("match-glance");
    await expect(glance).toBeVisible();

    // Viisi tietoa, ei kuutta: inventaario (#169) löysi ottelun aikana
    // katsotuksi täsmälleen nämä.
    await expect(page.locator(".fact")).toHaveCount(5);
    await expect(glance).toContainText("Selostus");
    await expect(glance).toContainText("Raakalähetys");
    await expect(glance).toContainText("KUV 5 – 3 LAP");
    await expect(glance).toContainText("2. jakso, 2 paloa");
    // Sisävuoro on oma tietonsa: palot kuuluvat vain lyövälle joukkueelle.
    await expect(page.locator(".fact").nth(4)).toContainText("LAP");

    // Kaksi säätöä ja selostuslista, kaikki näkyvissä yhtä aikaa.
    await expect(page.getByRole("button", { name: /liian aikaisin/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /liian myöhään/i })).toBeVisible();
    await expect(page.getByRole("switch", { name: /vaihtoselostus/i })).toBeVisible();
    await expect(page.getByTestId("narration-list")).toBeVisible();

    expect(await horizontalOverflow(page)).toEqual([]);
    expect(await pageScrolls(page)).toBe(false);

    // "Ei vieritystä" olisi tyhjä lupaus jos selostuslista puristuisi nollaan
    // saadakseen kiinteän osan mahtumaan: lista on tämän tilan diagnoosiväline
    // (#170), ja kaiken on mahduttava ruudulle yhtä aikaa.
    const list = await page.getByTestId("narration-list").boundingBox();
    expect(list?.height ?? 0).toBeGreaterThan(120);
    const toggle = await page.getByRole("switch", { name: /vaihtoselostus/i }).boundingBox();
    expect((toggle?.y ?? 0) + (toggle?.height ?? 0)).toBeLessThanOrEqual(853);
  });

  test("viiveen nudge menee control-tiedoston reittiä ja uusi arvo näkyy heti", async ({
    page,
    api,
    openApp,
  }) => {
    api.jobs = [liveJob()];
    await openLive(openApp);

    await expect(page.getByText("4,0 s")).toBeVisible();
    await page.getByRole("button", { name: /liian aikaisin/i }).click();

    await expect.poll(() => api.calledWith("POST", "/api/knobs/delay-nudge").length).toBe(1);
    expect(api.calledWith("POST", "/api/knobs/delay-nudge")[0].body).toEqual({ deltaMs: 500 });
    // SSE ei ole vielä kertonut muutosta takaisin: ilman paikallista arvoa
    // nappi näyttäisi siltä ettei se tehnyt mitään, ja viivettä säädetään
    // korvakuulolta monta napautusta peräkkäin.
    await expect(page.getByText("4,5 s")).toBeVisible();
  });

  test("vaihtoselostuksen kytkin kirjoittaa vain oman kenttänsä", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    await openLive(openApp);

    const toggle = page.getByRole("switch", { name: /vaihtoselostus/i });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();

    await expect.poll(() => api.calledWith("POST", "/api/knobs").length).toBe(1);
    expect(api.calledWith("POST", "/api/knobs")[0].body).toEqual({ announceBatterChanges: false });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("selostus joka ei kuulu lähetyksessä on punainen rivi", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    // Relayn kirjanpito käy täyttä vauhtia, mutta ffmpeg on irti: klipit
    // syntyvät eikä yksikään päädy lähetykseen.
    await openLive(openApp, { telemetry: fixture.telemetry({ readerAttached: false }) });

    await expect(page.locator(".fact--fail")).toContainText("Ei kuulu lähetyksessä");
  });

  test("katvekuva ei näytä vihreältä", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    await openLive(openApp, {
      telemetry: fixture.telemetry({
        source: { state: "no_signal", detail: "yt-dlp: manifest stale" },
      }),
    });

    await expect(page.locator(".fact--warn")).toContainText("Kuva poikki, selostus jatkuu");
  });

  test("koneen kieltä ei näy ottelupäivän polulla", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    await openLive(openApp, {
      // Palvelimen tiivistys puhuu työkaluista; tilakortti ei näytä sitä.
      headline: "ffmpeg respawnasi 3× viime minuutteina — kuva pätkii",
      telemetry: fixture.telemetry({ source: { state: "live", detail: "yt-dlp: HLS-manifesti" } }),
    });

    const body = await page.locator("body").innerText();
    for (const leak of ["ffmpeg", "yt-dlp", "HLS", "rtmp", "commit", "aaaa-bbbb", ".env"]) {
      expect(body, `koneen kieli ruudulla: ${leak}`).not.toContain(leak);
    }
  });

  test("vanhentunut tilannekuva luetaan tietämättömyytenä eikä vihreänä", async ({
    page,
    api,
    openApp,
  }) => {
    api.jobs = [liveJob()];
    // Relay pysähtyi, mutta sen viimeinen tilannekuva jäi levylle. Ilman
    // tuoreusvertailua kortti näyttäisi kymmenen minuutin takaista "kuuluu
    // lähetyksessä" -riviä vihreänä juuri silloin kun mitään ei kuulu.
    await openLive(openApp, {
      telemetry: fixture.telemetry({ at: "2026-07-29T05:18:00.000Z" }),
    });

    await expect(page.locator(".fact").first()).toContainText("Ei tietoa");
    await expect(page.locator(".fact--ok")).toHaveCount(0);
  });

  test("väärää ottelua ajava lähetys sanotaan ääneen säätöjen vieressä", async ({
    page,
    api,
    openApp,
  }) => {
    api.jobs = [liveJob()];
    // #118: säädöt kirjoittuvat ohjaamon työn otteluun, mutta ajossa oleva
    // relay lukee toisen ottelun control-tiedostoa — napit lakkaavat
    // vaikuttamasta mihinkään, hiljaa.
    await openLive(openApp, { telemetry: fixture.telemetry({ matchId: 999002 }) });

    await expect(page.getByTestId("glance-alert")).toContainText("Säädöt eivät mene perille");
  });

  test("neljä nopeaa napautusta näkyy neljänä askeleena", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    await openLive(openApp);

    const earlier = page.getByRole("button", { name: /liian aikaisin/i });
    for (let i = 0; i < 4; i++) await earlier.click();

    // Viivettä kalibroidaan korvakuulolta, monta napautusta peräkkäin: yksikään
    // ei saa kadota "edellinen pyyntö on kesken" -lukkoon.
    await expect.poll(() => api.calledWith("POST", "/api/knobs/delay-nudge").length).toBe(4);
    await expect(page.getByText("6,0 s")).toBeVisible();
  });

  test("selostuslista erottaa kuullun, jonossa olevan ja kuulumattoman", async ({
    page,
    api,
    openApp,
  }) => {
    api.jobs = [liveJob()];
    await openLive(openApp);

    const list = page.getByTestId("narration-list");
    await expect(list).toContainText("Kotiutus! Veikot johtaa 5–3.");
    await expect(list.locator(".narration__row--queued")).toHaveCount(1);
    await expect(list.locator(".narration__row--muted")).toContainText("ei kuulunut");
  });
});
