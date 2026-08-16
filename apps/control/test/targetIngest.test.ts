// Kohteen eli selostetun lähetyksen tilan polleri (issue #250). Sama
// testausote kuin lähteen pollerilla (sourceIngest.test.ts): jokainen
// riippuvuus injektoidaan, yksikään testi ei koske verkkoon eikä kuluta
// YouTube-kiintiötä, ja painopiste on siinä mitä polleri KIELTÄYTYY tekemästä
// — vuotava portti polttaisi kiintiön hiljaa.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthError } from "../src/server/googleAuth.js";
import {
  createTargetIngestPoller,
  type TargetIngestPollerDeps,
} from "../src/server/targetIngest.js";
import { TARGET_INGEST_STALE_MS } from "../src/shared/targetHealth.js";
import { YouTubeApiError } from "../src/server/youtube.js";
import type { BroadcastSummary, StreamStatus } from "../src/server/youtube.js";
import type { Job } from "../src/shared/types.js";

const NOW = Date.parse("2026-08-16T15:00:00.000Z");
const SOURCE_ID = "SOURCEID123";
const TARGET_ID = "TARGETID456";
const MATCH_ID = 136771;
const FINGERPRINT = "2026-08-10T08:00:00.000Z";

const BASE_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 300_000;

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-a",
    status: "live",
    createdAt: "2026-08-16T12:00:00.000Z",
    matchId: MATCH_ID,
    home: "Kotijoukkue",
    away: "Vierasjoukkue",
    seriesName: null,
    stadium: null,
    startsAt: "2026-08-16T15:00:00.000Z",
    sourceUrl: `https://www.youtube.com/watch?v=${SOURCE_ID}`,
    targetStreamKey: "avain",
    targetRtmpUrl: "rtmp://example.invalid/live2",
    targetVideoId: TARGET_ID,
    armedAt: null,
    startedAt: null,
    endedAt: null,
    cleanup: null,
    note: null,
    ...overrides,
  };
}

function broadcast(overrides: Partial<BroadcastSummary> = {}): BroadcastSummary {
  return {
    videoId: TARGET_ID,
    title: "Selostettu lähetys",
    watchUrl: `https://www.youtube.com/watch?v=${TARGET_ID}`,
    scheduledStartTime: null,
    actualStartTime: null,
    lifeCycleStatus: "live",
    privacyStatus: "unlisted",
    boundStreamId: "stream-1",
    ...overrides,
  };
}

interface Harness {
  poller: ReturnType<typeof createTargetIngestPoller>;
  fetchBroadcast: TargetIngestPollerDeps["fetchBroadcast"];
  fetchStream: TargetIngestPollerDeps["fetchStream"];
}

const pollers: Array<{ stop(): void }> = [];

function harness(overrides: Partial<TargetIngestPollerDeps> = {}): Harness {
  const fetchBroadcast = vi.fn(async () => broadcast());
  const fetchStream = vi.fn(
    async (streamId: string): Promise<StreamStatus | null> => ({
      streamId,
      streamStatus: "active",
      healthStatus: "good",
    })
  );

  const deps: TargetIngestPollerDeps = {
    getActiveJob: async () => job(),
    isRelayActive: async () => true,
    getRunningMatchId: async () => MATCH_ID,
    getTokenFingerprint: async () => FINGERPRINT,
    getQuotaRemaining: async () => 10_000,
    fetchBroadcast,
    fetchStream,
    now: () => Date.now(),
    ...overrides,
  };
  const poller = createTargetIngestPoller(deps);
  pollers.push(poller);
  return { poller, fetchBroadcast: deps.fetchBroadcast, fetchStream: deps.fetchStream };
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

  // Ottelu A on yhä lähetyksessä ja operaattori aktivoi ottelun B: B:n
  // kohteeseen ei työnnetä mitään, ja sen tila (esim. edellisestä käytöstä
  // päättynyt) hälyttäisi väärin uuden ottelun nimissä.
  it("relay ajaa toista ottelua: ei kutsuja ja syy kertoo mitä se ajaa", async () => {
    const h = harness({ getRunningMatchId: async () => 999999 });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/relay ajaa toista ottelua \(999999\)/);
  });

  it("relaylta ei ole tuoretta telemetriaa: ei kutsuja", async () => {
    const h = harness({ getRunningMatchId: async () => null });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/tuoretta telemetriaa/);
  });

  it("työllä ei ole selostettua lähetystä: ei kutsuja", async () => {
    const h = harness({ getActiveJob: async () => job({ targetVideoId: null }) });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/ei ole selostettua lähetystä/);
  });

  it("Google-tiliä ei ole yhdistetty: ei kutsuja", async () => {
    const h = harness({ getTokenFingerprint: async () => null });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/Google-tiliä ei ole yhdistetty/);
  });

  it("kiintiö vähissä: ei kutsuja — lähetysten luonti menee havainnon edelle", async () => {
    const h = harness({ getQuotaRemaining: async () => 499 });
    await settle();
    expect(h.fetchBroadcast).not.toHaveBeenCalled();
    expect(h.poller.reason()).toMatch(/kiintiöstä jäljellä vain 499/i);
  });

  it("kiintiövarauksen yläpuolella pollataan normaalisti", async () => {
    const h = harness({ getQuotaRemaining: async () => 500 });
    await settle();
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(1);
  });

  // Portin sulkeutuessa vanha havainto EI saa jäädä näkyviin: relayn
  // sammuttua (ottelu ohi, autostop sulki kohteen) muistiin jäänyt
  // "complete" kuuluisi jo päättyneelle ajolle ja hälyttäisi väärin, jos
  // sama työ vielä hetken näyttää liveltä.
  it("portin sulkeutuminen nollaa aiemman havainnon", async () => {
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
  it("hakee kohteen ja sen striimin ja julkaisee raa'at arvot", async () => {
    const h = harness();
    await settle();

    expect(h.fetchBroadcast).toHaveBeenCalledWith(TARGET_ID);
    expect(h.fetchStream).toHaveBeenCalledWith("stream-1");
    expect(h.poller.current()).toEqual({
      observedAt: new Date(NOW).toISOString(),
      videoId: TARGET_ID,
      lifeCycleStatus: "live",
      streamStatus: "active",
      healthStatus: "good",
      error: null,
    });
    expect(h.poller.reason()).toBeNull();
  });

  // Tämä on koko pollerin olemassaolon syy: 16.8.2026 autostop päätti
  // selostetun lähetyksen kesken ottelun eikä mikään huomannut sitä.
  it("julkaisee complete-tilan sellaisenaan — päätös hälytyksestä tehdään muualla", async () => {
    const h = harness({
      fetchBroadcast: vi.fn(async () => broadcast({ lifeCycleStatus: "complete" })),
    });
    await settle();
    expect(h.poller.current()?.lifeCycleStatus).toBe("complete");
    expect(h.poller.current()?.error).toBeNull();
  });

  it("ilman boundStreamId:tä toista kutsua ei tehdä ja striimin tila jää nulliksi", async () => {
    const h = harness({ fetchBroadcast: vi.fn(async () => broadcast({ boundStreamId: null })) });
    await settle();

    expect(h.fetchStream).not.toHaveBeenCalled();
    expect(h.poller.current()?.streamStatus).toBeNull();
    expect(h.poller.current()?.lifeCycleStatus).toBe("live");
  });

  it("lähetystä ei löydy: yksi uusinta perusvälillä, vasta sitten katto", async () => {
    const h = harness({ fetchBroadcast: vi.fn(async () => null) });
    await settle();

    expect(h.poller.current()?.error).toMatch(/ei löytynyt/);
    expect(h.poller.current()?.lifeCycleStatus).toBeNull();

    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS - 1);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(MAX_INTERVAL_MS - 1);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchBroadcast).toHaveBeenCalledTimes(3);
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
    expect(h.poller.current()?.error).toMatch(/selostetun lähetyksen tilaa ei saatu/);
    expect(h.poller.current()?.streamStatus).toBeNull();

    for (const expected of [60_000, 120_000, 300_000, 300_000]) {
      await vi.advanceTimersByTimeAsync(expected - 1);
      const before = fetchBroadcast.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchBroadcast.mock.calls.length).toBe(before + 1);
    }
  });

  it("401/403: pitkä väli, tila-kentät nulliksi", async () => {
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      throw new YouTubeApiError("liveBroadcasts", 403, { error: { message: "quotaExceeded" } });
    });
    const h = harness({ fetchBroadcast });
    await settle();

    expect(h.poller.current()?.error).toMatch(/HTTP 403/);
    await vi.advanceTimersByTimeAsync(MAX_INTERVAL_MS - 1);
    expect(fetchBroadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchBroadcast).toHaveBeenCalledTimes(2);
  });

  it("needsReauth: ei uusia kutsuja ennen kuin token vaihtuu", async () => {
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      throw new GoogleAuthError("Refresh token ei kelpaa enää", true);
    });
    const h = harness({ fetchBroadcast });
    await settle();
    expect(h.poller.current()?.error).toMatch(/uuden kirjautumisen/);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchBroadcast).toHaveBeenCalledTimes(1);
    expect(h.poller.current()).toBeNull();
    expect(h.poller.reason()).toMatch(/uuden kirjautumisen/);
  });

  it("uudelleenkirjautuminen avaa reauth-lukon heti, ilman aikakatkaisua", async () => {
    let fingerprint = FINGERPRINT;
    let broken = true;
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      if (broken) throw new GoogleAuthError("Refresh token ei kelpaa enää", true);
      return broadcast();
    });
    const h = harness({ fetchBroadcast, getTokenFingerprint: async () => fingerprint });
    await settle();
    expect(fetchBroadcast).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    fingerprint = "2026-08-16T15:02:00.000Z";
    broken = false;

    await vi.advanceTimersByTimeAsync(MAX_INTERVAL_MS - 60_000);
    expect(fetchBroadcast).toHaveBeenCalledTimes(2);
    expect(h.poller.current()?.streamStatus).toBe("active");
    expect(h.poller.reason()).toBeNull();
  });

  it("katkaisee error-merkkijonon noin 200 merkkiin", async () => {
    const fetchBroadcast = vi.fn(async (): Promise<BroadcastSummary | null> => {
      throw new YouTubeApiError("liveBroadcasts", 500, { error: { message: "x".repeat(2000) } });
    });
    const h = harness({ fetchBroadcast });
    await settle();

    expect(h.poller.current()?.error).not.toBeNull();
    expect((h.poller.current()?.error as string).length).toBeLessThanOrEqual(200);
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

describe("TARGET_INGEST_STALE_MS", () => {
  it("on neljä perusväliä — sama sääntö kuin lähteen havainnolla", () => {
    expect(TARGET_INGEST_STALE_MS).toBe(4 * BASE_INTERVAL_MS);
  });
});
