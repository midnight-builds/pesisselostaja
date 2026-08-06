/** Päättynyt-tila ja siivous näkyviin (#187).
 *
 *  Ottelupäivän viimeinen näkymä vastaa yhteen kysymykseen: **jäikö jotain
 *  päälle?** Hard stop tehdään ilman operaattorin vahvistusta (#171), joten
 *  ainoa asia joka pitää sen rehellisenä on se, että teot näkyvät jälkikäteen —
 *  teko jota ei näytetä on teko jota ei voi tarkistaa.
 *
 *  Kuusi väitettä, joista jokainen vastaa yhtä päätöstä:
 *
 *  - Normaali lopetus sanoo ääneen ettei ohjaamo koskenut lähetyksiin. Tyhjä
 *    tekolista näyttäisi muuten siltä, että siivous unohtui.
 *  - Hard stopin teot luetellaan sellaisina kuin ne tapahtuivat.
 *  - Auki jäänyt lähetys on kortin ainoa käskymuotoinen rivi.
 *  - Ilman siivousmerkintää kortti sanoo ettei ohjaamo ollut katsomassa
 *    (sovittelu sulki työn jälkikäteen) — rehellinen tyhjä, ei vihreä valhe.
 *  - Lopetuksen perusteet ovat useampi riippumaton indikaattori (#171), eivät
 *    yksi.
 *  - Tekninen totuus ei vuoda ottelupäivän polulle (#176), ja seuraavan ottelun
 *    valinta on samalla ruudulla — jälkihoitoa ei ole (#170). */

import { expect, horizontalOverflow, stateWord, test } from "./support/harness";
import * as fixture from "./support/state";
import { jobStateWord } from "../src/shared/jobState";

const picker = ".picker";

function openFinished(
  openApp: (state: ReturnType<typeof fixture.liveState>) => Promise<void>,
  job = fixture.finishedJob()
) {
  return openApp(
    fixture.liveState({
      job,
      health: "idle",
      headline: "Ei aktiivista lähetystä",
      relay: fixture.relayProcess({ activeState: "inactive", active: false, uptimeSec: null }),
      match: fixture.matchState({ finished: true }),
      telemetry: null,
      narration: [],
    })
  );
}

test.describe("päättynyt", () => {
  test("normaali lopetus sanoo ääneen, ettei lähetyksiin tarvinnut koskea", async ({ page, openApp }) => {
    await openFinished(openApp);

    await expect(stateWord(page)).toHaveText(jobStateWord("finished").word);
    await expect(page.getByTestId("ended-actions")).toContainText("ei tarvinnut koskea lähetyksiin");
    // Ei käskyjä: hyvänä päivänä operaattorille ei jää tehtävää.
    await expect(page.locator(".check--fail")).toHaveCount(0);
  });

  test("hard stopin teot luetellaan sellaisina kuin ne tapahtuivat", async ({ page, openApp }) => {
    await openFinished(
      openApp,
      fixture.finishedJob({
        cleanup: fixture.jobCleanup({
          indicators: ["Selostus ajoi takarajaan asti, koska raakalähetys ei päättynyt."],
          actions: [
            { what: "Selostettu lähetys suljettiin.", ok: true, detail: null },
            { what: "Raakalähetys jätettiin koskematta.", ok: true, detail: null },
          ],
        }),
      })
    );

    const actions = page.getByTestId("ended-actions");
    await expect(actions).toContainText("Selostettu lähetys suljettiin.");
    // Raakalähetystä ei kosketa ottelun ollessa kesken, ja sekin on teko joka
    // näytetään: muuten operaattori ei tiedä onko se yhä päällä (CLAUDE.md).
    await expect(actions).toContainText("Raakalähetys jätettiin koskematta.");
  });

  test("auki jäänyt lähetys on ainoa käskymuotoinen rivi", async ({ page, openApp }) => {
    await openFinished(
      openApp,
      fixture.finishedJob({
        cleanup: fixture.jobCleanup({
          actions: [
            {
              what: "Selostettu lähetys ei sulkeutunut.",
              ok: false,
              detail: "Sulje selostettu lähetys YouTubessa itse.",
            },
          ],
        }),
      })
    );

    await expect(page.locator(".check--fail")).toHaveCount(1);
    await expect(page.getByText("Sulje selostettu lähetys YouTubessa itse.")).toBeVisible();
    // Ja kortin oma johtolause myöntää sen sen sijaan että väittäisi kaiken
    // olevan kiinni.
    await expect(page.getByTestId("ended-card")).toContainText("jotain jäi kesken");
  });

  test("ilman siivousmerkintää kortti myöntää ettei ohjaamo ollut katsomassa", async ({ page, openApp }) => {
    // Sovittelu sulki työn jälkikäteen (#118): ajo päättyi ohjaamon ollessa
    // alhaalla, eikä lähetysten tilasta ole näyttöä. Vihreä "kaikki kiinni"
    // olisi tässä valhe.
    await openFinished(openApp, fixture.finishedJob({ cleanup: null }));

    await expect(page.getByTestId("ended-unwitnessed")).toBeVisible();
    await expect(page.getByTestId("ended-actions")).toHaveCount(0);
  });

  test("lopetuksen perusteet ovat useampi riippumaton havainto", async ({ page, openApp }) => {
    await openFinished(openApp);

    const why = page.getByTestId("ended-indicators");
    await expect(why).toContainText("Raakalähetys päättyi.");
    await expect(why).toContainText("Tulospalvelu kirjasi ottelun päättyneeksi.");
  });

  test("tallenne, kesto ja seuraavan ottelun valinta samalla ruudulla ilman teknistä vuotoa", async ({
    page,
    openApp,
  }) => {
    await openFinished(openApp);

    const card = page.getByTestId("ended-card");
    await expect(card).toContainText("1 h 42 min");
    // Molemmat lähetykset (#228): kysymys "jäikö raakalähetys päälle" ei
    // katoa siihen että ajo päättyi, ja aiemmin siihen pääsi käsiksi vain
    // etsimällä oma lähetys YouTubesta.
    const narrated = page.getByRole("link", { name: "Avaa selostettu lähetys" });
    await expect(narrated).toHaveAttribute("href", "https://www.youtube.com/watch?v=SELOSTETTU");
    const raw = page.getByRole("link", { name: "Avaa raakalähetys" });
    await expect(raw).toHaveAttribute("href", "https://www.youtube.com/watch?v=NORMAALI");
    for (const link of [narrated, raw]) {
      await expect(link).toHaveAttribute("target", "_blank");
    }
    // Jälkihoitoa ei ole: päivä jatkuu seuraavasta ottelusta samalla ruudulla.
    await expect(page.locator(picker)).toBeVisible();

    // Tekninen totuus kuuluu huoltoarkkiin, ei ottelupäivän polulle (#176).
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("aaaa-bbbb-cccc-dddd");
    expect(body).not.toContain("rtmp://");
    expect(body).not.toContain(".env");

    expect(await horizontalOverflow(page)).toEqual([]);
  });
});
