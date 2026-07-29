// Lähteen tilan polleri (issue #104, vaihe 1). Jokainen riippuvuus injektoidaan,
// joten tämä tiedosto ei koske verkkoon, levylle eikä systemd:hen: yksikään
// testi ei saa kuluttaa YouTube-kiintiötä eikä kirjoittaa oikeaan
// control-tiedostoon.
//
// Painopiste on siinä mitä polleri KIELTÄYTYY tekemästä. Kiintiö on 10 000
// yksikköä vuorokaudessa, ja portti joka vuotaa (esim. huomisen ottelun
// "scheduled"-työ) polttaisi sen hiljaa ilman että kukaan huomaa ennen kuin
// lähetystä ei voi luoda.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthError } from "../src/server/googleAuth.js";
import {
  createSourceIngestPoller,
  SOURCE_INGEST_STALE_MS,
  type SourceIngestPollerDeps,
} from "../src/server/sourceIngest.js";
import { YouTubeApiError } from "../src/server/youtube.js";
import type { BroadcastSummary, StreamStatus } from "../src/server/youtube.js";
import type { Job, SourceIngest } from "../src/shared/types.js";

const NOW = Date.parse("2026-07-29T15:00:00.000Z");
const SOURCE_ID = "SOURCEID123";
const TARGET_ID = "TARGETID456";
const MATCH_ID = 146210;

const BASE_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 300_000;

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-a",
    status: "live",
    createdAt: "2026-07-29T12:00:00.000Z",
    matchId: MATCH_ID,
    home: "Kotijoukkue",
    away: "Vierasjoukkue",
    seriesName: null,
    stadium: null,
    startsAt: "2026-07-29T15:00:00.000Z",
    sourceUrl: `https://www.youtube.com/watch?v=${SOURCE_ID}`,
    targetStreamKey: "avain",
    targetRtmpUrl: "rtmp://example.invalid/live2",
    targetVideoId: TARGET_ID,
    startedAt: null,
    endedAt: null,
    note: null,
    ...overrides,
  };
}

function broadcast(overrides: Partial<BroadcastSummary> = {}): BroadcastSummary {
  return {
    videoId: SOURCE_ID,
    title: "Puhelimen oma live",
    watchUrl: `https://www.youtube.com/watch?v=${SOURCE_ID}`,
    scheduledStartTime: null,
    actualStartTime: null,
    lifeCycleStatus: "live",
    privacyStatus: "unlisted",
    boundStreamId: "stream-1",
    ...overrides,
  };
}

interface Harness {
  poller: ReturnType<typeof createSourceIngestPoller>;
  /** Se funktio jonka polleri OIKEASTI sai — myös silloin kun testi antoi
   *  omansa overridesissa. */
  fetchBroadcast: SourceIngestPollerDeps["fetchBroadcast"];
  fetchStream: SourceIngestPollerDeps["fetchStream"];
  writes: Array<{ matchId: number; ingest: SourceIngest }>;
}

const pollers: Array<{ stop(): void }> = [];

/** Rakentaa pollerin terveillä oletuksilla; jokainen testi korvaa vain sen
 *  riippuvuuden josta se on kiinnostunut. Kaikki ajastimet siivotaan
 *  afterEachissä, jottei yksikään testi jätä silmukkaa pyörimään toisen päälle. */
function harness(overrides: Partial<SourceIngestPollerDeps> = {}): Harness {
  const fetchBroadcast = vi.fn(async () => broadcast());
  const fetchStream = vi.fn(
    async (streamId: string): Promise<StreamStatus | null> => ({
      streamId,
      streamStatus: "active",
      healthStatus: "good",
    })
  );
  const writes: Array<{ matchId: number; ingest: SourceIngest }> = [];
  const writeIngest = vi.fn(async (matchId: number, ingest: SourceIngest) => {
    writes.push({ matchId, ingest });
  });

  const deps: SourceIngestPollerDeps = {
    getActiveJob: async () => job(),
    isRelayActive: async () => true,
    hasToken: async () => true,
    fetchBroadcast,
    fetchStream,
    writeIngest,
    now: () => Date.now(),
    ...overrides,
  };
  const poller = createSourceIngestPoller(deps);
  pollers.push(poller);
  return { poller, fetchBroadcast: deps.fetchBroadcast, fetchStream: deps.fetchStream, writes };
}

/** Ajaa käynnistyksen yhteydessä lähtevän ensimmäisen kierroksen loppuun. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------- portit

describe("portit", () => {
  it("ei aktiivista työtä: ei yhtään YouTube-kutsua", async () => {
    const h = harness({ getActiveJob: async () => null });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/ei aktiivista työtä/);
    expect(h.poller.current()).toBeNull();
  });

  it("työ on vasta ajastettu: ei kutsuja — getActiveJob palauttaa myös huomisen työn", async () => {
    const h = harness({ getActiveJob: async () => job({ status: "scheduled" }) });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/scheduled/);
  });

  it("relay ei ole käynnissä: ei kutsuja", async () => {
    const h = harness({ isRelayActive: async () => false });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/relay ei ole käynnissä/);
  });

  it("lähde-URLista ei saa videoId:tä: ei kutsuja", async () => {
    const h = harness({
      getActiveJob: async () => job({ sourceUrl: "https://www.youtube.com/@kanava/live" }),
    });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/videoId/);
  });

  it("lähde-URL osoittaa selostettuun lähetykseen: ei kutsuja (takaisinkytkentä)", async () => {
    const h = harness({
      getActiveJob: async () =>
        job({ sourceUrl: `https://www.youtube.com/watch?v=${TARGET_ID}`, targetVideoId: TARGET_ID }),
    });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/selostettuun lähetykseen/);
  });

  it("Google-tiliä ei ole yhdistetty: ei kutsuja", async () => {
    const h = harness({ hasToken: async () => false });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/Google-tiliä ei ole yhdistetty/);
  });

  it("portin sulkeutuminen nollaa aiemman havainnon — tilarivi ei näytä eilistä totuutta", async () => {
    let live = true;
    const h = harness({ isRelayActive: async () => live });
    await settle();
    expect(h.poller.current()?.streamStatus).toBe("active");

    live = false;
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);
    expect(h.poller.current()).toBeNull();
  });
});

// ------------------------------------------------------------------ havainnot

describe("havainto", () => {
  it("hakee lähetyksen ja sen striimin, kirjoittaa raa'at arvot työn matchId:llä", async () => {
    const h = harness();
    await settle();

    expect(h.fetchBroadcast).toHaveBeenCalledWith(SOURCE_ID);
    expect(h.fetchStream).toHaveBeenCalledWith("stream-1");
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].matchId).toBe(MATCH_ID);
    expect(h.writes[0].ingest).toEqual({
      observedAt: new Date(NOW).toISOString(),
      videoId: SOURCE_ID,
      lifeCycleStatus: "live",
      streamStatus: "active",
      healthStatus: "good",
      error: null,
    });
    expect(h.poller.current()).toEqual(h.writes[0].ingest);
    expect(h.poller.reason()).toBeNull();
  });

  it("ilman boundStreamId:tä toista kutsua ei tehdä ja striimin tila jää nulliksi", async () => {
    const h = harness({ fetchBroadcast: vi.fn(async () => broadcast({ boundStreamId: null })) });
    await settle();

    expect(h.fetchStream).not.toHaveBeenCalled();
    expect(h.writes[0].ingest.streamStatus).toBeNull();
    expect(h.writes[0].ingest.healthStatus).toBeNull();
    expect(h.writes[0].ingest.lifeCycleStatus).toBe("live");
  });

  it("kirjoittaa joka kierroksella myös kun mikään ei muuttunut", async () => {
    // Relay ylikirjoittaa koko control-tiedoston käynnistyessään, joten avaimen
    // on palattava sinne ilman että mikään muuttuu.
    const h = harness();
    await settle();
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);

    expect(h.writes).toHaveLength(3);
    expect(h.writes[2].ingest.streamStatus).toBe("active");
    // Sama havainto, tuore aikaleima.
    expect(h.writes[2].ingest.observedAt).toBe(new Date(NOW + 2 * BASE_INTERVAL_MS).toISOString());
  });

  it("lähetystä ei löydy: syy kirjataan ja väli nousee suoraan kattoon", async () => {
    const h = harness({ fetchBroadcast: vi.fn(async () => null) });
    await settle();

    expect(h.writes[0].ingest.error).toMatch(/ei löytynyt/);
    expect(h.writes[0].ingest.lifeCycleStatus).toBeNull();

    // Ei uutta kutsua ennen kattoa: tilanne ei korjaannu itsestään.
    await vi.advanceTimersByTimeAsync(MAX_INTERVAL_MS - 1);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(2);
  });
});

// -------------------------------------------------------------------- virheet

describe("virheet", () => {
  it("transientti virhe: väli kasvaa 30 → 60 → 120 → 300 eikä ylitä kattoa", async () => {
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      throw new Error("fetch failed");
    });
    const h = harness({ fetchBroadcast });
    await settle();
    expect(fetchBroadcast).toHaveBeenCalledTimes(1);
    expect(h.writes[0].ingest.error).toMatch(/lähteen tilaa ei saatu/);
    expect(h.writes[0].ingest.streamStatus).toBeNull();

    // Odotetut välit peräkkäisten yritysten VÄLILLÄ.
    for (const expected of [60_000, 120_000, 300_000, 300_000]) {
      await vi.advanceTimersByTimeAsync(expected - 1);
      const before = fetchBroadcast.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchBroadcast.mock.calls.length).toBe(before + 1);
    }
  });

  it("onnistuminen nollaa backoffin perusväliin", async () => {
    let fail = true;
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      if (fail) throw new Error("verkko poikki");
      return broadcast();
    });
    const h = harness({ fetchBroadcast });
    await settle();

    // 30 s → 60 s backoff, sitten onnistuminen.
    fail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchBroadcast).toHaveBeenCalledTimes(2);
    expect(h.writes[1].ingest.error).toBeNull();

    // Seuraava kierros taas perusvälin päässä.
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);
    expect(fetchBroadcast).toHaveBeenCalledTimes(3);
  });

  it("401/403: pitkä väli, tila-kentät nulliksi", async () => {
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      throw new YouTubeApiError("liveBroadcasts", 403, { error: { message: "quotaExceeded" } });
    });
    const h = harness({ fetchBroadcast });
    await settle();

    expect(h.writes[0].ingest.error).toMatch(/HTTP 403/);
    await vi.advanceTimersByTimeAsync(MAX_INTERVAL_MS - 1);
    expect(fetchBroadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchBroadcast).toHaveBeenCalledTimes(2);
  });

  it("needsReauth: yksi kirjoitus, ei uusia kutsuja ennen kuin token palaa", async () => {
    let token = true;
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      throw new GoogleAuthError("Refresh token ei kelpaa enää", true);
    });
    const h = harness({ fetchBroadcast, hasToken: async () => token });
    await settle();

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].ingest.error).toMatch(/uuden kirjautumisen/);

    // Token pois: kymmenen minuuttia hiljaisuutta, ei yhtään kutsua eikä
    // toistuvaa kirjoitusta samasta asiasta.
    token = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchBroadcast).toHaveBeenCalledTimes(1);
    expect(h.writes).toHaveLength(1);
    expect(h.poller.current()).toBeNull();

    // Kirjautumisen jälkeen pollaus jatkuu.
    token = true;
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);
    expect(fetchBroadcast).toHaveBeenCalledTimes(2);
  });

  it("katkaisee error-merkkijonon noin 200 merkkiin", async () => {
    // YouTubeApiErrorin viesti sisältää koko JSON-virherungon; sitä ei työnnetä
    // tiedostoon jonka relay jäsentää joka pollilla.
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      throw new YouTubeApiError("liveBroadcasts", 500, { error: { message: "x".repeat(2000) } });
    });
    const h = harness({ fetchBroadcast });
    await settle();

    expect(h.writes[0].ingest.error).not.toBeNull();
    expect((h.writes[0].ingest.error as string).length).toBeLessThanOrEqual(200);
  });

  it("kirjoituksen epäonnistuminen ei kaada silmukkaa mutta näkyy syynä", async () => {
    const h = harness({
      writeIngest: vi.fn(async () => {
        throw new Error("levy täynnä");
      }),
    });
    await settle();

    expect(h.poller.current()?.streamStatus).toBe("active");
    expect(h.poller.reason()).toMatch(/kirjoitus epäonnistui/);
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(2);
  });
});

describe("stop", () => {
  it("pysäyttää ajastimen: uusia kutsuja ei tule", async () => {
    const h = harness();
    await settle();
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(1);

    h.poller.stop();
    await vi.advanceTimersByTimeAsync(10 * MAX_INTERVAL_MS);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(1);
  });
});

describe("SOURCE_INGEST_STALE_MS", () => {
  it("on neljä perusväliä — kolme epäonnistunutta kierrosta ennen kuin havainto vanhenee", () => {
    expect(SOURCE_INGEST_STALE_MS).toBe(4 * BASE_INTERVAL_MS);
  });
});
