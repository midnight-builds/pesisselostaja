/** Etusivu = yksi tilakortti, jonka sisältö seuraa työn tilaa, ja ilman
 *  aktiivista ottelua sen alla on ottelun valinta (#173, toteutus #183).
 *
 *  Nämä ovat rakenteen specit: sanamuoto tulee `shared/jobState.ts`:stä, joten
 *  testi lukee sanat sieltä eikä toista niitä käsin — muuten sanamuodon
 *  muuttaminen kaataisi testin ilman että mikään on rikki. Se mitä tässä
 *  oikeasti väitetään on: mikä tila näkyy, näkyykö valitsin, ja mitä
 *  palvelimelle lähetetään. */

import { expect, stateWord, test } from "./support/harness";
import * as fixture from "./support/state";
import { jobStateWord, NO_JOB_STATE } from "../src/shared/jobState";

const picker = ".picker";

test.describe("tilakortti", () => {
  test("ilman työtä kortti kertoo tilan ja ottelun valinta on näkyvissä", async ({ page, openApp }) => {
    await openApp(fixture.liveState({ job: null, health: "idle", headline: "Ei aktiivista lähetystä" }));

    await expect(stateWord(page)).toHaveText(NO_JOB_STATE.word);
    await expect(page.locator(picker)).toBeVisible();
    // Välilehtipalkkia ei ole enää olemassa.
    await expect(page.locator(".tabbar")).toHaveCount(0);
  });

  test("ottelun napautus luo työn ja kortti siirtyy valmisteluun heti", async ({ page, api, openApp }) => {
    await openApp(fixture.liveState({ job: null, health: "idle", headline: "Ei aktiivista lähetystä" }));

    const row = page.locator(".mrow").first();
    const teams = await row.locator(".mrow__teams").innerText();
    await row.click();

    // Valinta ON työn luonti — erillistä "Luo työ" -vahvistusta ei ole (#171).
    await expect
      .poll(() => api.calledWith("POST", "/api/jobs").length, { timeout: 5000 })
      .toBe(1);
    const body = api.calledWith("POST", "/api/jobs")[0].body as { matchId: number };
    expect(body.matchId).toBeGreaterThan(0);

    // Palvelimen aggregaattori tikittää 5 s välein; kortin on siirryttävä
    // luonnostilaan silti heti, muuten valinta näyttää menneen hukkaan.
    await expect(stateWord(page)).toHaveText(jobStateWord("draft").word);
    await expect(page.locator(picker)).toHaveCount(0);
    expect(teams.length).toBeGreaterThan(0);
  });

  test("liian kauan sitten alkanutta ottelua ei voi valita, ja rivi kertoo miksi", async ({
    page,
    api,
    openApp,
  }) => {
    // Palvelin ei pitäisi tällaista työtä valintana (getActiveJob, #165), joten
    // napautus näyttäisi tekevän jotain ja tila palaisi tähän ilman selitystä.
    api.day = (date) => {
      const day = fixture.dayMatches(date);
      return {
        ...day,
        matches: [
          fixture.matchOption({
            id: 999090,
            home: "Aamun Ottelu",
            away: "Jo Pelattu",
            startsAt: new Date(Date.now() - 8 * 60 * 60_000).toISOString(),
            status: "finished",
            resultString: "3–1",
          }),
        ],
      };
    };
    await openApp(fixture.liveState({ job: null, health: "idle", headline: "Ei aktiivista lähetystä" }));

    await page.getByRole("button", { name: /Näytä menneet/ }).click();
    const row = page.locator(".mrow").first();
    await expect(row).toBeDisabled();
    await expect(row).toContainText("Alkoi liian kauan sitten");
    expect(api.called("POST", "/api/jobs")).toBe(false);
  });

  test("luonnoksesta pääsee vaihtamaan ottelun: työ perutaan ja valitsin palaa", async ({
    page,
    api,
    openApp,
  }) => {
    const draft = fixture.job({ id: "job-draft", status: "draft" });
    await openApp(fixture.liveState({ job: draft, health: "idle", headline: "Ei aktiivista lähetystä" }));

    await expect(stateWord(page)).toHaveText(jobStateWord("draft").word);
    await page.getByRole("button", { name: "Vaihda ottelu" }).click();

    await expect.poll(() => api.calledWith("PATCH", "/api/jobs/job-draft").length).toBe(1);
    expect(api.calledWith("PATCH", "/api/jobs/job-draft")[0].body).toEqual({ status: "cancelled" });
    await expect(page.locator(picker)).toBeVisible();
    await expect(stateWord(page)).toHaveText(NO_JOB_STATE.word);
  });

  test("ottelun aikana kortti on ajossa-tilassa eikä valitsinta näytetä", async ({ page, openApp }) => {
    const live = fixture.liveState({ job: fixture.job({ status: "live" }) });
    await openApp(live);

    await expect(stateWord(page)).toHaveText(jobStateWord("live").word);
    // Palvelimen yhden lauseen tiivistys näkyy kortissa (#186 korvaa sen
    // kertasilmäyksellä).
    await expect(page.getByText(live.headline, { exact: false }).first()).toBeVisible();
    await expect(page.locator(picker)).toHaveCount(0);
    // Otsikko nimeää ottelun, ei sovellusta.
    await expect(page.locator(".topbar__title")).toContainText(live.job!.home);
  });

  test("päättyneen ottelun jälkeen seuraava ottelu voi valita", async ({ page, openApp }) => {
    await openApp(
      fixture.liveState({
        job: fixture.job({ status: "finished", endedAt: "2026-07-29T07:12:00.000Z" }),
        health: "idle",
        headline: "Ei aktiivista lähetystä",
      }),
    );

    await expect(stateWord(page)).toHaveText(jobStateWord("finished").word);
    await expect(page.locator(picker)).toBeVisible();
  });

  test("palvelin voittaa: uusi SSE-kehys syrjäyttää juuri luodun työn", async ({ page, sse, openApp }) => {
    await openApp(fixture.liveState({ job: null, health: "idle", headline: "Ei aktiivista lähetystä" }));
    await page.locator(".mrow").first().click();
    await expect(stateWord(page)).toHaveText(jobStateWord("draft").word);

    // Toinen sessio (tai ajastin) vei valinnan eteenpäin: kortin on kerrottava
    // palvelimen totuus, ei tämän selaimen muistia (#171: yksi totuuslähde).
    await sse.push(
      fixture.liveState({ job: fixture.job({ id: "job-muu", status: "arming" }) }),
    );
    await expect(stateWord(page)).toHaveText(jobStateWord("arming").word);
  });
});
