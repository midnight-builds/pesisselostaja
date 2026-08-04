/** Test harness: a mocked control API + a scriptable EventSource, so every UI
 *  test is deterministic and none of them depends on which pesäpallo matches
 *  happen to be running.
 *
 *  Two deliberate choices:
 *
 *  1. The PAGE is served by the real control server (playwright.config.ts), so
 *     the tests still exercise index.ts's static serving — that is where the
 *     "blank shell, bundle never loaded" bug lived, and it is invisible to
 *     typecheck. Only /api/** is intercepted.
 *  2. EventSource is replaced by a stub the test drives. Playwright's route
 *     fulfilment cannot hold a stream open, and a stub also lets a test cut the
 *     connection at an exact instant — which is the whole point of the SSE
 *     reconnect tests. The app's own reconnect policy still runs unmodified. */

import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { CreateJobRequest } from "../../src/shared/api";
import type { ControlKnobs, DayMatches, Job, LiveState, LogLine, PreflightResult } from "../../src/shared/types";
import * as fixture from "./state";

const CONTROL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHOT_DIR = join(CONTROL_ROOT, "test-results", "screenshots");

export interface ApiCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

/** In-memory stand-in for the control server's API surface. Tests mutate the
 *  public fields before (or between) interactions and read `calls` afterwards. */
export class ApiMock {
  calls: ApiCall[] = [];
  live: LiveState = fixture.liveState();
  jobs: Job[] = [fixture.job()];
  knobs: ControlKnobs = fixture.knobs();
  preflight: PreflightResult = fixture.preflightResult();
  /** Pysyväisasetukset (#133). Mutatoituu PATCHista, jotta testi voi tarkistaa
   *  että osittainen päivitys ei nollaa toista korttia. */
  settings = {
    shareTemplate: {
      opening: "Seuraava live on klo {time}: {matchup}. Alla linkit:",
      lines: ["YouTube: {watchUrl}", "YouTube selostettu: {narratedWatchUrl}", "Tulokset: {matchUrl}"],
    },
    venueCleanup: { stripFieldNumber: true, stripQualifier: true },
  };
  log: LogLine[] = fixture.logLines();
  day: (date: string) => DayMatches = (date) => fixture.dayMatches(date);
  /** Google-yhteyden tila. Ilman yhteyttä palvelin vastaa 409:llä jokaiseen
   *  muuhun YouTube-reittiin kuin terveyteen, ja UI näyttää AuthMissingNoticen
   *  — sen takia tämä yksi kenttä ohjaa koko välilehden käytöksen. */
  /** Ajastimen tila. Oletus pois päältä, kuten palvelimellakin. */
  scheduler = fixture.schedulerState();
  authHealth = fixture.authHealth();
  broadcasts: unknown[] = [];
  playlists: unknown[] = [];
  /** Routes to answer with an error, e.g. { "POST /api/relay/start": "..." }.
   *  A bare string is a 500; give `{ status, error }` when the status itself
   *  is part of what's under test (404 for an unknown match id). */
  failures = new Map<string, string | { status: number; error: string }>();

  calledWith(method: string, path: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  called(method: string, path: string): boolean {
    return this.calledWith(method, path).length > 0;
  }
}

/** The EventSource stub's control surface, as seen from the test. */
export interface SseHandle {
  /** Number of EventSource objects the app has constructed so far — a
   *  reconnect shows up as an increment. */
  connections(): Promise<number>;
  /** Push one LiveState frame on the newest connection. */
  push(state: LiveState): Promise<void>;
  /** Kill the newest connection the way a dropped stream does. */
  breakConnection(): Promise<void>;
  /** Wait until the app has opened at least `n` connections. */
  waitForConnections(n: number, timeoutMs?: number): Promise<void>;
}

const SSE_STUB = `(() => {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this._listeners = {};
      instances.push(this);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        if (this.onopen) this.onopen({ type: "open" });
      }, 0);
    }
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this._listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
    close() {
      this.readyState = 2;
    }
    _emit(type, data) {
      if (this.readyState === 2) return;
      const ev = { type, data, lastEventId: "" };
      for (const fn of this._listeners[type] || []) fn(ev);
      if (type === "message" && this.onmessage) this.onmessage(ev);
    }
    _fail() {
      this.readyState = 2;
      if (this.onerror) this.onerror({ type: "error" });
    }
  }
  window.EventSource = FakeEventSource;
  window.__sse = {
    count: () => instances.length,
    push: (json) => {
      const es = instances[instances.length - 1];
      if (es) es._emit("live", json);
    },
    fail: () => {
      const es = instances[instances.length - 1];
      if (es) es._fail();
    },
  };
})();`;

function sseHandle(page: Page): SseHandle {
  return {
    connections: () => page.evaluate(() => window.__sse.count()),
    push: (state) => page.evaluate((json) => window.__sse.push(json), JSON.stringify(state)),
    breakConnection: () => page.evaluate(() => window.__sse.fail()),
    async waitForConnections(n, timeoutMs = 10_000) {
      await page.waitForFunction((min) => window.__sse.count() >= min, n, { timeout: timeoutMs });
    },
  };
}

function jsonBody(request: { postData(): string | null }): unknown {
  const raw = request.postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function installApiMock(page: Page, api: ApiMock): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = jsonBody(request);
    api.calls.push({ method, path, search: url.search, body });

    const failure = api.failures.get(`${method} ${path}`);
    if (failure) {
      const { status, error } = typeof failure === "string" ? { status: 500, error: failure } : failure;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error }) });
      return;
    }

    const send = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

    // The stream is never actually requested (EventSource is stubbed), but a
    // real request must not fall through to the server and hang the test.
    if (path === "/api/live/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    if (path === "/api/live") return void (await send(api.live));

    if (path === "/api/matches" && method === "GET") {
      const date = url.searchParams.get("date") ?? "";
      return void (await send(api.day(date)));
    }
    const matchId = /^\/api\/matches\/(\d+)$/.exec(path);
    if (matchId) {
      const id = Number(matchId[1]);
      const found = api.day("2026-07-29").matches.find((m) => m.id === id);
      return void (await send(found ?? fixture.matchOption({ id })));
    }

    if (path === "/api/jobs" && method === "GET") return void (await send(api.jobs));
    if (path === "/api/jobs" && method === "POST") {
      const payload = (body ?? {}) as CreateJobRequest;
      // Aloitusaika otetaan päivän fixtuurista kuten palvelimella (createJob
      // hakee ottelun): se on suhteessa *nyt*-hetkeen, ja käyttöliittymä
      // torjuu liian kauan sitten alkaneen ottelun sen perusteella.
      const match = api.day("2026-07-29").matches.find((m) => m.id === payload.matchId);
      const created = fixture.job({
        id: `job-${api.jobs.length + 1}`,
        status: "draft",
        matchId: payload.matchId,
        startsAt: match?.startsAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      api.jobs = [...api.jobs, created];
      return void (await send(created, 201));
    }
    const activate = /^\/api\/jobs\/([^/]+)\/activate$/.exec(path);
    if (activate && method === "POST") {
      const forced = ((body ?? {}) as { force?: boolean }).force === true;
      // The server refuses (409) while another job holds the broadcast slot,
      // unless the operator forced it — the real invariant, mirrored here so
      // the UI's recovery path can be tested end to end (#101).
      const clashing = api.jobs.find(
        (j) => j.id !== activate[1] && (j.status === "arming" || j.status === "live")
      );
      if (clashing && !forced) {
        return void (await send(
          { error: `${clashing.home} vastaan ${clashing.away} on jo lähetyksessä — lopeta se ensin, ennen kuin tämä työ voi käynnistyä.` },
          409
        ));
      }
      api.jobs = api.jobs.map((j) =>
        j.id === activate[1] ? { ...j, status: "arming" as const }
        : j.id === clashing?.id ? { ...j, status: "finished" as const }
        : j
      );
      return void (await send(api.jobs.find((j) => j.id === activate[1]) ?? api.jobs[0]));
    }
    const jobId = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (jobId && method === "PATCH") {
      const patch = (body ?? {}) as Partial<Job>;
      api.jobs = api.jobs.map((j) => (j.id === jobId[1] ? { ...j, ...patch } : j));
      return void (await send(api.jobs.find((j) => j.id === jobId[1]) ?? api.jobs[0]));
    }

    if (path === "/api/preflight") return void (await send(api.preflight));

    if (/^\/api\/relay\/(start|stop|restart)$/.test(path)) {
      return void (await send(api.live.relay));
    }

    if (path === "/api/knobs") {
      const patch = (body ?? {}) as Partial<ControlKnobs>;
      api.knobs = { ...api.knobs, ...patch };
      return void (await send(api.knobs));
    }
    if (path === "/api/knobs/delay-nudge") {
      const { deltaMs } = (body ?? {}) as { deltaMs: number };
      api.knobs = { ...api.knobs, narrationDelayMs: api.knobs.narrationDelayMs + deltaMs };
      return void (await send(api.knobs));
    }

    // Push notifications are a separate feature that mounts on the live view;
    // answered here only so its mount does not turn into console noise. The
    // shapes are inlined rather than imported so this harness does not couple
    // itself to that feature's types.
    if (path === "/api/push/key") return void (await send({ publicKey: "BTestVapidPublicKey" }));
    if (path === "/api/push/prefs") {
      return void (await send({ broken: true, autoFix: true, startup: true, ended: true }));
    }
    if (path.startsWith("/api/push/")) return void (await send({}));

    // ── Asetukset (#133) ─────────────────────────────────────────────────
    if (path === "/api/settings" && method === "GET") return void (await send(api.settings));
    if (path === "/api/settings" && method === "PATCH") {
      const patch = (body ?? {}) as Partial<typeof api.settings>;
      // Osittainen, kuten palvelimella: koskematon osa säilyy.
      if (patch.shareTemplate) api.settings.shareTemplate = patch.shareTemplate;
      if (patch.venueCleanup) api.settings.venueCleanup = patch.venueCleanup;
      return void (await send(api.settings));
    }

    // ── Ajastin ──────────────────────────────────────────────────────────
    if (path === "/api/scheduler" && method === "GET") return void (await send(api.scheduler));
    if (path === "/api/scheduler/enable" && method === "POST") {
      const { enabled } = (body ?? {}) as { enabled?: unknown };
      // Sama tiukkuus kuin palvelimella: truthy merkkijono ei saa virittää
      // automaattikäynnistystä.
      if (typeof enabled !== "boolean") {
        return void (await send({ error: "enabled puuttuu tai ei ole tosi/epätosi" }, 400));
      }
      api.scheduler = { ...api.scheduler, enabled };
      return void (await send(api.scheduler));
    }

    // ── YouTube ──────────────────────────────────────────────────────────
    // Health answers 200 in every state; everything else is 409 until a
    // connection exists, which is exactly how the real server behaves and what
    // makes AuthMissingNotice appear. Mirroring that here means the tab is
    // tested in the state it actually ships in today: no credentials on the box.
    if (path === "/api/youtube/health") return void (await send(api.authHealth));
    if (path.startsWith("/api/youtube/") || path.startsWith("/api/thumbnail/")) {
      if (!api.authHealth.connected) {
        return void (await send({ error: "Google-tiliä ei ole yhdistetty." }, 409));
      }
      if (path === "/api/youtube/broadcasts" && method === "GET") {
        return void (await send(api.broadcasts));
      }
      if (path === "/api/youtube/playlists") return void (await send(api.playlists));
      if (path === "/api/youtube/templates/preview" && method === "POST") {
        const payload = (body ?? {}) as { jobId?: string; overrides?: Record<string, string> };
        return void (await send({
          matchId: 999001,
          jobId: payload.jobId ?? null,
          texts: fixture.broadcastTexts(payload.overrides ?? {}),
        }));
      }
      if (path === "/api/youtube/broadcasts" && method === "POST") {
        const payload = (body ?? {}) as { overrides?: Record<string, string> };
        return void (await send(fixture.createdPair(fixture.broadcastTexts(payload.overrides ?? {}))));
      }
      // Thumbnailin esikatselu palauttaa kuvatavuja, ei JSONia.
      if (path === "/api/thumbnail/preview" && method === "POST") {
        return void (await route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
      }
    }

    if (path === "/api/log") {
      const level = url.searchParams.get("level");
      const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
      const rows = level ? api.log.filter((l) => rank[l.level] >= rank[level]) : api.log;
      return void (await send(rows));
    }

    await send({ error: `mockkaamaton reitti: ${method} ${path}` }, 501);
  });
}

/** Pienin mahdollinen kelvollinen PNG: thumbnail-esikatselu palauttaa oikeita
 *  kuvatavuja, ja komponentti tekee niistä object-URLin. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Google Fonts must not decide whether a test passes: fulfil them locally so
 *  the "no failed requests" assertions describe OUR app, not the network. */
async function stubExternalRequests(page: Page): Promise<void> {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async (route) => {
    const type = route.request().resourceType();
    if (type === "stylesheet") {
      await route.fulfill({ status: 200, contentType: "text/css", body: "/* fonts stubbed in tests */" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "font/woff2", body: "" });
  });
}

export interface PageErrors {
  console: string[];
  failedRequests: string[];
}

function collectErrors(page: Page): PageErrors {
  const errors: PageErrors = { console: [], failedRequests: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.console.push(msg.text());
  });
  page.on("pageerror", (err) => errors.console.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    errors.failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "?"}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) errors.failedRequests.push(`${res.status()} ${res.url()}`);
  });
  return errors;
}

interface Fixtures {
  api: ApiMock;
  sse: SseHandle;
  errors: PageErrors;
  /** Loads the app with mocks installed and the given first LiveState frame. */
  openApp: (state?: LiveState) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  api: async ({}, use) => {
    await use(new ApiMock());
  },
  errors: async ({ page }, use) => {
    await use(collectErrors(page));
  },
  sse: async ({ page }, use) => {
    await use(sseHandle(page));
  },
  openApp: async ({ page, api, sse, errors }, use) => {
    void errors; // instantiated for its side effect: listeners attached early
    await page.addInitScript(SSE_STUB);
    await stubExternalRequests(page);
    await installApiMock(page, api);
    await use(async (state?: LiveState) => {
      if (state) api.live = state;
      await page.goto("/");
      await sse.waitForConnections(1);
      await sse.push(api.live);
      // Tilakortin otsikkosana renderöityy juuri työnnetystä kehyksestä, joten
      // sen odottaminen tarkoittaa että jokainen myöhempi väite ajetaan
      // maalattua näkymää vasten. Otsikkoa (headline) ei voi käyttää tähän:
      // se näkyy vain ottelunaikaisessa tilassa.
      await expect(stateWord(page)).toBeVisible();
    });
  },
});

export { expect };

/** Tilakortin otsikkosana — etusivun ainoa aina läsnä oleva teksti (#173). */
export function stateWord(page: Page): Locator {
  return page.locator(".state__word");
}

/** Writes a screenshot artifact under apps/control/test-results/screenshots/. */
export async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  const file = join(SHOT_DIR, `${info.project.name}-${name}.png`);
  await page.screenshot({ path: file });
  await info.attach(name, { path: file, contentType: "image/png" });
}

// ─────────────────────────────────────────────── layout / a11y measurements

export interface Overflow {
  selector: string;
  scrollWidth: number;
  clientWidth: number;
}

/** Any element whose content is wider than its box — i.e. anything that would
 *  make the operator swipe sideways. Text inputs are excluded: a long value in
 *  a fixed-width input legitimately overflows its own scroll box. */
export async function horizontalOverflow(page: Page): Promise<Overflow[]> {
  return page.evaluate(() => {
    const bad: Array<{ selector: string; scrollWidth: number; clientWidth: number }> = [];
    const describe = (el: Element) => {
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      return `${el.tagName.toLowerCase()}${cls}`;
    };
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        bad.push({ selector: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    }
    return bad;
  });
}

export interface TapTarget {
  label: string;
  selector: string;
  width: number;
  height: number;
}

/** Every visible interactive element with its rendered box. */
export async function tapTargets(page: Page): Promise<TapTarget[]> {
  return page.evaluate(() => {
    const out: Array<{ label: string; selector: string; width: number; height: number }> = [];
    const nodes = document.querySelectorAll("button, a[href], input, select, [role=button]");
    for (const el of Array.from(nodes)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : "";
      out.push({
        label: (el.textContent ?? "").trim().slice(0, 40) || el.getAttribute("aria-label") || el.tagName.toLowerCase(),
        selector: `${el.tagName.toLowerCase()}${cls}`,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      });
    }
    return out;
  });
}

/** WCAG contrast ratio of a locator's text against its composited background.
 *
 *  Backgrounds are composited by walking up the ancestor chain. Gradient layers
 *  (the health banner tints itself with one) are approximated by their most
 *  opaque colour stop — that is the strongest tint, i.e. the worst case for the
 *  text sitting at the top of the banner, which is exactly where the big status
 *  word is. */
export async function contrastRatio(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const parse = (value: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return null;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };

    const layers: Array<[number, number, number, number]> = [];
    let node: Element | null = el;
    while (node) {
      const cs = getComputedStyle(node);
      const image = cs.backgroundImage;
      if (image && image !== "none") {
        const stops = Array.from(image.matchAll(/rgba?\([^)]*\)/g))
          .map((m) => parse(m[0]))
          .filter((c): c is [number, number, number, number] => c !== null);
        if (stops.length > 0) {
          layers.push(stops.reduce((a, b) => (b[3] > a[3] ? b : a)));
        }
      }
      const bg = parse(cs.backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] === 1) break; // opaque layer: nothing below it can show through
      }
      node = node.parentElement;
    }

    let base: [number, number, number] = [0, 0, 0];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    }

    const fg = parse(getComputedStyle(el).color) ?? [255, 255, 255, 1];
    // Text with its own alpha is composited over the background first.
    const text: [number, number, number] = [
      fg[0] * fg[3] + base[0] * (1 - fg[3]),
      fg[1] * fg[3] + base[1] * (1 - fg[3]),
      fg[2] * fg[3] + base[2] * (1 - fg[3]),
    ];

    const l1 = lum(text);
    const l2 = lum(base);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return Math.round(ratio * 100) / 100;
  });
}

declare global {
  interface Window {
    __sse: {
      count(): number;
      push(json: string): void;
      fail(): void;
    };
  }
}
