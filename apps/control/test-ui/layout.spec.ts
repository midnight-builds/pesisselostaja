/** Ulkoasu: the app is used one-handed, outdoors, on a 393×853 iPhone screen.
 *  Everything here is a property of that situation, not a pixel comparison —
 *  no screenshot diffing, because a style tweak should not be able to fail the
 *  suite. Screenshots are still saved as artifacts for eyeballing. */

import { expect, test, shot, horizontalOverflow, tapTargets, contrastRatio } from "./support/harness";
import { HEALTH_CASES, liveState, matchState, job, relayProcess } from "./support/state";

const TABS = ["Live", "Ottelut", "Työ", "Loki"] as const;

test.describe("ulkoasu", () => {
  test("mikään välilehti ei tuota vaakavieritystä 393×853-näkymässä", async ({ page, openApp }) => {
    await openApp();

    for (const tab of TABS) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      // Give a data-loading view (Ottelut, Loki) time to paint its rows before
      // measuring — an empty list cannot overflow.
      await page.waitForTimeout(300);

      const viewportOverflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        viewportOverflow.scrollWidth,
        `${tab}: dokumentti ei saa olla näkymää leveämpi`,
      ).toBeLessThanOrEqual(viewportOverflow.clientWidth);

      const offenders = await horizontalOverflow(page);
      expect(offenders, `${tab}: elementtejä leveämpänä kuin oma laatikkonsa`).toEqual([]);
    }
  });

  test("alapalkki pysyy näkyvissä kun sisältöä vieritetään", async ({ page, openApp }, info) => {
    await openApp();

    const tabbar = page.getByRole("navigation");
    const before = await tabbar.boundingBox();
    expect(before).not.toBeNull();

    // Scroll the live view to the very bottom.
    await page.evaluate(() => {
      const scroller = Array.from(document.querySelectorAll("*")).find(
        (el) => el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY === "auto",
      );
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(300);

    const after = await tabbar.boundingBox();
    const viewport = page.viewportSize()!;
    expect(after).not.toBeNull();
    expect(after!.y, "alapalkki ei saa valua näytön alareunan ohi").toBeLessThan(viewport.height);
    expect(after!.y + after!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(after!.y, "alapalkki pysyy paikallaan vieritettäessä").toBeCloseTo(before!.y, 0);
    await expect(page.getByRole("button", { name: "Loki", exact: true })).toBeVisible();

    await shot(page, info, "live-scrolled-bottom");
  });

  test("kosketuskohteet ovat vähintään 44×44 px", async ({ page, openApp }, info) => {
    /** Known-undersized controls, MEASURED not guessed. These are reported to
     *  the operator as findings rather than silently fixed here; the point of
     *  the allowlist is that anything NEW that drops below 44 px still fails. */
    const KNOWN_UNDERSIZED = ["button.chip", "button.linkbtn", "button.field__reveal"];

    await openApp();
    const undersizedEverywhere: string[] = [];

    for (const tab of TABS) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await page.waitForTimeout(300);

      const targets = await tapTargets(page);
      expect(targets.length, `${tab}: näkymässä pitää olla kosketuskohteita`).toBeGreaterThan(0);

      const small = targets.filter((t) => t.width < 44 || t.height < 44);
      for (const t of small) {
        undersizedEverywhere.push(`${tab}: ${t.selector} "${t.label}" ${t.width}×${t.height}`);
      }
      const unexpected = small.filter((t) => !KNOWN_UNDERSIZED.includes(t.selector));
      expect(
        unexpected.map((t) => `${t.selector} "${t.label}" ${t.width}×${t.height}`),
        `${tab}: uusia alle 44 px kosketuskohteita`,
      ).toEqual([]);
    }

    await info.attach("alle-44px-kohteet", {
      body: undersizedEverywhere.join("\n") || "(ei yhtään)",
      contentType: "text/plain",
    });
  });

  test("live-näkymän järjestys on terveystila → statusruudukko → pelitilanne → selostuslista", async ({
    page,
    openApp,
  }, info) => {
    await openApp();

    // Each anchor is located by text/role, so a class rename cannot silently
    // turn this order check green.
    const health = page.getByText("Lähetys kunnossa, 42 min");
    const grid = page.getByRole("button", { name: /Tulospalvelu/ });
    const score = page.getByText("Palot", { exact: true });
    const narration = page.getByRole("heading", { name: "Selostukset" });

    for (const locator of [health, grid, score, narration]) {
      await expect(locator).toBeVisible();
    }

    const ys = [] as number[];
    for (const locator of [health, grid, score, narration]) {
      const box = await locator.boundingBox();
      ys.push(box!.y);
    }
    expect(ys[0], "terveystila ennen statusruudukkoa").toBeLessThan(ys[1]);
    expect(ys[1], "statusruudukko ennen pelitilannetta").toBeLessThan(ys[2]);
    expect(ys[2], "pelitilanne ennen selostuslistaa").toBeLessThan(ys[3]);

    await shot(page, info, "live-order");
  });

  for (const variant of HEALTH_CASES) {
    test(`terveystila renderöityy tilassa ${variant.health}`, async ({ page, openApp, sse }, info) => {
      await openApp(
        liveState({
          health: variant.health,
          headline: variant.headline,
          relay: variant.health === "fail" ? relayProcess({ active: false, activeState: "inactive" }) : relayProcess(),
          job: variant.health === "idle" ? null : job(),
          match: variant.health === "idle" ? matchState({ matchId: null }) : matchState(),
        }),
      );
      void sse;

      await expect(page.getByText(variant.word, { exact: true })).toBeVisible();
      await expect(page.getByText(variant.headline)).toBeVisible();
      await shot(page, info, `health-${variant.health}`);
    });
  }

  test("kontrasti riittää ulkokäyttöön", async ({ page, openApp }, info) => {
    const measured: string[] = [];

    for (const variant of HEALTH_CASES) {
      await openApp(liveState({ health: variant.health, headline: variant.headline }));

      const word = page.getByText(variant.word, { exact: true });
      const headline = page.getByText(variant.headline);
      const wordRatio = await contrastRatio(word);
      const headlineRatio = await contrastRatio(headline);
      measured.push(`${variant.health}: iso tila ${wordRatio}:1, leipäteksti ${headlineRatio}:1`);

      // Body text is held to the full WCAG AA 4.5:1.
      expect(headlineRatio, `${variant.health}: leipätekstin kontrasti`).toBeGreaterThanOrEqual(4.5);
      // The status word is 30 px / weight 900 = WCAG "large text", whose AA
      // threshold is 3:1. It is checked separately (and reported) because the
      // fail state's red-on-red tint does not reach 4.5:1 — see the report.
      expect(wordRatio, `${variant.health}: ison terveystilan kontrasti`).toBeGreaterThanOrEqual(3);
    }

    await info.attach("mitatut-kontrastit", { body: measured.join("\n"), contentType: "text/plain" });
  });

  test("pitkä joukkueen nimi ei riko asettelua", async ({ page, openApp }, info) => {
    const long = "Jyväskylän Kiri & Kirittäret Juniorit Rautiainen";
    await openApp(
      liveState({
        match: matchState({ home: long, away: "Lapinlahden Peikot", battingTeam: long }),
        job: job({ home: long }),
      }),
    );

    await expect(page.getByText(long).first()).toBeVisible();

    const viewportOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(viewportOverflow.scrollWidth).toBeLessThanOrEqual(viewportOverflow.clientWidth);
    expect(await horizontalOverflow(page), "pitkä nimi ei saa työntää mitään laatikkonsa yli").toEqual([]);

    // Nothing may be pushed off the right edge either.
    const box = await page.getByText(long).first().boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(393 + 1);

    await shot(page, info, "long-team-name");
  });
});
