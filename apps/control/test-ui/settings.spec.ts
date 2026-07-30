/** Asetukset-välilehti (#133): ohjaamon pysyväisasetukset yhdessä paikassa.
 *
 *  Ennen tätä säädettävä oli hajallaan `run/`-tiedostoissa, joita pääsi
 *  muokkaamaan vain tiedostoselaimella — eli ei puhelimella kentän laidalla. */

import { expect, test, shot } from "./support/harness";

async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Asetukset", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Kenttänimen siivous" })).toBeVisible();
}

test.describe("asetukset", () => {
  test("näyttää tallennetut arvot", async ({ page, openApp }, info) => {
    await openApp();
    await openSettings(page);

    await expect(page.getByTestId("share-lines")).toHaveValue(/YouTube selostettu/);
    await expect(page.getByRole("button", { name: /Pudota kenttänumero/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await shot(page, info, "settings");
  });

  test("kytkin tallentaa vain oman osansa eikä nollaa viestipohjaa", async ({ page, openApp, api }) => {
    await openApp();
    await openSettings(page);

    await page.getByRole("button", { name: /Pudota tuotantomerkintä/ }).click();

    await expect.poll(() => api.calledWith("PATCH", "/api/settings").length).toBe(1);
    const patch = api.calledWith("PATCH", "/api/settings")[0].body as Record<string, unknown>;
    // Vain muuttunut osa lähtee: jos koko asetusolio lähetettäisiin, kesken
    // muokattu viestipohja tallentuisi vahingossa samalla.
    expect(patch).toEqual({ venueCleanup: { stripFieldNumber: true, stripQualifier: false } });
    expect(patch.shareTemplate).toBeUndefined();

    await expect(page.getByRole("button", { name: /Pudota tuotantomerkintä/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Toinen kytkin ei liikkunut.
    await expect(page.getByRole("button", { name: /Pudota kenttänumero/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("viestipohjan rivit tallentuvat riveinä, tyhjät pois", async ({ page, openApp, api }) => {
    await openApp();
    await openSettings(page);

    // Tekstialueeseen jää helposti rivinvaihto loppuun; se ei saa tuottaa
    // tyhjää riviä jokaiseen jaettuun viestiin.
    await page.getByTestId("share-lines").fill("YouTube: {watchUrl}\n\nTulokset: {matchUrl}\n");
    await page.getByRole("button", { name: "Tallenna viestipohja" }).click();

    await expect.poll(() => api.calledWith("PATCH", "/api/settings").length).toBe(1);
    const patch = api.calledWith("PATCH", "/api/settings")[0].body as {
      shareTemplate: { lines: string[] };
    };
    expect(patch.shareTemplate.lines).toEqual(["YouTube: {watchUrl}", "Tulokset: {matchUrl}"]);
  });

  test("kertoo mitä EI säädetä täältä", async ({ page, openApp }) => {
    // Rajaus on issuen oma ja helppo unohtaa: relayn ottelunaikaiset säätimet
    // ovat ohjausta eivätkä asetuksia, ja ne pysyvät Live-näkymässä.
    await openApp();
    await openSettings(page);
    await expect(page.getByText(/Relayn ottelunaikaiset säätimet ovat Live-välilehdellä/)).toBeVisible();
  });
});
