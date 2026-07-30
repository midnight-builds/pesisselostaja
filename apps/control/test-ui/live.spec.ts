/** Live-näkymän toiminta: the controls that touch a running broadcast.
 *  The destructive-action tests are the important ones here — a stop request
 *  that leaves on a single tap would cut a live stream from a pocket touch. */

import { expect, test, shot } from "./support/harness";
import { liveState, relayProcess, knobs } from "./support/state";

test.describe("live-näkymän ohjaimet", () => {
  test("viivenapit kutsuvat delay-nudgea oikealla etumerkillä", async ({ page, openApp, api }) => {
    await openApp(liveState({ knobs: knobs({ narrationDelayMs: 4000 }) }));

    await expect(page.getByText("4000 ms")).toBeVisible();

    await page.getByRole("button", { name: /Puhui liian aikaisin/ }).click();
    await expect.poll(() => api.calledWith("POST", "/api/knobs/delay-nudge").length).toBe(1);
    expect(api.calledWith("POST", "/api/knobs/delay-nudge")[0].body).toEqual({ deltaMs: 500 });
    // The server's answer is shown immediately, without waiting for a push.
    await expect(page.getByText("4500 ms")).toBeVisible();

    await page.getByRole("button", { name: /Puhui liian myöhään/ }).click();
    await expect.poll(() => api.calledWith("POST", "/api/knobs/delay-nudge").length).toBe(2);
    expect(api.calledWith("POST", "/api/knobs/delay-nudge")[1].body).toEqual({ deltaMs: -500 });
    await expect(page.getByText("4000 ms")).toBeVisible();
  });

  test("kytkimet ja pollausväli kirjoittavat /api/knobs", async ({ page, openApp, api }) => {
    await openApp(liveState({ knobs: knobs({ announceBatterChanges: true, pollIntervalMs: 3000 }) }));

    await page.getByRole("button", { name: /Vaihtoselostus/ }).click();
    await expect.poll(() => api.called("POST", "/api/knobs")).toBe(true);
    expect(api.calledWith("POST", "/api/knobs")[0].body).toEqual({ announceBatterChanges: false });

    await page.getByRole("button", { name: "5 s", exact: true }).click();
    await expect.poll(() => api.calledWith("POST", "/api/knobs").length).toBe(2);
    expect(api.calledWith("POST", "/api/knobs")[1].body).toEqual({ pollIntervalMs: 5000 });
  });

  test("relayn pysäytys vaatii kaksi napautusta", async ({ page, openApp, api }, info) => {
    await openApp(liveState({ relay: relayProcess({ active: true }) }));

    const stop = page.getByRole("button", { name: "Pysäytä", exact: true });
    await expect(stop).toBeVisible();

    // First tap: arms only. This is the assertion that matters — a single tap
    // must never reach the server.
    await stop.click();
    await expect(page.getByRole("button", { name: /Vahvista: pysäytä relay/ })).toBeVisible();
    await page.waitForTimeout(400);
    expect(api.called("POST", "/api/relay/stop"), "yksi napautus ei saa lähettää pysäytystä").toBe(false);

    await shot(page, info, "stop-armed");

    // Second tap: executes.
    await page.getByRole("button", { name: /Vahvista: pysäytä relay/ }).click();
    await expect.poll(() => api.called("POST", "/api/relay/stop")).toBe(true);
    expect(api.calledWith("POST", "/api/relay/stop")).toHaveLength(1);
    // And it goes back to the safe label afterwards.
    await expect(page.getByRole("button", { name: "Pysäytä", exact: true })).toBeVisible();
  });

  test("viritys purkautuu itsestään eikä unohtunut napautus pysäytä mitään", async ({
    page,
    openApp,
    api,
  }) => {
    await openApp(liveState({ relay: relayProcess({ active: true }) }));

    await page.getByRole("button", { name: "Pysäytä", exact: true }).click();
    await expect(page.getByRole("button", { name: /Vahvista: pysäytä relay/ })).toBeVisible();

    // ConfirmButton disarms after 5 s; wait it out for real rather than faking
    // timers, since the timeout is the safety property under test.
    await expect(page.getByRole("button", { name: "Pysäytä", exact: true })).toBeVisible({
      timeout: 9000,
    });
    expect(api.called("POST", "/api/relay/stop")).toBe(false);
  });

  test("uudelleenkäynnistys vaatii myös vahvistuksen", async ({ page, openApp, api }) => {
    await openApp(liveState({ relay: relayProcess({ active: true }) }));

    await page.getByRole("button", { name: "Uudelleenkäynnistä", exact: true }).click();
    await expect(page.getByRole("button", { name: /Vahvista: katkaisee lähetyksen/ })).toBeVisible();
    expect(api.called("POST", "/api/relay/restart")).toBe(false);

    await page.getByRole("button", { name: /Vahvista: katkaisee lähetyksen/ }).click();
    await expect.poll(() => api.called("POST", "/api/relay/restart")).toBe(true);
  });

  test("statusruudukon lamppu avaa selityksen napautuksella", async ({ page, openApp }) => {
    await openApp();

    const detail = page.getByText("ffmpeg kiinni lähteessä");
    await expect(detail).toBeHidden();

    await page.getByRole("button", { name: /Lähde/ }).click();
    await expect(detail).toBeVisible();

    await page.getByRole("button", { name: /Lähde/ }).click();
    await expect(detail).toBeHidden();
  });

  test("pelitilanne näyttää pisteet, jakson ja palot", async ({ page, openApp }) => {
    await openApp();

    await expect(page.getByText("2. jakso")).toBeVisible();
    await expect(page.getByText("KUV", { exact: true })).toBeVisible();
    await expect(page.getByText("LAP sisävuorossa")).toBeVisible();
    await expect(page.getByText("5", { exact: true }).first()).toBeVisible();
  });

  test("selostuslista näyttää puhutut ja jonossa olevat rivit", async ({ page, openApp }) => {
    await openApp();

    await expect(page.getByText("Kotiutus! Veikot johtaa 5–3.")).toBeVisible();
    await expect(page.getByText("Toinen palo Peikoille.")).toBeVisible();
    // Only the unspoken line carries the queue tag.
    await expect(page.getByText("jonossa", { exact: true })).toHaveCount(1);
  });

  // Match 145889: the relay narrated for five minutes while ffmpeg was not
  // attached, and every one of those lines looked exactly like a spoken one.
  test("vaimennettu rivi erottuu puhutusta — se ei kuulunut kenellekään", async ({
    page,
    openApp,
  }, info) => {
    await openApp();

    const muted = page.locator(".narration__row--muted");
    await expect(muted).toHaveCount(1);
    await expect(muted).toContainText("Kolmas palo Peikoille.");
    await expect(muted.getByText("ei kuulunut")).toBeVisible();
    await shot(page, info, "narration-muted");
  });

  test("uusin selostus on ylimpänä relayn omassa järjestyksessä", async ({ page, openApp }) => {
    await openApp();

    // Sama sekunti eri riveillä ei saa sekoittaa järjestystä (#98): lista
    // näytetään siinä järjestyksessä jossa relay ne päätti, ei aikaleiman
    // mukaan lajiteltuna.
    const texts = await page.locator(".narration__row .narration__text").allInnerTexts();
    expect(texts).toEqual([
      "Kolmas palo Peikoille.",
      "Kotiutus! Veikot johtaa 5–3.",
      "Toinen palo Peikoille.",
    ]);
  });

  test("ilman relayn telemetriaa lista kertoo syyn eikä väitä hiljaisuutta", async ({
    page,
    openApp,
  }) => {
    await openApp(liveState({ telemetry: null, narration: [] }));

    await expect(page.getByText(/Relay ei julkaise telemetriaa/)).toBeVisible();
    await expect(page.getByText("Ei selostuksia vielä.")).toBeHidden();
  });
});

test.describe("SSE-yhteyden katkeaminen", () => {
  test("katkennut virta näkyy käyttäjälle ja yhteyttä yritetään uudelleen", async ({
    page,
    openApp,
    sse,
    api,
  }, info) => {
    await openApp();
    await expect(page.getByText("yhteys ok")).toBeVisible();

    const before = await sse.connections();
    await sse.breakConnection();

    // 1. The operator is told, in both places that carry connection state.
    await expect(page.getByText("yhteys poikki").first()).toBeVisible();
    await shot(page, info, "sse-down");

    // 2. While down, the app still polls the one-shot snapshot so the numbers
    //    on screen keep moving.
    await expect.poll(() => api.calledWith("GET", "/api/live").length, { timeout: 10_000 }).toBeGreaterThan(0);

    // 3. And it reconnects by itself (backoff starts at 1 s).
    await sse.waitForConnections(before + 1, 12_000);

    // 4. A frame on the new connection clears the warning.
    await sse.push(api.live);
    await expect(page.getByText("yhteys ok")).toBeVisible();
  });
});
