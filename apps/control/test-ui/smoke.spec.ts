/** The page actually renders — against the REAL control server, with no API
 *  mocking at all.
 *
 *  This is the regression test for the one bug that has already happened here:
 *  the client bundle was not served, index.html loaded, and the app was an
 *  empty shell. Typecheck was green the whole time. Everything asserted below
 *  is something that bug broke. */

import { expect, test } from "@playwright/test";

test.describe("perusrenderöinti oikealla palvelimella", () => {
  test("sovellus latautuu, #root täyttyy eikä konsolissa ole virheitä", async ({ page }) => {
    const consoleErrors: string[] = [];
    const badResponses: string[] = [];
    const failedRequests: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("requestfailed", (req) =>
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "?"}`),
    );
    page.on("response", (res) => {
      if (res.status() >= 400) badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    });

    // Google Fonts is not part of this app's correctness; stub it so a network
    // hiccup cannot turn into a red test.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "/* fonts stubbed */" }),
    );

    const response = await page.goto("/");
    expect(response?.status(), "GET / vastaa 200").toBe(200);

    // 1. The shell mounted: #root has real children, not just an empty div.
    const rootChildren = await page.locator("#root > *").count();
    expect(rootChildren, "#root ei saa jäädä tyhjäksi kuoreksi").toBeGreaterThan(0);

    // 2. React actually rendered the chrome (this is what "blank shell" lost).
    await expect(page.getByText("Ohjaamo").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Live" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ottelut" })).toBeVisible();

    // 3. The live view rendered a real health state from the real /api/live —
    //    an idle box says "Valmiudessa", a busy one says something else, but
    //    one of the four words must be on screen.
    await expect(
      page.getByText(/Kunnossa|Huomio|Vika|Valmiudessa|Yhdistetään/).first(),
    ).toBeVisible();

    // 4. A module script served with the wrong MIME type (the exact shape of
    //    the original bug: SPA fallback hands out index.html for a missing
    //    bundle) shows up here and nowhere else.
    expect(consoleErrors, "konsolissa ei saa olla virheitä").toEqual([]);
    expect(failedRequests, "yksikään pyyntö ei saa epäonnistua").toEqual([]);
    expect(badResponses, "yksikään pyyntö ei saa palauttaa 4xx/5xx").toEqual([]);
  });

  test("oikea palvelin tarjoaa käännetyn niteen JS:nä", async ({ page }) => {
    // Reading index.html and fetching the script it references catches a
    // build/serve mismatch even if the browser were to tolerate it.
    const html = await (await page.request.get("/")).text();
    const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    expect(src, "index.html viittaa moduuliin").toBeTruthy();

    const bundle = await page.request.get(src!);
    expect(bundle.status()).toBe(200);
    expect(
      bundle.headers()["content-type"] ?? "",
      "niteen pitää tulla JavaScriptinä, ei HTML:nä",
    ).toContain("javascript");
  });

  test("SSE-virta avautuu oikealla palvelimella ja lähettää tilan", async ({ page }) => {
    // The stream is the app's whole data path; a one-shot check that the real
    // server opens it and pushes a parseable frame.
    await page.goto("/");
    const frame = await page.evaluate(async () => {
      const res = await fetch("/api/live/stream");
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      return new TextDecoder().decode(value);
    });
    expect(frame).toContain("event: live");
    const payload = frame.slice(frame.indexOf("data: ") + 6).split("\n")[0];
    const state = JSON.parse(payload) as { health: string; chain: unknown[] };
    expect(["ok", "warn", "fail", "idle"]).toContain(state.health);
    expect(state.chain.length).toBeGreaterThan(0);
  });
});
