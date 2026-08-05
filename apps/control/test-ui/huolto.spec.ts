/** Huoltoarkki (#188) — kartan viimeinen tiketti.
 *
 *  Arkki on kaikkea muuta kuin ottelupäivän polku: yhteys, ilmoitukset,
 *  jakoviestin sanamuoto ja loki. Sen olemassaolon ehto on, että se pysyy
 *  poissa — jos jokin sen sisällöstä vuotaa tilakorttiin, koko #173:n
 *  kertasilmäys menetetään.
 *
 *  Väitteet, jokainen yhtä päätöstä vasten:
 *
 *  - Etusivu ei näytä huoltoa ennen kuin hammasratasta napautetaan (#173).
 *  - Toimiva Google-yhteys on yksi kuittausrivi, ei tokenin ikä eikä scopet
 *    (#176) — ja rikkoutuessaan se kasvaa käskyksi.
 *  - Uusinta käynnistää laitevirran ja näyttää koodin; kenttiä ei ole (#176:
 *    UI ei kysy client id:tä eikä secretiä).
 *  - Loki näkyy koneen kielellä: tämä on ohjaamon ainoa tekninen taso, koska
 *    SSH:ta ei käytetä koskaan.
 *  - Jakoviestin pohja tallentuu OSITTAISENA patchina, jottei kenttäsiivouksen
 *    kytkin nollaudu sivutuotteena (#133).
 *  - Arkki sulkeutuu ja palauttaa ottelupäivän polulle.
 *  - Ottelunaikainen kertasilmäys ei kasva arkin takia: 393 px ilman
 *    vaakavieritystä ja hammasratas on sormenkokoinen. */

import { expect, horizontalOverflow, stateWord, test } from "./support/harness";
import * as fixture from "./support/state";

async function openSheet(page: import("@playwright/test").Page) {
  await page.getByTestId("gear").click();
  await expect(page.getByTestId("service-sheet")).toBeVisible();
}

test.describe("huoltoarkki", () => {
  /** #208: `StartGuard`in oma kommentti väitti kytkimen olevan huoltoarkissa,
   *  mutta `schedulerEnable` esiintyi koko clientissä kerran ja aina arvolla
   *  `true`. Tila on pysyvä, joten ensimmäisen mountin jälkeen vahti oli
   *  päällä ikuisesti — myös päivinä joina kukaan ei ole kentällä. */
  test("käynnistysvahdin saa kytkettyä molempiin suuntiin", async ({ page, api, openApp }) => {
    api.scheduler = fixture.schedulerState({ enabled: true });
    await openApp();
    await openSheet(page);

    const toggle = page.getByTestId("scheduler-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect.poll(() => api.calledWith("POST", "/api/scheduler/enable").length).toBe(1);
    expect(api.calledWith("POST", "/api/scheduler/enable")[0].body).toEqual({ enabled: false });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("scheduler-check")).toContainText("pois päältä");

    // Ja takaisin päälle: yksisuuntainen kytkin oli koko vika.
    await toggle.click();
    await expect.poll(() => api.calledWith("POST", "/api/scheduler/enable").length).toBe(2);
    expect(api.calledWith("POST", "/api/scheduler/enable")[1].body).toEqual({ enabled: true });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("pois päältä oleva vahti näyttää mitä se olisi tehnyt", async ({ page, api, openApp }) => {
    // Kuiva-ajo on koko syy siihen että vahdin uskaltaa kytkeä päälle: se
    // laskee päätöksen kirjoittamatta mitään.
    api.scheduler = fixture.schedulerState({
      enabled: false,
      wouldHaveDone: {
        at: fixture.NOW,
        decision: "waiting",
        jobId: "job-1",
        reason: "Kuusikon Kipinä – Rantalan Rasti: raakalähetys ei ole vielä livenä.",
        applied: false,
      },
    });
    await openApp();
    await openSheet(page);

    await expect(page.getByTestId("scheduler-check")).toContainText("Olisi tehnyt:");
  });

  test("huolto on piilossa, kunnes hammasratasta napautetaan", async ({ page, openApp }) => {
    await openApp();

    await expect(page.getByTestId("service-sheet")).toHaveCount(0);
    await expect(stateWord(page)).toBeVisible();

    await openSheet(page);
    await expect(page.getByTestId("google-check")).toBeVisible();
  });

  test("toimiva Google-yhteys on yksi kuittausrivi ilman teknisiä tunnisteita", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openSheet(page);

    const google = page.getByTestId("google-check");
    await expect(google).toContainText("Google-yhteys kunnossa");
    await expect(google).toContainText("Talonkuningas");
    // Kielletty tekninen taso (#176): scopet, tokenin ikä, client id.
    await expect(google).not.toContainText("googleapis.com");
    await expect(google).not.toContainText("token");
    await expect(page.getByTestId("google-warnings")).toHaveCount(0);
  });

  test("vanhentuva yhteys kasvaa varoitukseksi ja käskyksi", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected({
      health: "fail",
      daysSinceSuccess: 7.4,
      warnings: ["Yhteys on ollut 7,4 vrk ilman onnistunutta päivitystä. Kirjaudu uudelleen."],
    });
    await openApp();
    await openSheet(page);

    await expect(page.getByTestId("google-check")).toContainText("vaatii huomiota");
    await expect(page.getByTestId("google-warnings")).toContainText("Kirjaudu uudelleen");
  });

  test("uusinta käynnistää laitevirran ja näyttää koodin — kenttiä ei ole", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openSheet(page);

    await page.getByTestId("google-renew").click();

    await expect(page.getByTestId("google-flow")).toContainText("ABCD-EFGH");
    expect(api.called("POST", "/api/youtube/auth/start")).toBe(true);
    // Yhtään tunnistekenttää ei ole: pyyntö menee palvelimen omilla tiedoilla.
    const body = api.calledWith("POST", "/api/youtube/auth/start")[0]?.body as Record<string, unknown>;
    expect(body?.clientId).toBeUndefined();
    await expect(page.getByTestId("google-check").locator("input")).toHaveCount(0);
  });

  test("loki näkyy koneen kielellä ja suodattuu tasolla", async ({ page, api, openApp }) => {
    await openApp();
    await openSheet(page);

    await expect(page.getByTestId("log-lines")).toBeVisible();
    await page.getByRole("button", { name: "Virheet" }).click();

    await expect
      .poll(() => api.calledWith("GET", "/api/log").some((call) => call.search.includes("level=error")))
      .toBe(true);
  });

  test("jakoviestin tallennus on osittainen: kenttäsiivous ei nollaudu", async ({ page, api, openApp }) => {
    await openApp();
    await openSheet(page);

    const box = page.getByTestId("share-template");
    await box.fill("Uusi avaus {matchup}\nYouTube: {watchUrl}");
    await page.getByTestId("share-save").click();

    await expect.poll(() => api.calledWith("PATCH", "/api/settings").length).toBeGreaterThan(0);
    const body = api.calledWith("PATCH", "/api/settings")[0]?.body as Record<string, unknown>;
    expect(body.venueCleanup).toBeUndefined();
    expect(api.settings.venueCleanup.stripFieldNumber).toBe(true);
    expect(api.settings.shareTemplate.opening).toBe("Uusi avaus {matchup}");
  });

  test("kesken jäänyt kirjautuminen jatkuu itsestään, eikä vanhentunut koodi lukitse korttia", async ({
    page,
    api,
    openApp,
  }) => {
    // Palvelimella on kesken oleva laitevirta, jonka koodi on yhä voimassa:
    // arkin avaaminen jatkaa pollausta ilman että mitään painetaan.
    api.authHealth = fixture.authHealth({
      pending: {
        userCode: "WXYZ-1234",
        verificationUrl: "https://www.google.com/device",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
    await openApp();
    await openSheet(page);

    await expect(page.getByTestId("google-flow")).toContainText("WXYZ-1234");
    await expect.poll(() => api.called("POST", "/api/youtube/auth/poll"), { timeout: 15_000 }).toBe(true);
  });

  test("vanhentunut laitevirta ei jätä korttia umpikujaan", async ({ page, api, openApp }) => {
    // Sama kesken jäänyt kirjautuminen, mutta koodi on vanhentunut. Ilman
    // expiresAt:n lukemista kortti näytti kuollutta koodia ikuisesti eikä
    // yhteyttä voinut enää uusia — ohjaamosta ei ole SSH-varapolkua (#176).
    api.authHealth = fixture.authHealth({
      pending: {
        userCode: "VANHA-KOODI",
        verificationUrl: "https://www.google.com/device",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    await openApp();
    await openSheet(page);

    await expect(page.getByTestId("google-stale-flow")).toBeVisible();
    await expect(page.getByTestId("google-flow")).toHaveCount(0);
    await expect(page.getByTestId("google-renew")).toBeVisible();
  });

  test("tyhjää jakoviestiä ei voi tallentaa", async ({ page, api, openApp }) => {
    await openApp();
    await openSheet(page);

    await page.getByTestId("share-template").fill("   ");

    await expect(page.getByTestId("share-empty")).toBeVisible();
    await expect(page.getByTestId("share-save")).toBeDisabled();
    expect(api.called("PATCH", "/api/settings")).toBe(false);
  });

  test("ajastushetki pysyy topbarissa pitkilläkin sarja- ja kenttänimillä", async ({ page, openApp }) => {
    // Hammasratas puristi metarivin kolmeen pisteeseen, ja kellonaika oli
    // rivin hännässä: ottelupäivänä ajastushetki olisi kadonnut oikeilla,
    // fixtuureja pidemmillä nimillä.
    await openApp(
      fixture.liveState({
        job: fixture.job({
          seriesName: "Miesten Superpesis, alkusarjan kotiottelu",
          stadium: "Kuvitteellisen Kylän keskuskenttä, tekonurmi",
        }),
      })
    );

    await expect(page.locator(".topbar__meta")).toContainText("klo");
    expect(await horizontalOverflow(page)).toEqual([]);
  });

  test("arkki sulkeutuu ja palauttaa ottelupäivän polulle", async ({ page, openApp }) => {
    await openApp();
    await openSheet(page);

    await page.getByTestId("sheet-close").click();

    await expect(page.getByTestId("service-sheet")).toHaveCount(0);
    await expect(stateWord(page)).toBeVisible();
  });

  test("arkki mahtuu puhelimen ruudulle eikä hammasratas ole sormea pienempi", async ({ page, openApp }) => {
    await openApp();

    const gear = page.getByTestId("gear");
    const box = await gear.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);

    await openSheet(page);
    expect(await horizontalOverflow(page)).toEqual([]);
  });
});
