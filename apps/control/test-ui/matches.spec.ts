/** Ottelut-näkymä: day → stadium → tick the matches. A day can hold 200
 *  matches across 30 series, so the filters are load-bearing, not decoration. */

import { expect, test, shot } from "./support/harness";
import { dayMatches } from "./support/state";

/** The picker opens on "today in Finland"; the tests derive the same value so
 *  they keep working tomorrow. */
function todayInFinland(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Helsinki" }).format(new Date());
}

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function openMatches(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Ottelut", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Päivä" })).toBeVisible();
}

const showPastToggle = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /Näytä menneet/ });

const stadiumSelect = (page: import("@playwright/test").Page) =>
  page.locator("select").filter({ has: page.locator("option", { hasText: "Kaikki kentät" }) });
const seriesSelect = (page: import("@playwright/test").Page) =>
  page.locator("select").filter({ has: page.locator("option", { hasText: "Kaikki sarjat" }) });

test.describe("ottelun valinta", () => {
  test("avautuu tälle päivälle ja listaa päivän ottelut", async ({ page, openApp, api }, info) => {
    await openApp();
    await openMatches(page);

    const today = todayInFinland();
    await expect
      .poll(() => api.calledWith("GET", "/api/matches").map((c) => c.search))
      .toContain(`?date=${today}`);

    await expect(page.getByRole("button", { name: /Kuvitteellisen Kylän Veikot/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Mustikkamäen Maila/ })).toBeVisible();
    await shot(page, info, "matches-day");
  });

  test("nuolet vaihtavat päivää ja hakevat uuden päivän ottelut", async ({ page, openApp, api }) => {
    await openApp();
    await openMatches(page);

    const today = todayInFinland();
    const yesterday = shiftIsoDate(today, -1);

    await page.getByRole("button", { name: "‹", exact: true }).click();
    await expect
      .poll(() => api.calledWith("GET", "/api/matches").map((c) => c.search))
      .toContain(`?date=${yesterday}`);
    await expect(page.locator('input[type="date"]')).toHaveValue(yesterday);

    await page.getByRole("button", { name: "›", exact: true }).click();
    await expect(page.locator('input[type="date"]')).toHaveValue(today);
  });

  test("kenttäsuodatin karsii listan", async ({ page, openApp }) => {
    await openApp();
    await openMatches(page);
    // Karhunpesän Kiitäjät on jo pelattu, eli piilossa oletuksena (#128).
    // Kenttäsuodattimen testi tarvitsee sen näkyviin, jotta "katoaa
    // suodattimen takia" eroaa "ei ollut näkyvissä muutenkaan" -tilanteesta.
    await showPastToggle(page).click();

    await expect(page.getByRole("button", { name: /Mustikkamäen Maila/ })).toBeVisible();

    await stadiumSelect(page).selectOption("Testikenttä 1");
    await expect(page.getByRole("button", { name: /Kuvitteellisen Kylän Veikot/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ankkalammen Ampujat/ })).toBeVisible();
    // Kenttä 2:n ottelut katoavat.
    await expect(page.getByRole("button", { name: /Mustikkamäen Maila/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /Karhunpesän Kiitäjät/ })).toBeHidden();
  });

  test("sarjasuodatin karsii listan ja toimii yhdessä kenttäsuodattimen kanssa", async ({
    page,
    openApp,
  }) => {
    await openApp();
    await openMatches(page);
    await showPastToggle(page).click(); // ks. edellinen testi

    await seriesSelect(page).selectOption("Juniorileiri");
    await expect(page.getByRole("button", { name: /Ankkalammen Ampujat/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Karhunpesän Kiitäjät/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Kuvitteellisen Kylän Veikot/ })).toBeHidden();

    await stadiumSelect(page).selectOption("Testikenttä 2");
    await expect(page.getByRole("button", { name: /Karhunpesän Kiitäjät/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ankkalammen Ampujat/ })).toBeHidden();
  });


  test("menneet ottelut ovat piilossa oletuksena, käynnissä oleva ei koskaan", async ({
    page,
    openApp,
  }, info) => {
    // #128: leiripäivänä lista on ~200 ottelua pitkä ja ajastettava hukkuu jo
    // pelattujen sekaan.
    await openApp();
    await openMatches(page);

    // Yli tunti sitten alkanut on poissa…
    await expect(page.getByRole("button", { name: /Karhunpesän Kiitäjät/ })).toBeHidden();
    // …mutta käynnissä olevaa ei piiloteta, vaikka alkuajasta on kulunut aikaa:
    // juuri siihen voi joutua palaamaan kesken päivän.
    await expect(page.getByRole("button", { name: /Ankkalammen Ampujat/ })).toBeVisible();
    // Tulevat pysyvät luonnollisesti näkyvissä.
    await expect(page.getByRole("button", { name: /Kuvitteellisen Kylän Veikot/ })).toBeVisible();

    // Kytkin kertoo montako on piilossa — muuten piilotettua ei osaa etsiä.
    await expect(showPastToggle(page)).toBeVisible();
    await expect(page.getByText(/1 ottelua piilossa/)).toBeVisible();
    await shot(page, info, "matches-past-hidden");

    await showPastToggle(page).click();
    await expect(page.getByRole("button", { name: /Karhunpesän Kiitäjät/ })).toBeVisible();
  });

  test("rastitus ja Luo työ lähettävät oikean ottelu-ID:n", async ({ page, openApp, api }, info) => {
    await openApp();
    await openMatches(page);

    const create = page.getByRole("button", { name: /^Luo työ$/ });
    await expect(create, "ilman valintaa nappi on pois käytöstä").toBeDisabled();

    await page.getByRole("button", { name: /Mustikkamäen Maila/ }).click();
    await expect(page.getByRole("button", { name: /^Luo työ \(1\)$/ })).toBeEnabled();
    await shot(page, info, "matches-picked");

    await page.getByRole("button", { name: /^Luo työ \(1\)$/ }).click();

    await expect.poll(() => api.called("POST", "/api/jobs")).toBe(true);
    const posts = api.calledWith("POST", "/api/jobs");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ matchId: 999002 });

    // Creating a job moves the operator straight to the job form.
    await expect(page.getByRole("heading", { name: "Lähde ja kohde" })).toBeVisible();
  });

  test("monta rastia luo monta työtä", async ({ page, openApp, api }) => {
    await openApp();
    await openMatches(page);

    await page.getByRole("button", { name: /Kuvitteellisen Kylän Veikot/ }).click();
    await page.getByRole("button", { name: /Ankkalammen Ampujat/ }).click();
    await page.getByRole("button", { name: /^Luo työ \(2\)$/ }).click();

    await expect.poll(() => api.calledWith("POST", "/api/jobs").length).toBe(2);
    const ids = api.calledWith("POST", "/api/jobs").map((c) => (c.body as { matchId: number }).matchId);
    expect(ids.sort()).toEqual([999001, 999003]);
  });

  test("ottelu-ID tunnistetaan sekä numerona että pesistulokset-osoitteesta", async ({
    page,
    openApp,
    api,
  }) => {
    await openApp();
    await openMatches(page);

    const field = page.getByPlaceholder(/146210/);
    const createFromId = page.getByRole("button", { name: /Luo työ ID:stä/ });

    await expect(page.getByText("Liitä osoite tai kirjoita ID.")).toBeVisible();
    await expect(createFromId).toBeDisabled();

    await field.fill("146210");
    await expect(page.getByText("Tunnistettu ottelu-ID 146210")).toBeVisible();
    await expect(createFromId).toBeEnabled();

    await field.fill("https://www.pesistulokset.fi/ottelu/999123");
    await expect(page.getByText("Tunnistettu ottelu-ID 999123")).toBeVisible();

    await field.fill("ei numeroita täällä");
    await expect(page.getByText("Osoitteesta ei löydy ottelu-ID:tä.")).toBeVisible();
    await expect(createFromId).toBeDisabled();

    await field.fill("https://www.pesistulokset.fi/ottelu/999123");
    await createFromId.click();
    await expect.poll(() => api.called("POST", "/api/jobs")).toBe(true);
    expect(api.calledWith("POST", "/api/jobs")[0].body).toEqual({ matchId: 999123 });
  });

  /** Käsin liitetty väärä numero on tavallisin virhelähde tässä näkymässä.
   *  Palvelin vastaa 404 + suomenkielinen lause (jobs.ts MatchNotFoundError),
   *  ja sen pitää päätyä ruudulle sellaisenaan — ei "Palvelinvirhe (HTTP
   *  500)" eikä raakaa "Match metadata fetch failed: 404". */
  test("tuntematon ottelu-ID näytetään luettavana virheenä", async ({ page, openApp, api }) => {
    api.failures.set("POST /api/jobs", {
      status: 404,
      error: "Ottelua 999999999 ei löytynyt tulospalvelusta — tarkista ottelu-ID.",
    });
    await openApp();
    await openMatches(page);

    await page.getByPlaceholder(/146210/).fill("999999999");
    await page.getByRole("button", { name: /Luo työ ID:stä/ }).click();

    await expect(
      page.getByText("Ottelua 999999999 ei löytynyt tulospalvelusta — tarkista ottelu-ID."),
    ).toBeVisible();
  });

  test("tyhjä päivä kerrotaan käyttäjälle", async ({ page, openApp, api }) => {
    api.day = (date) => ({ ...dayMatches(date), matches: [], stadiums: [], seriesNames: [] });
    await openApp();
    await openMatches(page);

    await expect(page.getByText("Ei otteluita näillä suodattimilla.")).toBeVisible();
  });
});
