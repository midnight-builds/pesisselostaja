/** Ajastettu-tila ja käynnistysvahti tilakortissa (#185).
 *
 *  Viisi väitettä, joista jokainen vastaa yhtä päätöstä:
 *
 *  - Käynnistysikkuna on ilmoitushetki, ei vuorovaikutushetki (#170) — kortissa
 *    ei ole käynnistysnappia, vaan lupaus siitä että se käynnistyy itsestään.
 *  - Ohjaamo kytkee ajastimen päälle itse ja kertoo tekonsa (#171: itsekorjaus
 *    operaattorin valitsemaan otteluun), koska pois päältä oleva ajastin on se
 *    vika, jonka huomaa vasta kun lähetys ei alkanut.
 *  - Jo päällä olevaan ei kosketa: itsekorjaus ei ole joka avauksella toistuva
 *    kirjoitus.
 *  - Este kerrotaan operaattorin kielellä ja käskymuodossa; ajastimen oma
 *    sanamuoto (yt-dlp, tiedostot) ei näy ruudulla (#176).
 *  - Kaikki mahtuu 393 px:n leveyteen (#173). */

import { expect, horizontalOverflow, stateWord, test } from "./support/harness";
import * as fixture from "./support/state";
import { jobStateWord } from "../src/shared/jobState";

const JOB_ID = "job-ajastettu";

function scheduledJob() {
  return fixture.job({
    id: JOB_ID,
    status: "scheduled",
    targetVideoId: "SELOSTETTU",
    sourceUrl: "https://www.youtube.com/watch?v=NORMAALI",
    startsAt: "2026-07-29T06:30:00.000Z", // 09.30, tunti fixture-nykyhetkestä
    startedAt: null,
  });
}

/** Ajastimen tila, joka seuraa juuri tätä työtä. */
function watching(p: Parameters<typeof fixture.schedulerState>[0] = {}) {
  return fixture.schedulerState({
    nextJob: { ...fixture.schedulerState().nextJob!, id: JOB_ID },
    ...p,
  });
}

function openScheduled(openApp: (state: ReturnType<typeof fixture.liveState>) => Promise<void>) {
  return openApp(
    fixture.liveState({ job: scheduledJob(), health: "idle", headline: "Odottaa raakalähetystä" })
  );
}

test.describe("ajastettu", () => {
  test("kortti lupaa itsekäynnistyksen eikä tarjoa käynnistysnappia", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    api.scheduler = watching({ enabled: true });
    await openScheduled(openApp);

    await expect(stateWord(page)).toHaveText(jobStateWord("scheduled").word);
    const guard = page.getByTestId("start-guard");
    await expect(guard).toContainText("käynnistyy itsestään");
    // Ottelun alku on kellonaikana JA suhteessa nykyhetkeen: pelkkä kellonaika
    // ei kerro onko odotus vielä pitkä (#170).
    await expect(guard).toContainText("Ottelu alkaa klo 09.30");
    await expect(guard).toContainText("1 h kuluttua");
    // Käynnistysikkuna on ilmoitushetki: mitään ei odoteta operaattorilta.
    await expect(page.getByRole("button", { name: /käynnistä/i })).toHaveCount(0);
  });

  test("pois päältä oleva käynnistysvahti kytketään päälle ja teko näytetään", async ({
    page,
    api,
    openApp,
  }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    api.scheduler = watching({ enabled: false });
    await openScheduled(openApp);

    await expect.poll(() => api.calledWith("POST", "/api/scheduler/enable").length).toBe(1);
    expect(api.calledWith("POST", "/api/scheduler/enable")[0].body).toEqual({ enabled: true });
    await expect(page.getByText("Korjattiin:", { exact: false })).toBeVisible();
  });

  test("jo päällä olevaa vahtia ei kirjoiteta uudelleen", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    api.scheduler = watching({ enabled: true });
    await openScheduled(openApp);

    await expect(page.getByTestId("start-guard")).toContainText("Käynnistysvahti päällä");
    expect(api.called("POST", "/api/scheduler/enable")).toBe(false);
    await expect(page.getByText("Korjattiin:", { exact: false })).toHaveCount(0);
  });

  test("este kerrotaan käskymuodossa eikä ajastimen omalla kielellä", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    api.scheduler = watching({
      enabled: true,
      lastAction: {
        at: fixture.NOW,
        decision: "blocked-busy",
        jobId: JOB_ID,
        reason: "Toinen työ on ajossa — yt-dlp: livenä, HLS-manifesti (täysi laatu).",
        applied: false,
      },
    });
    await openScheduled(openApp);

    await expect(page.getByText("Lopeta se ensin", { exact: false })).toBeVisible();
    // Ajastimen oma perustelu jää lokiin: se puhuu työkaluista, ei ottelusta.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("yt-dlp");
    expect(body).not.toContain("HLS");
  });

  test("väärää ottelua seuraava vahti sanotaan ääneen", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    // Sama ansa kuin #155:n väärä sidonta, vain aiemmassa vaiheessa: vahti
    // seuraa eri ottelua kuin se, joka kortissa lukee.
    api.scheduler = fixture.schedulerState({ enabled: true });
    await openScheduled(openApp);

    await expect(page.getByText("Käynnistysvahti seuraa ottelua", { exact: false })).toBeVisible();
  });

  test("ajastettu tila mahtuu puhelimen leveyteen ilman vaakavieritystä", async ({ page, api, openApp }) => {
    api.authHealth = fixture.authHealthConnected();
    api.jobs = [scheduledJob()];
    api.scheduler = watching({ enabled: true });
    await openScheduled(openApp);

    await expect(page.getByTestId("start-guard")).toBeVisible();
    expect(await horizontalOverflow(page)).toEqual([]);
  });
});
