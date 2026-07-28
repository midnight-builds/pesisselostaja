/** Työ-näkymä: the form that decides which stream is read and which one is
 *  pushed to, and the preflight gate in front of the start button. The gate is
 *  a safety feature: if blockers can be clicked past, the relay starts into a
 *  known-broken configuration. */

import { expect, test, shot, view } from "./support/harness";
import { job, liveState, preflightResult, preflightWithBlockers, relayProcess } from "./support/state";

async function openJob(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Työ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lähde ja kohde" })).toBeVisible();
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
      .filter((c) => c.path.startsWith("/api/jobs/job-0001"))
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
