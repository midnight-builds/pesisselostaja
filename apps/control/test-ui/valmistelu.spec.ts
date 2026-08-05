/** Valmistelu tilakortissa (#184): lähetysparin luonti, sidonta ja
 *  valmiustarkistus.
 *
 *  Neljä väitettä, joista jokainen vastaa yhtä päätöstä:
 *
 *  - Esikatselu on painikkeen yläpuolella ja luonti vaatii kaksi napautusta
 *    (#171/1) — se on ottelupäivän ainoa peruuttamaton, ulospäin näkyvä teko.
 *  - Kun parille on jo lähetyspari, luontia ei tarjota (#171/1: tuplaparin
 *    estää kone, ei kytkin).
 *  - Rivit ovat operaattorin kieltä eikä yhtään env-avainta näy (#176), ja
 *    ohjaamon oma korjaus näkyy tekona.
 *  - Kaikki mahtuu 393 px:n leveyteen ilman vaakavieritystä (#173). */

import { expect, horizontalOverflow, stateWord, test } from "./support/harness";
import * as fixture from "./support/state";
import { jobStateWord } from "../src/shared/jobState";

const CREATE = "Luo lähetyspari";
const CONFIRM = "Vahvista: luo lähetyspari";

function draftJob() {
  return fixture.job({
    id: "job-valmistelu",
    status: "draft",
    targetVideoId: null,
    sourceUrl: null,
    targetStreamKey: null,
    startedAt: null,
  });
}

function scheduledJob() {
  return fixture.job({
    id: "job-valmistelu",
    status: "scheduled",
    targetVideoId: "SELOSTETTU",
    sourceUrl: "https://www.youtube.com/watch?v=NORMAALI",
    startedAt: null,
  });
}

test.describe("valmistelu", () => {
  test("esikatselu näkyy ja luonti vaatii kaksi napautusta", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp(fixture.liveState({ job: draftJob(), health: "idle", headline: "Ei aktiivista lähetystä" }));

    await expect(stateWord(page)).toHaveText(jobStateWord("draft").word);
    // Tekstit ovat luettavissa ennen kuin mitään on luotu — esikatselu ei luo
    // YouTubeen mitään, joten sitä ei tarvitse pyytää erikseen.
    const texts = fixture.broadcastTexts();
    await expect(page.getByText(texts.narratedTitle, { exact: false })).toBeVisible();

    const create = page.getByRole("button", { name: CREATE });
    await create.click();
    // Yksi napautus ei luo mitään: taskussa oleva puhelin ei saa luoda
    // lähetyksiä kanavalle.
    expect(api.called("POST", "/api/youtube/broadcasts")).toBe(false);

    await page.getByRole("button", { name: CONFIRM }).click();
    await expect.poll(() => api.calledWith("POST", "/api/youtube/broadcasts").length).toBe(1);
    const body = api.calledWith("POST", "/api/youtube/broadcasts")[0].body as { jobId: string };
    expect(body.jobId).toBe("job-valmistelu");

    // Luonnin jälkeen jakoviesti on heti kopioitavissa: linkit jaetaan ryhmiin
    // eikä viesti saa näkyä vain kerran (#131).
    await expect(page.getByTestId("share-message")).toContainText("YouTube selostettu:");
  });

  test("kun lähetyspari on jo olemassa, luontia ei tarjota uudelleen", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    await openApp(fixture.liveState({ job: scheduledJob(), health: "idle", headline: "Odottaa raakalähetystä" }));

    await expect(stateWord(page)).toHaveText(jobStateWord("scheduled").word);
    await expect(page.getByRole("button", { name: CREATE })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Avaa selostettu lähetys" })).toBeVisible();
    // Esikatselua ei myöskään haeta: se koskee luontia, jota ei enää ole.
    expect(api.called("POST", "/api/youtube/templates/preview")).toBe(false);
  });

  // #203: pari ilman stream keytä ei ole pari. `hasPair` laskettiin pelkästä
  // videoId:stä, joten kortti siirtyi "pari on olemassa" -haaraan ja
  // luontipainike katosi pysyvästi — samalla kun valmiustarkistus neuvoi
  // luomaan lähetysparin. Käsikenttiä ei ole enää (#176), joten kentällä ei
  // ollut mitään tehtävissä.
  test("ilman stream keytä luonti pysyy tarjolla", async ({ page, api, openApp }) => {
    const vajaa = fixture.job({
      id: "job-valmistelu",
      status: "draft",
      targetVideoId: "SELOSTETTU",
      targetStreamKey: null,
      sourceUrl: "https://www.youtube.com/watch?v=NORMAALI",
      startedAt: null,
    });
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [vajaa];
    await openApp(fixture.liveState({ job: vajaa, health: "idle", headline: "Ei aktiivista lähetystä" }));

    await expect(page.getByRole("button", { name: CREATE })).toBeVisible();
  });

  test("valmiustarkistus näyttää korjauksen tekona ja esteen operaattorin kielellä", async ({
    page,
    api,
    openApp,
  }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    api.preflight = fixture.preflightRepaired();
    await openApp(fixture.liveState({ job: scheduledJob(), health: "idle", headline: "Odottaa raakalähetystä" }));

    await expect.poll(() => api.calledWith("POST", "/api/preflight").length).toBeGreaterThan(0);
    // Sidonta ajetaan aina valittua työtä vasten (#155) — ilman id:tä preflight
    // kertoisi totuuden jostain toisesta ottelusta.
    expect(api.calledWith("POST", "/api/preflight")[0].body).toEqual({ jobId: "job-valmistelu" });

    // Nimenomaan valmiustarkistuksen korjaus: käynnistysvahti (#185) kertoo
    // omansa samalla sanamuodolla, joten pelkkä "Korjattiin:" osuisi kahteen.
    await expect(page.getByText("Korjattiin: ohjaamo osoitti", { exact: false })).toBeVisible();
    await expect(page.getByText("Selostetulla lähetyksellä ei ole kohdetta", { exact: false })).toBeVisible();
    // Kunnossa olevat rivit eivät täytä ruutua; niistä kerrotaan lukuna.
    await expect(page.getByText("löytyy polusta")).toHaveCount(0);

    // Tekninen totuus kulkee mukana wire-muodossa, mutta EI näy ruudulla (#176).
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("RELAY_");
    expect(body).not.toContain(".env.relay");
  });

  // #221: "Muokkaa otsikkoa" -kenttien placeholderit olivat kovakoodattuja
  // esimerkkejä TOISESTA ottelusta. Puhelimen ruudulla harmaa esimerkki
  // lukeutuu kentän arvoksi, joten näkymä väitti työn olevan sidottu väärään
  // otteluun — juuri se pelko jota vastaan valmiustarkistus on rakennettu.
  test("otsikkokenttien placeholderit tulevat käsillä olevasta ottelusta", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    await openApp(fixture.liveState({ job: draftJob(), health: "idle", headline: "Ei aktiivista lähetystä" }));

    await page.getByText("Muokkaa otsikkoa").click();
    const texts = fixture.broadcastTexts();
    const home = page.getByLabel("Kotijoukkue");
    const away = page.getByLabel("Vierasjoukkue");
    const venue = page.getByLabel("Paikka lyhyesti");

    // Arvot ovat tyhjiä — otsikko muodostuu ilman muokkausta.
    await expect(home).toHaveValue("");
    await expect(away).toHaveValue("");
    await expect(venue).toHaveValue("");

    // ...ja se mitä kentissä lukee on TÄMÄN ottelun pari oikein päin
    // (koti ensin, `teamPair`) sekä tämän ottelun paikka.
    await expect(home).toHaveAttribute("placeholder", texts.homeTeam);
    await expect(away).toHaveAttribute("placeholder", texts.awayTeam);
    await expect(venue).toHaveAttribute("placeholder", texts.thumbnailVenue);

    // Yksikään vieraan ottelun nimi ei saa esiintyä missään kortilla.
    const body = await page.locator("body").innerText();
    for (const stranger of ["Pesä Ysit F-pojat", "IPV", "Naperoleiri Liperi"]) {
      expect(body).not.toContain(stranger);
    }
    for (const stranger of ["Pesä Ysit F-pojat", "IPV", "Naperoleiri Liperi"]) {
      expect(await page.locator(`css=input[placeholder="${stranger}"]`).count()).toBe(0);
    }
  });

  test("valmistelu mahtuu puhelimen leveyteen ilman vaakavieritystä", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    api.preflight = fixture.preflightRepaired();
    await openApp(fixture.liveState({ job: scheduledJob(), health: "idle", headline: "Odottaa raakalähetystä" }));

    await expect(page.getByTestId("share-message")).toBeVisible();
    expect(await horizontalOverflow(page)).toEqual([]);
  });
});
