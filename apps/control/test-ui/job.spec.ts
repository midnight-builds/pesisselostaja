/** Työ-näkymä: the form that decides which stream is read and which one is
 *  pushed to, and the preflight gate in front of the start button. The gate is
 *  a safety feature: if blockers can be clicked past, the relay starts into a
 *  known-broken configuration. */

import { expect, test, shot, view } from "./support/harness";
import * as fixture from "./support/state";
import { job, liveState, preflightResult, preflightWithBlockers, relayProcess } from "./support/state";

async function openJob(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Työ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Raakalähetys ja selostettu lähetys" })).toBeVisible();
}

test.describe("työn lomake", () => {
  test("näyttää valitun työn tiedot", async ({ page, openApp }, info) => {
    await openApp();
    await openJob(page);

    // Scoped to the job view: the same pairing is also listed (hidden) in the
    // always-mounted Ottelut view.
    await expect(
      view(page, "job").getByText("Kuvitteellisen Kylän Veikot – Lapinlahden Peikot"),
    ).toBeVisible();
    await expect(page.getByText(/ottelu 999001/)).toBeVisible();
    await shot(page, info, "job-form");
  });

  test("stream key on oletuksena peitossa ja Näytä paljastaa sen", async ({ page, openApp }) => {
    await openApp();
    await openJob(page);

    const key = page.getByLabel(/stream key/);
    await expect(key).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: "Näytä" }).click();
    await expect(key).toHaveAttribute("type", "text");
    await expect(key).toHaveValue("aaaa-bbbb-cccc-dddd");

    await page.getByRole("button", { name: "Piilota" }).click();
    await expect(key).toHaveAttribute("type", "password");
  });

  test("Tallenna tiedot lähettää PATCHin kentän arvoilla", async ({ page, openApp, api }) => {
    await openApp();
    await openJob(page);

    await page.getByLabel(/YouTube-URL/).fill("https://www.youtube.com/watch?v=UUSILAHDE");
    await page.getByRole("button", { name: "Näytä" }).click();
    await page.getByLabel(/stream key/).fill("1111-2222-3333-4444");

    await page.getByRole("button", { name: "Tallenna tiedot" }).click();

    await expect.poll(() => api.called("PATCH", "/api/jobs/job-0001")).toBe(true);
    expect(api.calledWith("PATCH", "/api/jobs/job-0001")[0].body).toEqual({
      sourceUrl: "https://www.youtube.com/watch?v=UUSILAHDE",
      targetStreamKey: "1111-2222-3333-4444",
      targetRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    });
    // Saving alone must not arm the job.
    expect(api.called("POST", "/api/jobs/job-0001/activate")).toBe(false);
  });

  test("Kirjoita .env.relay tallentaa ensin ja kutsuu sitten activate-reittiä", async ({
    page,
    openApp,
    api,
  }) => {
    await openApp();
    await openJob(page);

    await page.getByRole("button", { name: "Kirjoita .env.relay" }).click();

    await expect.poll(() => api.called("POST", "/api/jobs/job-0001/activate")).toBe(true);
    const order = api.calls
      // Vain kirjoitukset: näkymä myös LUKEE työn jakoviestin (#131), ja se
      // haku osuu samaan polkuun. Väite koskee kirjoitusten järjestystä.
      .filter((c) => c.path.startsWith("/api/jobs/job-0001") && c.method !== "GET")
      .map((c) => `${c.method} ${c.path}`);
    expect(order[0], "lomake tallennetaan ennen aktivointia").toBe("PATCH /api/jobs/job-0001");
    expect(order).toContain("POST /api/jobs/job-0001/activate");
  });

  test("ilman työtä näkymä ohjaa ottelun valintaan", async ({ page, openApp, api }) => {
    api.jobs = [];
    await openApp(liveState({ job: null }));

    await page.getByRole("button", { name: "Työ", exact: true }).click();
    await expect(page.getByText("Valitse ottelu Ottelut-välilehdeltä ja luo työ.")).toBeVisible();
  });
});

/** #129: lähetysten luonti siirtyi YouTube-välilehdeltä TÄHÄN näkymään, koska
 *  ottelun valinta, lähetykset, jakoviesti, preflight ja käynnistys ovat yksi
 *  polku. Testit tulivat mukana youtube.spec.ts:stä; kaksi porttia (esikatselu
 *  näkyvissä, kaksi napautusta) ovat samat, mutta niiden eteen ei enää tarvita
 *  painallusta — esikatselu ajetaan itsestään.
 *
 *  #95: jaettava viesti on se mitä WhatsApp-ryhmiin liimataan, ja otsikon
 *  joukkuenimet eivät tule tulospalvelusta — ne kysytään. */
test.describe("lähetysten luonti Työ-välilehdellä", () => {
  const CREATE = "Luo lähetykset YouTubeen";
  const CONFIRM = "Vahvista: luo 2 lähetystä";

  /** Esikatselu ilmestyy itsestään (600 ms viive korttissa). Sen otsikko on
   *  se merkki, että luontinappi on olemassa ja teksti sen yllä. */
  async function waitForPreview(page: import("@playwright/test").Page): Promise<void> {
    await expect(page.getByRole("heading", { name: "Luo lähetykset" })).toBeVisible({ timeout: 15_000 });
  }

  test("esikatselu ajetaan itsestään ilman painallusta, ja luonti odottaa sitä", async ({
    page,
    openApp,
    api,
  }) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();

    // Ennen välilehden avaamista korttia ei ole ajettu: esikatselu on ilmainen,
    // mutta se on silti YouTube-reitti eikä sitä saa kutsua taustalla.
    await expect(page.locator('[data-view="live"]')).toBeVisible();
    expect(api.calls.filter((c) => c.path.startsWith("/api/youtube/"))).toHaveLength(0);
    await expect(page.getByRole("button", { name: CREATE })).toHaveCount(0);

    await openJob(page);
    await waitForPreview(page);

    expect(api.called("POST", "/api/youtube/templates/preview")).toBe(true);
    // Esikatselu ei luo mitään: luontireitille ei ole menty.
    expect(api.called("POST", "/api/youtube/broadcasts")).toBe(false);
    await expect(page.getByRole("button", { name: CREATE })).toBeEnabled();
  });

  test("otsikkokentät menevät esikatseluun ja viesti käyttää niitä", async ({ page, openApp, api }, info) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openJob(page);

    await page.getByLabel("Oma joukkue otsikossa (valinnainen)").fill("Pesä Ysit F-pojat");
    await page.getByLabel("Vastustaja otsikossa (valinnainen)").fill("IPV");

    // Ei painallusta: kentän muutos mitätöi esikatselun ja kortti hakee uuden.
    await expect
      .poll(
        () =>
          api
            .calledWith("POST", "/api/youtube/templates/preview")
            .filter((c) => (c.body as { overrides?: Record<string, string> }).overrides?.opponent === "IPV").length,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const preview = api
      .calledWith("POST", "/api/youtube/templates/preview")
      .filter((c) => (c.body as { overrides?: Record<string, string> }).overrides?.opponent === "IPV")
      .at(-1)!;
    expect((preview.body as { overrides?: Record<string, string> }).overrides).toEqual({
      teamLabel: "Pesä Ysit F-pojat",
      opponent: "IPV",
    });
    await expect(page.getByText(/Seuraava live on klo 8:30: Pesä Ysit F-pojat - IPV/)).toBeVisible();
    await shot(page, info, "job-preview-overrides");
  });

  test("esikatselu mahtuu operaattorin puhelimen ruudulle — tekstit rivittyvät, kuvat skaalautuvat (#129)", async ({
    page,
    openApp,
    api,
  }, info) => {
    // Tämä on se aukko, jonka takia vika pääsi kentälle: asettelutesti kiertää
    // kaikki välilehdet, mutta EI odota esikatselua, joten sen sisältöä ei ollut
    // koskaan mitattu 393 px:n ruudulla. Operaattori raportoi molemmat ("tekstit
    // eivät rivity", "kuvat eivät mahdu ruutuun") ensimmäisestä ohjaamolla
    // tehdystä ajastuksesta.
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openJob(page);
    await waitForPreview(page);

    // Mitataan elementin OMAA ylivuotoa (scrollWidth vs clientWidth) eikä
    // dokumentin vieritystä: `<pre>`:n rivittymätön sisältö jää `.scroll`
    // -säiliön sisään, joten sivu ei vierrä vaakaan vaikka teksti on katkennut
    // ruudun reunaan. Juuri sen operaattori näkee.
    const measured = await page.evaluate(() => {
      const scope = document.querySelector('[data-view="job"]') ?? document;
      const rows = [...scope.querySelectorAll<HTMLElement>(".textblock, .textline")].map((el) => ({
        kind: el.className,
        overflow: el.scrollWidth - el.clientWidth,
        text: (el.textContent ?? "").slice(0, 30),
      }));
      const images = [...scope.querySelectorAll<HTMLImageElement>(".thumb__img")].map((el) => ({
        width: el.getBoundingClientRect().width,
      }));
      return { rows, images, viewport: document.documentElement.clientWidth };
    });

    expect(measured.rows.length, "esikatselussa pitää olla tekstilaatikoita mitattavaksi").toBeGreaterThan(0);
    for (const row of measured.rows) {
      expect(row.overflow, `"${row.text}…" ei rivity ruudulle`).toBeLessThanOrEqual(1);
    }
    expect(measured.images.length, "esikatselussa pitää olla thumbnailit").toBeGreaterThan(0);
    for (const img of measured.images) {
      // Kaksi suuntaa, koska mock palauttaa 1×1-pikselin eikä oikeaa 1280 px:n
      // komposiittia: yläraja kiinnittää oikean maailman ylivuodon, alaraja
      // todistaa että skaalaussääntö on ylipäätään voimassa — ilman sitä
      // 1-pikselinen kuva menisi läpi vaikka oikea kuva vuotaisi ruudun yli.
      expect(img.width, "thumbnail ei mahdu ruudulle").toBeLessThanOrEqual(measured.viewport);
      expect(img.width, "thumbnailia ei skaalata säiliön leveyteen").toBeGreaterThan(
        measured.viewport * 0.5,
      );
    }

    await shot(page, info, "job-preview-mobile");
  });

  test("ensimmäinen napautus ei vielä luo mitään — vasta vahvistus luo", async ({ page, openApp, api }) => {
    // Kuittauskytkin poistui (#129), joten kaksoisnapautus on ainoa jäljellä
    // oleva portti taskussa tapahtuvan painalluksen ja kanavalle näkyvän,
    // peruuttamattoman lähetysparin välissä.
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openJob(page);
    await waitForPreview(page);

    await page.getByRole("button", { name: CREATE }).click();
    await page.waitForTimeout(300);
    expect(api.called("POST", "/api/youtube/broadcasts"), "yksi napautus ei saa luoda lähetyksiä").toBe(false);

    await page.getByRole("button", { name: CONFIRM }).click();
    await expect.poll(() => api.calledWith("POST", "/api/youtube/broadcasts").length).toBe(1);
  });

  test("luonnin jälkeen jaettava viesti on kokonaisuudessaan kopioitavissa", async ({ page, openApp, api }, info) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp();
    await openJob(page);
    await waitForPreview(page);

    await page.getByRole("button", { name: CREATE }).click();
    await page.getByRole("button", { name: CONFIRM }).click();

    const message = page.getByTestId("share-message");
    await expect(message).toBeVisible();
    // Paikkamerkkien tilalla ovat oikeat linkit — juuri se erottaa luodun
    // viestin esikatselusta.
    await expect(message).toContainText("YouTube: https://www.youtube.com/watch?v=NORMAALI");
    await expect(message).toContainText("YouTube selostettu: https://www.youtube.com/watch?v=SELOSTETTU");
    await expect(message).toContainText("Tulospalvelu: https://www.pesistulokset.fi/ottelut/999001");
    // Eikä stream key koskaan: viesti menee ulkopuolisille.
    await expect(message).not.toContainText("cccc-dddd");

    await expect(page.getByRole("button", { name: "Kopioi jaettava viesti" }).first()).toBeEnabled();
    // Terminologia: luotujen lista puhuu raakalähetyksestä, ei "normaalista".
    await expect(page.getByRole("term").filter({ hasText: "Raakalähetys" }).first()).toBeVisible();
    await expect(page.getByText("Selostetun lähetyksen video id")).toBeVisible();
    await shot(page, info, "job-share-message");
  });

  /** UUSI (#129). Tätä ei voinut olla vanhassa sarjassa: YouTube-välilehdellä
   *  kortti ei tuntenut työtä eikä koskenut sen tilaan. Ilman siirtymää työ jää
   *  "draft"-tilaan, jolloin ajastin ei koskaan ota sitä ehdokkaaksi — lähetykset
   *  olisivat kanavalla, mutta mikään ei käynnistäisi niitä. */
  test("luonti siirtää luonnostyön scheduled-tilaan", async ({ page, openApp, api }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [job({ id: "job-0001", status: "draft" })];
    await openApp(liveState({ job: null }));
    await openJob(page);
    await waitForPreview(page);

    await page.getByRole("button", { name: CREATE }).click();
    await page.getByRole("button", { name: CONFIRM }).click();

    await expect
      .poll(() =>
        api
          .calledWith("PATCH", "/api/jobs/job-0001")
          .filter((c) => (c.body as { status?: string }).status === "scheduled").length,
      )
      .toBe(1);
    // Ja tila näkyy näkymässä, ei vain verkkoliikenteessä.
    await expect(view(page, "job").getByText("scheduled").first()).toBeVisible();
  });

  test("jo käynnissä olevan työn tilaa ei siirretä taaksepäin", async ({ page, openApp, api }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [job({ id: "job-0001", status: "live" })];
    await openApp();
    await openJob(page);
    await waitForPreview(page);

    await page.getByRole("button", { name: CREATE }).click();
    await page.getByRole("button", { name: CONFIRM }).click();
    await expect.poll(() => api.called("POST", "/api/youtube/broadcasts")).toBe(true);

    expect(
      api.calledWith("PATCH", "/api/jobs/job-0001").filter((c) => (c.body as { status?: string }).status),
      "live-työtä ei saa merkitä uudelleen ajastetuksi",
    ).toHaveLength(0);
  });
});

test.describe("preflight-portti", () => {
  test("tulokset renderöityvät ✓/⚠/✗-merkein", async ({ page, openApp, api }, info) => {
    api.preflight = preflightResult();
    await openApp(liveState({ relay: relayProcess({ active: false, activeState: "inactive" }) }));
    await openJob(page);

    await page.getByRole("button", { name: "Aja preflight" }).click();
    await expect(page.getByText("Ei esteitä, 1 huomautus — relay voidaan käynnistää.")).toBeVisible();

    const row = (name: string) => page.getByRole("listitem").filter({ hasText: name });
    await expect(row("ffmpeg")).toContainText("✓");
    await expect(row("Levytila")).toContainText("⚠");
    await expect(page.getByText("1 varoitusta, käynnistys sallittu.")).toBeVisible();

    await shot(page, info, "preflight-ok");
  });

  test("esteet estävät käynnistyksen", async ({ page, openApp, api }, info) => {
    api.preflight = preflightWithBlockers();
    await openApp(liveState({ relay: relayProcess({ active: false, activeState: "inactive" }) }));
    await openJob(page);

    const start = page.getByRole("button", { name: "Käynnistä relay" });
    await expect(start, "ennen preflightia käynnistys on sallittu").toBeEnabled();

    await page.getByRole("button", { name: "Aja preflight" }).click();
    await expect(page.getByText("2 estettä — älä käynnistä relayta.")).toBeVisible();

    const row = (name: string) => page.getByRole("listitem").filter({ hasText: name });
    await expect(row("RELAY_STREAM_KEY")).toContainText("✗");
    await expect(row("Lähde-URL")).toContainText("✗");
    await expect(page.getByText("2 estoa — korjaa ennen käynnistystä.")).toBeVisible();
    await expect(page.getByText("Preflightin esteet estävät käynnistyksen.")).toBeVisible();

    // The gate itself: disabled, and a forced tap still sends nothing.
    await expect(start).toBeDisabled();
    await start.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    expect(api.called("POST", "/api/relay/start"), "estetty käynnistys ei saa lähteä").toBe(false);

    await shot(page, info, "preflight-blocked");
  });

  test("puhtaan preflightin jälkeen käynnistys lähtee", async ({ page, openApp, api }) => {
    api.preflight = preflightResult({ checks: [{ name: "ffmpeg", status: "ok", detail: "ok" }], blockers: 0, warnings: 0, summary: "Kaikki kunnossa — relay voidaan käynnistää." });
    await openApp(liveState({ relay: relayProcess({ active: false, activeState: "inactive" }) }));
    await openJob(page);

    await page.getByRole("button", { name: "Aja preflight" }).click();
    await expect(page.getByText("Ei esteitä.")).toBeVisible();

    const start = page.getByRole("button", { name: "Käynnistä relay" });
    await expect(start).toBeEnabled();
    await start.click();
    await expect.poll(() => api.called("POST", "/api/relay/start")).toBe(true);
  });

  test("jo ajossa oleva relay ei ole käynnistettävissä uudelleen", async ({ page, openApp, api }) => {
    await openApp(liveState({ relay: relayProcess({ active: true }), job: job() }));
    await openJob(page);

    await expect(page.getByRole("button", { name: "Käynnistä relay" })).toBeDisabled();
    await expect(page.getByText("Relay on jo ajossa.")).toBeVisible();
    expect(api.called("POST", "/api/relay/start")).toBe(false);
  });
});

/** #101: siirtymä ottelusta seuraavaan. Aktivointi torjutaan niin kauan kuin
 *  edellinen työ pitää lähetyspaikkaa — ja se on tila, ei kaatuminen: sille on
 *  nappi, ei punaista virheilmoitusta. Osuu hetkeen jossa edellinen peli on
 *  ohi, seuraava on jo alkanut ja kamera on siirtymässä. */
test.describe("edellinen työ tukkii lähetyspaikan", () => {
  test("torjuttu aktivointi tarjoaa napin, ei virhettä", async ({ page, openApp, api }, info) => {
    api.jobs = [
      job({ id: "job-edellinen", status: "live", home: "Kuusikon Kipinä", away: "Rantalan Rasti" }),
      job({ id: "job-seuraava", status: "draft" }),
    ];
    await openApp(liveState({ job: job({ id: "job-edellinen", status: "live" }) }));
    await openJob(page);

    await view(page, "job").locator("select").selectOption("job-seuraava");
    await page.getByRole("button", { name: "Kirjoita .env.relay" }).click();

    await expect(page.getByText(/on jo lähetyksessä/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Lopeta edellinen ja aktivoi tämä" })).toBeVisible();
    await shot(page, info, "job-clash");
  });

  test("nappi vaatii kaksi napautusta ja aktivoi vasta sitten", async ({ page, openApp, api }) => {
    api.jobs = [
      job({ id: "job-edellinen", status: "live", home: "Kuusikon Kipinä", away: "Rantalan Rasti" }),
      job({ id: "job-seuraava", status: "draft" }),
    ];
    await openApp(liveState({ job: job({ id: "job-edellinen", status: "live" }) }));
    await openJob(page);

    await view(page, "job").locator("select").selectOption("job-seuraava");
    await page.getByRole("button", { name: "Kirjoita .env.relay" }).click();

    const forceButton = page.getByRole("button", { name: "Lopeta edellinen ja aktivoi tämä" });
    await forceButton.click();
    // Ensimmäinen napautus vain virittää: mitään ei ole vielä lähetetty.
    expect(api.calledWith("POST", "/api/jobs/job-seuraava/activate").filter((c) => (c.body as { force?: boolean })?.force).length).toBe(0);

    await page.getByRole("button", { name: "Varmista: lopeta edellinen" }).click();
    await expect
      .poll(() => api.calledWith("POST", "/api/jobs/job-seuraava/activate").filter((c) => (c.body as { force?: boolean })?.force === true).length)
      .toBe(1);
    // Ja torjuntalaatikko katoaa, koska aktivointi meni läpi.
    await expect(page.getByText(/on jo lähetyksessä/)).toBeHidden();
  });
});
