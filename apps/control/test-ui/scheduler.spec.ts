/** Ajastinkortti Työ-välilehdellä.
 *
 *  Näiden testien painopiste ei ole ulkoasussa vaan siinä, ettei kortti voi
 *  vahingossa virittää ajastinta: se on ainoa osa ohjaamoa joka saa käynnistää
 *  lähetyksen ilman ihmistä. Siksi tässä testataan erikseen että pelkkä
 *  avaaminen ei kytke mitään, ja että päälle kytkeminen vaatii vahvistuksen. */

import { expect, test } from "./support/harness";
import * as fixture from "./support/state";

async function openJob(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Työ", exact: true }).click();
}

const card = '[data-card="scheduler"]';

test.describe("ajastin", () => {
  test("näkyy pois päältä eikä kytke itseään pelkästä avaamisesta", async ({ page, api, openApp }) => {
    await openApp();
    await openJob(page);

    await expect(page.locator(card).getByText("POIS PÄÄLTÄ")).toBeVisible();
    // Ainoa sallittu kutsu on tilan luku. Jos tänne ilmestyy enable-kutsu,
    // ohjaamo on juuri virittänyt automaattikäynnistyksen kysymättä.
    expect(api.called("POST", "/api/scheduler/enable")).toBe(false);
    expect(api.called("GET", "/api/scheduler")).toBe(true);
  });

  test("näyttää kuivaharjoituksen: mitä olisi tehnyt, ilman sivuvaikutuksia", async ({ page, api, openApp }) => {
    api.scheduler = fixture.schedulerState({
      wouldHaveDone: {
        at: fixture.NOW,
        decision: "start",
        jobId: "job-1",
        reason: "Lähde on livenä ja preflight on puhdas.",
        applied: false,
      },
    });
    await openApp();
    await openJob(page);

    await expect(page.locator(card).getByText("Olisi tehnyt: käynnistäisi relayn")).toBeVisible();
    await expect(page.locator(card).getByText("Lähde on livenä ja preflight on puhdas.")).toBeVisible();
    await expect(page.locator(card).getByText(/pelkkä laskelma, ei sivuvaikutuksia/)).toBeVisible();
  });

  test("päälle kytkeminen vaatii vahvistuksen", async ({ page, api, openApp }) => {
    await openApp();
    await openJob(page);

    await page.locator(card).getByRole("button", { name: "Kytke ajastin päälle" }).click();
    // Ensimmäinen painallus vain virittää napin — mitään ei ole vielä lähetetty.
    expect(api.called("POST", "/api/scheduler/enable")).toBe(false);

    await page.locator(card).getByRole("button", { name: /Varmista/ }).click();
    await expect.poll(() => api.called("POST", "/api/scheduler/enable")).toBe(true);
    expect(api.calledWith("POST", "/api/scheduler/enable")[0].body).toEqual({ enabled: true });
  });

  test("pois kytkeminen ei vaadi vahvistusta", async ({ page, api, openApp }) => {
    api.scheduler = fixture.schedulerState({ enabled: true });
    await openApp();
    await openJob(page);

    await expect(page.locator(card).getByText("PÄÄLLÄ")).toBeVisible();
    await page.locator(card).getByRole("button", { name: "Kytke ajastin pois" }).click();
    await expect.poll(() => api.called("POST", "/api/scheduler/enable")).toBe(true);
    expect(api.calledWith("POST", "/api/scheduler/enable")[0].body).toEqual({ enabled: false });
  });

  test("kertoo myös kun odotettavaa työtä ei ole", async ({ page, api, openApp }) => {
    api.scheduler = fixture.schedulerState({ nextJob: null });
    await openApp();
    await openJob(page);
    await expect(page.locator(card).getByText("Ei työtä jota odottaa.")).toBeVisible();
  });
});
