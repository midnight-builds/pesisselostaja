/** Ottelunaikainen kertasilmäys tilakortissa (#186).
 *
 *  Väitteet vastaavat yksi yhteen niitä päätöksiä, jotka tämän tilan muodon
 *  ratkaisivat:
 *
 *  - Ottelun aikana katsotaan viittä tietoa ja kosketaan kolmea säätöä (#169,
 *    kolmas lisätty #244:ssä), ja kaiken on mahduttava 393 px:n ruudulle ILMAN
 *    vieritystä (#173). Tämä tiedosto on se lupaus testinä — ja juuri siksi
 *    säädön lisääminen tarkistetaan täällä eikä silmämääräisesti.
 *  - Viive JA miksaussuhde säädetään olemassa olevan control-tiedostosauman
 *    kautta (#172, #244): napit ovat suhteellisia, ja ohjaamosta relayyn ei
 *    avata uutta kanavaa.
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

/** Se ruutu, joka iPhonella oikeasti jää sovellukselle.
 *
 *  Playwrightin WebKit antaa `env(safe-area-inset-*)`:lle nollan, joten spec
 *  mittasi ruutua jota laitteessa ei ole (#207): `index.html` on
 *  `viewport-fit=cover` + `black-translucent`, ja kotivalikosta avatussa
 *  sovelluksessa yläreuna vie ~59 px ja kotipalkki ~34 px. Turva-aluetta ei voi
 *  testiympäristössä syöttää `env()`:iin, joten sama tila mitataan siltä
 *  puolelta jolta voi: pienennetään ruutua tasan noiden kaistojen verran.
 *  CSS lukee lisäksi `--safe-top`/`--safe-bottom`-muuttujat `env()`:n rinnalla,
 *  jotta kaistat voi myös piirtää näkyviin. */
const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;

async function withSafeAreas(page: import("@playwright/test").Page): Promise<void> {
  const size = page.viewportSize();
  await page.setViewportSize({
    width: size?.width ?? 393,
    height: (size?.height ?? 853) - SAFE_TOP - SAFE_BOTTOM,
  });
}

/** Onko elementti kokonaan ruudun sisällä. Näkyvyys ei riitä: ruudun
 *  alapuolelle työntynyt nappi on Playwrightille yhä "visible". */
async function fullyOnScreen(
  page: import("@playwright/test").Page,
  testId: string | { role: "switch"; name: RegExp },
): Promise<boolean> {
  const locator =
    typeof testId === "string" ? page.getByTestId(testId) : page.getByRole("switch", { name: testId.name });
  const box = await locator.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  return box !== null && box.y >= 0 && box.y + box.height <= height;
}

test.describe("ottelunaikainen", () => {
  test("viisi tietoa ja kolme säätöä mahtuvat ruudulle ilman vieritystä", async ({
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
    // Jaksovoitot ja käynnissä oleva jakso, ei juoksujen summaa (#229):
    // fikstuurin summa on 5–3, ja juuri se ei saa näkyä.
    await expect(glance).toContainText("KUV 1 – 0 LAP jaksoissa · 2. jakso 2–2");
    await expect(glance).not.toContainText("KUV 5 – 3 LAP");
    await expect(glance).toContainText("2. jakso, 2 paloa");
    // Sisävuoro on oma tietonsa: palot kuuluvat vain lyövälle joukkueelle.
    await expect(page.locator(".fact").nth(4)).toContainText("LAP");

    // Kolme säätöä ja selostuslista, kaikki näkyvissä yhtä aikaa.
    await expect(page.getByRole("button", { name: /liian aikaisin/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /liian myöhään/i })).toBeVisible();
    // Miksaussuhde (#244): napit nimeävät kuultavan oireen, kuten viiveenkin.
    await expect(page.getByRole("button", { name: /kentän äänet liian hiljaa/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /selostus liian hiljaa/i })).toBeVisible();
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

  /** Miksaussuhteen säätö (#244). Ottelussa 136770 (16.8.2026) kentän äänet
   *  olivat liian hiljaa suhteessa selostukseen, ja ainoa keino oli
   *  `.env.relay` + relayn restart — eli katko selostettuun lähetykseen kesken
   *  ottelun. Säätö kulkee samaa control-tiedostosaumaa kuin viive, joten
   *  relay ottaa sen käyttöön seuraavassa klipissä ilman katkoa. */
  test("miksaussuhdetta voi säätää kesken ottelun ja arvo näkyy heti", async ({
    page,
    api,
    openApp,
  }) => {
    api.jobs = [liveJob()];
    // Sekä SSE-tila (mitä ruutu näyttää) että api.knobs (mitä reitti muuttaa):
    // ilman jälkimmäistä napautus laskisi oletuksesta eikä tästä arvosta.
    api.knobs = fixture.knobs({ narrationGain: 1.3 });
    await openLive(openApp, { knobs: fixture.knobs({ narrationGain: 1.3 }) });

    const glance = page.getByTestId("match-glance");
    await expect(glance).toContainText("1.30");

    await page.getByRole("button", { name: /kentän äänet liian hiljaa/i }).click();
    // Optimistinen arvo näkyy heti eikä vasta SSE-kierroksen jälkeen: säätöä
    // haetaan korvakuulolta monella napautuksella peräkkäin.
    await expect(glance).toContainText("1.25");
    expect(api.knobs.narrationGain).toBe(1.25);

    await page.getByRole("button", { name: /selostus liian hiljaa/i }).click();
    await expect(glance).toContainText("1.30");
    expect(api.knobs.narrationGain).toBe(1.3);
  });

  test("miksaussuhteen säätö pysähtyy rajoihinsa", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    api.knobs = fixture.knobs({ narrationGain: 0.5 });
    await openLive(openApp, { knobs: fixture.knobs({ narrationGain: 0.5 }) });

    // Alarajalla vaimennusnappi on pois käytöstä — napautus, joka ei tee
    // mitään, on pahempi kuin nappi joka kertoo olevansa lopussa.
    await expect(page.getByRole("button", { name: /kentän äänet liian hiljaa/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /selostus liian hiljaa/i })).toBeEnabled();
  });

  /** #228: ajossa olevasta kortista ei päässyt kumpaankaan lähetykseen, joten
   *  operaattori joutui etsimään omat lähetyksensä YouTubesta kesken ajon.
   *  Linkit ovat tilasanoissa, koska kortti on kertasilmäys (#186) — uusia
   *  nappirivejä siihen ei lisätä. */
  test("kortista pääsee molempiin lähetyksiin", async ({ page, api, openApp }) => {
    const withPair = fixture.job({
      id: "job-ottelu",
      status: "live",
      startedAt: "2026-07-29T04:48:00.000Z",
      targetVideoId: "SELOSTETTU11",
      sourceUrl: "https://www.youtube.com/watch?v=TESTSOURCE1",
    });
    api.jobs = [withPair];
    await openApp(fixture.liveState({ job: withPair }));

    const narrated = page.getByRole("link", { name: "Selostus" });
    await expect(narrated).toHaveAttribute("href", "https://www.youtube.com/watch?v=SELOSTETTU11");
    const raw = page.getByRole("link", { name: "Raakalähetys" });
    await expect(raw).toHaveAttribute("href", "https://www.youtube.com/watch?v=TESTSOURCE1");

    for (const link of [narrated, raw]) {
      // PWA on kotinäytöllä: ohjaamosta ei saa navigoida pois kesken ajon.
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noreferrer");
      // Kosketusalue täyttää --tapin, vaikka teksti on pientä.
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // Kortti pysyy kertasilmäyksenä: viisi tietoa, ei uutta riviä.
    await expect(page.locator(".fact")).toHaveCount(5);
    expect(await pageScrolls(page)).toBe(false);
  });

  /** Ilman työn kenttiä linkkiä ei ole — eikä siihen keksitä osoitetta.
   *  Rikkinäinen linkki YouTubeen on pahempi kuin puuttuva: se näyttää
   *  toimivalta juuri sinä hetkenä, jona lähetystä ollaan tarkistamassa. */
  test("ilman osoitetta tilasana ei ole linkki", async ({ page, api, openApp }) => {
    const bare = fixture.job({
      id: "job-ottelu",
      status: "live",
      startedAt: "2026-07-29T04:48:00.000Z",
      targetVideoId: null,
      sourceUrl: null,
    });
    api.jobs = [bare];
    await openApp(fixture.liveState({ job: bare }));

    await expect(page.getByTestId("match-glance")).toContainText("Selostus");
    await expect(page.getByRole("link", { name: "Selostus" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Raakalähetys" })).toHaveCount(0);
  });

  /** #207: 393 px:n lupaus mitattiin ilman turva-alueita ja ilman
   *  hälytysrivejä — eli siinä tilassa, jossa budjetti on väljimmillään.
   *  Ruutua oikeasti katsotaan siinä toisessa tilassa: kaksi yhtaikaista
   *  hälytystä ja monirivinen arvo. Silloin `.narration` kutistui nollaan ja
   *  säätimet työntyivät ruudun alapuolelle — eivät hankalasti saataville vaan
   *  tavoittamattomiin, koska `.app` on `overflow: hidden` eikä sivu vieri. */
  test("säätimet pysyvät ruudulla myös turva-alueiden ja hälytysten kanssa", async ({
    page,
    api,
    openApp,
  }) => {
    api.jobs = [liveJob()];
    await openLive(openApp, {
      system: fixture.systemState({ diskCritical: true }),
      telemetry: null,
      narration: [],
      conflict: { job: 999001, running: 999002 },
    });
    await withSafeAreas(page);

    // Molemmat hälytykset päällä — se on tämän testin koko pointti.
    await expect(page.getByTestId("glance-alert")).toHaveCount(2);

    // Säätimet ovat kokonaan ruudulla, eivät vain "visible".
    expect(await fullyOnScreen(page, { role: "switch", name: /vaihtoselostus/i })).toBe(true);
    // Selostuslista ei ole puristunut nollaan saadakseen muun mahtumaan.
    const list = await page.getByTestId("narration-list").boundingBox();
    expect(list?.height ?? 0).toBeGreaterThan(120);
    expect(await horizontalOverflow(page)).toEqual([]);
  });

  // #250: YouTube päätti selostetun lähetyksen kesken ottelun (16.8.2026).
  // Relayn kirjanpito näyttää tervettä ajoa — työntö kuolleeseen kohteeseen
  // onnistuu — joten ilman tätä riviä kortti olisi vihreä samalla kun
  // katsojien linkki osoittaa päättyneeseen videoon.
  test("kuollut kohde kesken ottelun nostaa hälytysrivin", async ({ page, api, openApp }) => {
    const job = { ...liveJob(), targetVideoId: "TESTTARGET1" };
    api.jobs = [job];
    await openApp(
      fixture.liveState({
        job,
        targetIngest: {
          observedAt: fixture.NOW,
          videoId: "TESTTARGET1",
          lifeCycleStatus: "complete",
          streamStatus: null,
          healthStatus: null,
          notFound: "no",
          error: null,
        },
      }),
    );

    await expect(page.getByTestId("glance-alert")).toHaveText(/Selostettu lähetys on päättynyt/);
  });

  // #252: sama hälytys, eri kuolintapa — lähetys on poistettu käsin, jolloin
  // YouTube ei palauta siitä mitään. Selain ajaa oman kopionsa jaetusta
  // säännöstä, joten tämä pinnaa senkin — ja tekstin, joka ei saa väittää
  // lähetyksen "päättyneen": operaattori etsisi sitä turhaan Studiosta.
  test("käsin poistettu kohde nostaa hälytysrivin omalla sanamuodollaan", async ({ page, api, openApp }) => {
    const job = { ...liveJob(), targetVideoId: "TESTTARGET1" };
    api.jobs = [job];
    await openApp(
      fixture.liveState({
        job,
        targetIngest: {
          observedAt: fixture.NOW,
          videoId: "TESTTARGET1",
          lifeCycleStatus: null,
          streamStatus: null,
          healthStatus: null,
          notFound: "confirmed",
          error: null,
        },
      }),
    );

    await expect(page.getByTestId("glance-alert")).toHaveText(/ei enää ole YouTubessa/);
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

  test("tulospalvelusta jäljessä oleva selostus sanotaan sekunteina (#120)", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    // Jono on tyhjä eikä relayssä ole mitään vikaa — tapahtumat vain saadaan
    // tulospalvelusta myöhässä. Ottelussa 145900 tämä oli 43 s, ja kuulija
    // huomasi sen ennen kuin ohjaamo olisi voinut kertoa siitä mitään.
    await openLive(openApp, {
      telemetry: fixture.telemetry({
        pendingClips: 0,
        match: { finished: false, eventCount: 412, lastEventAt: "2026-07-29T05:29:40.000Z", sourceLagMs: 43_000 },
      }),
    });

    await expect(page.locator(".fact--warn")).toContainText("Jäljessä tulospalvelusta (43 s)");
  });

  test("tavanomainen julkaisuviive ei riko vihreää riviä (#120)", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    // 20 s on tämän syötteen normaalia. Jos tämä värjäytyisi, kortti olisi
    // keltainen koko ottelun ja lakkaisi kertomasta mitään.
    await openLive(openApp, {
      telemetry: fixture.telemetry({
        match: { finished: false, eventCount: 412, lastEventAt: "2026-07-29T05:29:40.000Z", sourceLagMs: 20_000 },
      }),
    });

    await expect(page.getByTestId("match-glance")).toContainText("Kuuluu lähetyksessä");
  });

  test("mittaamaton viive ei ole sama kuin nolla (#120)", async ({ page, api, openApp }) => {
    api.jobs = [liveJob()];
    // Vanhempi deploy ei julkaise kenttää lainkaan. Rivi ei saa siitä muuttua
    // — muttei myöskään väittää mitään viiveestä.
    await openLive(openApp, {
      telemetry: fixture.telemetry({
        match: { finished: false, eventCount: 412, lastEventAt: "2026-07-29T05:29:40.000Z", sourceLagMs: null },
      }),
    });

    await expect(page.getByTestId("match-glance")).toContainText("Kuuluu lähetyksessä");
    await expect(page.getByTestId("match-glance")).not.toContainText("Jäljessä tulospalvelusta");
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
    //
    // Kehys on se, jonka OIKEA palvelin tuottaa (#202): ristiriidassa
    // `telemetry` on null, koska se on luettu työn ottelulla eli väärän, ja
    // ristiriita kulkee omassa kentässään. Aiempi versio tästä testistä työnsi
    // eri ottelun telemetrian — kehyksen jota palvelin ei voi tuottaa — ja
    // antoi siksi väärän turvan.
    await openLive(openApp, {
      telemetry: null,
      narration: [],
      conflict: { job: 999001, running: 999002 },
    });

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
