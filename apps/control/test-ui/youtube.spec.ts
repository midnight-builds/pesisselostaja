/** YouTube-välilehti. Näiden testien tärkein tehtävä on todeta, että välilehti
 *  on käyttökelpoinen NIMENOMAAN ilman Google-yhteyttä: se on tila jossa
 *  ohjaamo on tänään, ja kortit oli rakennettu mutta jätetty kytkemättä
 *  kuoreen (koko 1240 riviä oli tavoittamattomissa). Jos jokin näistä hajoaa,
 *  välilehti on käytännössä taas poissa.
 *
 *  Kaikki avaukset menevät `openApp`in kautta: se asentaa API-mockin. Suora
 *  page.goto ohittaisi mockin ja päästäisi testin oikeaan palvelimeen. */

import { expect, test } from "./support/harness";
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

  /** #129: lähetysten luonti muutti pois täältä Työ-välilehdelle. Sen kattavuus
   *  on job.spec.ts:ssä; täällä varmistetaan vain, ettei korttia ole kahdessa
   *  paikassa — kaksi luontinappia on tapa luoda pari kahdesti. */
  test("ei enää sisällä lähetysten luontia (siirtyi Työ-välilehdelle)", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openYouTube(page);

    const tab = page.locator('[data-view="youtube"]');
    await expect(tab.getByRole("button", { name: "Luo lähetykset YouTubeen" })).toHaveCount(0);
    await expect(tab.getByRole("heading", { name: "Luo lähetykset" })).toHaveCount(0);
    // Eikä esikatselua ajeta täältä: se kuuluu nyt Työ-välilehdelle.
    await page.waitForTimeout(1000);
    expect(api.called("POST", "/api/youtube/templates/preview")).toBe(false);
  });
});
