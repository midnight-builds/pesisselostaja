/** Välilehtinavigaatio ja lokinäkymä. */

import { expect, test, shot } from "./support/harness";
import { liveState, logLines } from "./support/state";

test.describe("välilehdet", () => {
  test("vaihtavat näkymän ja säilyttävät sovelluksen tilan", async ({ page, openApp, sse, api }) => {
    await openApp();
    const connectionsAtStart = await sse.connections();

    await page.getByRole("button", { name: "Ottelut", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Päivä" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Selostukset" })).toBeHidden();

    await page.getByRole("button", { name: "Loki", exact: true }).click();
    await expect(page.getByRole("button", { name: "Varoitus", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Live", exact: true }).click();
    // Back on live: the state that arrived over SSE is still there, rendered
    // from the app-level store rather than refetched.
    await expect(page.getByText("Lähetys kunnossa, 42 min")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Selostukset" })).toBeVisible();

    // The stream is owned by the shell, so tab switching must not reconnect it
    // — an iPhone on mobile data would otherwise re-poll on every tap.
    expect(await sse.connections(), "välilehden vaihto ei saa avata uutta SSE-yhteyttä").toBe(
      connectionsAtStart,
    );
    expect(api.called("GET", "/api/live"), "eikä hakea kertakuvaa uudelleen").toBe(false);
  });

  /** Views stay mounted (App.tsx), so each view's own state — the Ottelut
   *  filters and ticks, the log level, the selected job — outlives a trip to
   *  another tab, and the day is not refetched on the way back. On a camp day
   *  of 200 matches, losing the field filter every time the operator glances
   *  at Live is the difference between usable and not. */
  test("näkymäkohtainen tila säilyy välilehden vaihdossa", async ({ page, openApp, api }) => {
    await openApp();
    await page.getByRole("button", { name: "Ottelut", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Päivä" })).toBeVisible();

    const stadium = page
      .locator("select")
      .filter({ has: page.locator("option", { hasText: "Kaikki kentät" }) });
    await stadium.selectOption("Testikenttä 1");
    await page.getByRole("button", { name: /Kuvitteellisen Kylän Veikot/ }).click();
    await expect(page.getByRole("button", { name: /^Luo työ \(1\)$/ })).toBeEnabled();
    const fetchesBefore = api.calledWith("GET", "/api/matches").length;

    await page.getByRole("button", { name: "Live", exact: true }).click();
    await expect(page.getByText("Lähetys kunnossa, 42 min")).toBeVisible();
    await page.getByRole("button", { name: "Ottelut", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Päivä" })).toBeVisible();

    await expect(stadium, "kenttäsuodatin säilyy").toHaveValue("Testikenttä 1");
    await expect(
      page.getByRole("button", { name: /Kuvitteellisen Kylän Veikot/ }),
      "rastitus säilyy",
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /^Luo työ \(1\)$/ })).toBeEnabled();

    // Nor is the day refetched: 200 matches over mobile data, for nothing.
    await page.waitForTimeout(400);
    expect(
      api.calledWith("GET", "/api/matches").length,
      "päivää ei haeta uudelleen välilehden vaihdosta",
    ).toBe(fetchesBefore);
  });

  test("lokin tasosuodatin säilyy välilehden vaihdossa", async ({ page, openApp }) => {
    await openApp();
    await page.getByRole("button", { name: "Loki", exact: true }).click();
    await page.getByRole("button", { name: "Virhe", exact: true }).click();
    await expect(page.getByText(/Tulospalvelun haku epäonnistui/)).toBeVisible();

    await page.getByRole("button", { name: "Live", exact: true }).click();
    await page.getByRole("button", { name: "Loki", exact: true }).click();

    await expect(page.getByText(/Tulospalvelun haku epäonnistui/)).toBeVisible();
    await expect(page.getByText(/Sydänääni: relay käynnissä/)).toBeHidden();
  });

  test("aktiivinen välilehti on merkitty ja SSE-tila päivittyy myös muilla välilehdillä", async ({
    page,
    openApp,
    sse,
  }) => {
    await openApp();
    await expect(page.getByRole("button", { name: "Live", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );

    await page.getByRole("button", { name: "Loki", exact: true }).click();
    await expect(page.getByRole("button", { name: "Loki", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // A frame arriving while another tab is open still lands: switching back
    // shows the NEW headline, not the one from before.
    await sse.push(liveState({ health: "warn", headline: "ffmpeg respawnasi 3× viime minuutteina — kuva pätkii" }));
    await page.getByRole("button", { name: "Live", exact: true }).click();
    await expect(page.getByText("ffmpeg respawnasi 3× viime minuutteina — kuva pätkii")).toBeVisible();
  });
});

test.describe("loki", () => {
  test("tasosuodatin karsii rivit ja pyytää palvelimelta oikean tason", async ({
    page,
    openApp,
    api,
  }, info) => {
    api.log = logLines();
    await openApp();
    await page.getByRole("button", { name: "Loki", exact: true }).click();

    // Oletus on Info: debug-rivi ei näy.
    await expect(page.getByText(/Sydänääni: relay käynnissä/)).toBeVisible();
    await expect(page.getByText(/Poll 412/)).toBeHidden();
    await shot(page, info, "log-info");

    await page.getByRole("button", { name: "Kaikki", exact: true }).click();
    await expect(page.getByText(/Poll 412/)).toBeVisible();
    await expect
      .poll(() => api.calledWith("GET", "/api/log").map((c) => c.search))
      .toContain("?limit=300");

    await page.getByRole("button", { name: "Virhe", exact: true }).click();
    await expect(page.getByText(/Tulospalvelun haku epäonnistui/)).toBeVisible();
    await expect(page.getByText(/ffmpeg päättyi koodilla 1/)).toBeHidden();
    await expect(page.getByText(/Sydänääni: relay käynnissä/)).toBeHidden();
    await expect
      .poll(() => api.calledWith("GET", "/api/log").map((c) => c.search))
      .toContain("?limit=300&level=error");

    await page.getByRole("button", { name: "Varoitus", exact: true }).click();
    await expect(page.getByText(/ffmpeg päättyi koodilla 1/)).toBeVisible();
    await expect(page.getByText(/Tulospalvelun haku epäonnistui/)).toBeVisible();
    await expect(page.getByText(/Sydänääni: relay käynnissä/)).toBeHidden();
  });

  test("tyhjä loki kerrotaan käyttäjälle", async ({ page, openApp, api }) => {
    api.log = [];
    await openApp(liveState({ log: [] }));
    await page.getByRole("button", { name: "Loki", exact: true }).click();

    await expect(page.getByText("Ei rivejä.")).toBeVisible();
  });
});
