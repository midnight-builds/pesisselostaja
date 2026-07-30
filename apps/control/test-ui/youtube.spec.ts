/** YouTube-välilehti. Näiden testien tärkein tehtävä on todeta, että välilehti
 *  on käyttökelpoinen NIMENOMAAN ilman Google-yhteyttä: se on tila jossa
 *  ohjaamo on tänään, ja kortit oli rakennettu mutta jätetty kytkemättä
 *  kuoreen (koko 1240 riviä oli tavoittamattomissa). Jos jokin näistä hajoaa,
 *  välilehti on käytännössä taas poissa.
 *
 *  Kaikki avaukset menevät `openApp`in kautta: se asentaa API-mockin. Suora
 *  page.goto ohittaisi mockin ja päästäisi testin oikeaan palvelimeen. */

import { expect, test, shot } from "./support/harness";
import * as fixture from "./support/state";

async function openYouTube(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "YouTube", exact: true }).click();
}

test.describe("YouTube-välilehti", () => {
  test("on olemassa ja avautuu", async ({ page, openApp }) => {
    await openApp();
    await expect(page.getByRole("button", { name: "YouTube", exact: true })).toBeVisible();
    await openYouTube(page);
    await expect(page.locator('[data-view="youtube"]')).toBeVisible();
  });

  test("kertoo ilman yhteyttä että tiliä ei ole yhdistetty — eikä näytä virhettä", async ({
    page,
    api,
    openApp,
  }) => {
    await openApp();
    await openYouTube(page);

    await expect(page.getByText("Google-tiliä ei ole yhdistetty.").first()).toBeVisible();
    // Puuttuva yhteys on tila, ei vika: mitään "palvelinvirhe"-sanaa ei saa näkyä.
    await expect(page.getByText(/palvelinvirhe/i)).toHaveCount(0);
    expect(api.called("GET", "/api/youtube/health")).toBe(true);
  });

  test("alemmat kortit tarjoavat reitin yhdistämiseen", async ({ page, openApp }) => {
    await openApp();
    await openYouTube(page);
    await expect(page.getByText("Google-yhteyttä ei ole muodostettu").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Siirry yhdistämään" }).first()).toBeVisible();
  });

  /** Terveys kuluttaa Googlen kiintiötä, jota googleAuth.ts erikseen laskee.
   *  Kaikki näkymät pysyvät mountattuina (App.tsx), joten ilman active-ehtoa
   *  tämä pollaisi taustalla koko ottelun ajan. */
  test("ei koske YouTubeen ennen kuin välilehti avataan", async ({ page, api, openApp }) => {
    await openApp();
    await expect(page.locator('[data-view="live"]')).toBeVisible();
    expect(api.calls.filter((c) => c.path.startsWith("/api/youtube/"))).toHaveLength(0);

    await openYouTube(page);
    await expect.poll(() => api.called("GET", "/api/youtube/health")).toBe(true);
  });

  test("yhdistettynä näyttää kanavan eikä enää yhdistämiskehotusta", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openYouTube(page);

    await expect(page.getByText("Talonkuningas").first()).toBeVisible();
    await expect(page.getByText("Google-yhteyttä ei ole muodostettu")).toHaveCount(0);
  });

  /** Väärä tili näyttää joka mittarilla terveeltä ja julkaisisi lasten ottelun
   *  vieraalle kanavalle — GoogleAuthCardin oma otsikkokommentti nostaa tämän
   *  vakavimmaksi asiaksi jonka kortti voi raportoida. */
  test("väärä kanava erottuu oikeasta", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected({
      channel: { id: "UCsomeoneelse", title: "Joku muu kanava" },
    });
    await openApp();
    await openYouTube(page);

    await expect(page.getByText("Joku muu kanava").first()).toBeVisible();
  });
});

/** #95: jaettava viesti on se mitä WhatsApp-ryhmiin liimataan, ja otsikon
 *  joukkuenimet eivät tule tulospalvelusta — ne kysytään. */
test.describe("lähetysten luonti", () => {
  test("otsikkokentät menevät esikatseluun ja viesti käyttää niitä", async ({ page, openApp, api }, info) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await page.getByRole("button", { name: "YouTube", exact: true }).click();

    await page.getByLabel("Oma joukkue otsikossa (valinnainen)").fill("Pesä Ysit F-pojat");
    await page.getByLabel("Vastustaja otsikossa (valinnainen)").fill("IPV");
    await page.getByRole("button", { name: "Esikatsele tekstit" }).click();

    const preview = api.calledWith("POST", "/api/youtube/templates/preview")[0];
    expect((preview.body as { overrides?: Record<string, string> }).overrides).toEqual({
      teamLabel: "Pesä Ysit F-pojat",
      opponent: "IPV",
    });
    await expect(page.getByText(/Seuraava live on klo 8:30: Pesä Ysit F-pojat - IPV/)).toBeVisible();
    await shot(page, info, "youtube-preview-overrides");
  });

  test("luonnin jälkeen jaettava viesti on kokonaisuudessaan kopioitavissa", async ({ page, openApp, api }, info) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await page.getByRole("button", { name: "YouTube", exact: true }).click();

    await page.getByRole("button", { name: "Esikatsele tekstit" }).click();
    await expect(page.getByRole("heading", { name: "Luo lähetykset" })).toBeVisible();

    await page.getByRole("button", { name: /Olen tarkistanut/ }).click();
    await page.getByRole("button", { name: "Luo lähetykset YouTubeen" }).click();
    await page.getByRole("button", { name: "Vahvista: luo 2 lähetystä" }).click();

    const message = page.getByTestId("share-message");
    await expect(message).toBeVisible();
    // Paikkamerkkien tilalla ovat oikeat linkit — juuri se erottaa luodun
    // viestin esikatselusta.
    await expect(message).toContainText("YouTube: https://www.youtube.com/watch?v=NORMAALI");
    await expect(message).toContainText("YouTube selostettu: https://www.youtube.com/watch?v=SELOSTETTU");
    await expect(message).toContainText("Tulospalvelu: https://www.pesistulokset.fi/ottelut/999001");
    // Eikä stream key koskaan: viesti menee ulkopuolisille.
    await expect(message).not.toContainText("cccc-dddd");

    await expect(page.getByRole("button", { name: "Kopioi jaettava viesti" })).toBeEnabled();
    await shot(page, info, "youtube-share-message");
  });
});
