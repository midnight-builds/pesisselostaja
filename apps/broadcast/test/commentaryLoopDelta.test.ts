import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

// Mock ONLY the network call; everything else (speech helpers, state,
// formatHelsinkiTimestamp) stays real.
vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchLiveEvents: vi.fn() };
});

import { fetchLiveEvents, formatHelsinkiTimestamp } from "@pesisselostaja/core";
import type { LiveEvent, LiveEventsResult, SubEvent } from "@pesisselostaja/core";
import { CommentaryLoop } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";
import type { EventHistory } from "../src/eventHistory.js";

const fetchMock = vi.mocked(fetchLiveEvents);

// Fictional data only (public repo).
function ev(overrides: Partial<LiveEvent> = {}, subs: SubEvent[] = []): LiveEvent {
  return {
    id: 1, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: subs, timestamp: 10, updated: null,
    ...overrides,
  };
}
const palo: SubEvent = { texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }] };
const run: SubEvent = { texts: [{ type: "stat", score: 1 }] };

const T0 = Date.parse("2026-07-17T08:00:00Z");
/** Shape of a real reset answer: the instant the match's online data was
 *  created, ISO with the Helsinki offset — and here newer than the `after` a
 *  poll derives from T0 (T0 - 180 s), i.e. the match-start case that made
 *  every early poll reset (verified live 2026-07-28, issue #46). */
const RESET_AT_ISO = new Date(T0 - 60 * 1000).toISOString();

function result(events: LiveEvent[], extra: Partial<LiveEventsResult> = {}): LiveEventsResult {
  return { events, notModified: false, etag: 'W/"tag"', serverDateMs: T0, ...extra };
}

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, maxFailureWindowMs: 720000, finishedFailureWindowMs: 120000, hardStopQuietMs: 180000,
    noSignalSlate: false, noSignalSlateAfterMs: 8000,
    noSignalSlateWidth: 1920, noSignalSlateHeight: 1080,
    deltaFetch: true,
    pollTrace: false, announceBatterChanges: true, dryRun: false,
    apiKey: "test", apiBase: "https://example.invalid/api",
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    runRetentionDays: 0,
    ttsCacheMaxBytes: 0,
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
    ...overrides,
  };
}

/** Typed view of the private members these tests drive directly. */
interface LoopInternals {
  fetchFullEvents(): Promise<LiveEventsResult>;
  fetchEventsForPoll(): Promise<LiveEventsResult | null>;
  refreshRuntimeControls(): Promise<void>;
  history: EventHistory;
  lastServerDateMs: number | null;
  lastFullFetchAt: number;
  deltaFetch: boolean;
  pollIntervalMs: number;
  narrationDelayMs: number;
  pollStatsSummary: string;
  maybeLogPollWindow(): void;
  lastPollSummaryAtMs: number;
  recordPollFailure(err: unknown, cycleStartedAt: number): void;
  recordPollSuccess(): void;
  writeControlFile(): void;
  announceBatterChanges: boolean;
}

function makeLoop(overrides: Partial<RelayConfig> = {}): LoopInternals {
  const loop = new CommentaryLoop(makeConfig(overrides), async () => {});
  return loop as unknown as LoopInternals;
}

beforeEach(() => fetchMock.mockReset());

describe("CommentaryLoop delta polling", () => {
  it("full fetch replaces the history and re-bases the delta cursor", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();
    expect(loop.history.events.map((e) => e.id)).toEqual([1]);
    expect(loop.lastServerDateMs).toBe(T0);
  });

  it("delta poll asks with after = last Date header minus the safety margin, merges, and processing sees the FULL history", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    fetchMock.mockResolvedValueOnce(result([ev({ id: 2 }, [run])], { serverDateMs: T0 + 3000 }));
    const res = await loop.fetchEventsForPoll();

    expect(res).not.toBeNull();
    const opts = fetchMock.mock.calls[1][1] as { after?: string; skipDelay?: boolean };
    expect(opts.skipDelay).toBe(true);
    expect(opts.after).toBe(formatHelsinkiTimestamp(new Date(T0 - 180 * 1000)));
    // The merged history — what processEventsLive actually runs on — holds both.
    expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("keeps the after URL stable through a quiet stretch and turns its ETag into a 304 skip", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    // Quiet 200: nothing new → cursor + etag stored for this exact after URL.
    fetchMock.mockResolvedValueOnce(result([], { etag: 'W/"quiet"' }));
    await loop.fetchEventsForPoll();

    // Next poll sends If-None-Match for the same after; server says 304.
    fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"quiet"', serverDateMs: T0 + 6000 });
    const res = await loop.fetchEventsForPoll();

    expect(res).toBeNull(); // 304 → skip event processing entirely
    const secondOpts = fetchMock.mock.calls[1][1] as { after?: string; etag?: string };
    const thirdOpts = fetchMock.mock.calls[2][1] as { after?: string; etag?: string };
    expect(thirdOpts.after).toBe(secondOpts.after); // URL did not move
    expect(thirdOpts.etag).toBe('W/"quiet"');
  });

  it("uses the reset answer itself as the full snapshot — one request, no second full fetch (issue #46)", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    // A real reset answer ignores `after` and carries the whole history.
    fetchMock.mockResolvedValueOnce(result([ev({ id: 5 }), ev({ id: 6 })], { reset: RESET_AT_ISO }));
    await loop.fetchEventsForPoll();

    expect(fetchMock).toHaveBeenCalledTimes(2); // startup full + this delta. NOT 3.
    expect(loop.history.events.map((e) => e.id)).toEqual([5, 6]); // rebuilt from the reset answer
  });

  it("still pays for a real full fetch if a reset answer holds fewer events than the local history", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo]), ev({ id: 2 }, [run])]));
    await loop.fetchFullEvents();

    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])], { reset: RESET_AT_ISO })); // suspiciously short
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo]), ev({ id: 2 }, [run])]));
    await loop.fetchEventsForPoll();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2][1] as { after?: string }).after).toBeUndefined();
    expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("falls back to a full fetch when a delta shrinks an event's sub-event list (inconsistent)", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo, run])]));
    await loop.fetchFullEvents();

    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])])); // shrunk!
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo, run]), ev({ id: 2 })]));
    await loop.fetchEventsForPoll();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("does a periodic full resync that replaces the merged history", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();

    loop.lastFullFetchAt = Date.now() - 61_000; // resync due
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo]), ev({ id: 2 })]));
    await loop.fetchEventsForPoll();

    const opts = fetchMock.mock.calls[1][1] as { after?: string };
    expect(opts.after).toBeUndefined(); // a genuine full fetch
    expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("polls with full fetches while the history is empty — no delta, no reset loop", async () => {
    const loop = makeLoop();
    // Match being initialized: the full fetch succeeds but returns no events.
    fetchMock.mockResolvedValue(result([]));
    await loop.fetchFullEvents();
    await loop.fetchEventsForPoll();
    await loop.fetchEventsForPoll();
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as { after?: string }).after).toBeUndefined();
    }
    // First events arrive → delta engages on the following poll.
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchEventsForPoll(); // still full (history was empty)
    fetchMock.mockResolvedValueOnce(result([ev({ id: 2 }, [run])]));
    await loop.fetchEventsForPoll();
    const lastOpts = fetchMock.mock.calls.at(-1)![1] as { after?: string };
    expect(lastOpts.after).toBeDefined();
  });

  it("deltaFetch=false reverts to plain full fetches", async () => {
    const loop = makeLoop({ deltaFetch: false });
    fetchMock.mockResolvedValue(result([ev({ id: 1 })]));
    await loop.fetchEventsForPoll();
    await loop.fetchEventsForPoll();
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as { after?: string }).after).toBeUndefined();
    }
  });
});

describe("CommentaryLoop poll statistics + failure streaks", () => {
  it("counts polls, delta merges, 304 skips and full fetches into the heartbeat summary", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents(); // startup fetch: full +1, not a poll

    fetchMock.mockResolvedValueOnce(result([ev({ id: 2 }, [run])], { serverDateMs: T0 + 3000 })); // delta merge
    await loop.fetchEventsForPoll();
    fetchMock.mockResolvedValueOnce(result([], { etag: 'W/"quiet"' })); // quiet 200 = delta merge with 0 changes
    await loop.fetchEventsForPoll();
    fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"quiet"', serverDateMs: T0 + 9000 }); // 304
    await loop.fetchEventsForPoll();
    loop.lastFullFetchAt = Date.now() - 61_000; // force a resync full fetch
    fetchMock.mockResolvedValueOnce(result([ev({ id: 2 }, [run])]));
    await loop.fetchEventsForPoll();

    expect(loop.pollStatsSummary).toBe("pollit 4 (delta 2, täyshaku 2, 304 1, reset 0, hakuvirheitä 0)");
  });

  it("kirjaa myös tyhjät pollit ikkunayhteenvetoon (#120)", async () => {
    // Ottelussa 145900 (30.7.2026) selostus jäi 43 s jälkeen, eikä lokista
    // voinut päätellä ajettiinko pollit lainkaan: api.delta_fetch lokitetaan
    // vain kun uutta löytyy, joten hiljainen jakso oli täysin näkymätön.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop();
      fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
      await loop.fetchFullEvents();

      // Kolme pollia joissa EI tapahdu mitään: kaksi 304:ää ja yksi tyhjä 200.
      fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"q"', serverDateMs: T0 });
      await loop.fetchEventsForPoll();
      fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])], { etag: 'W/"q"' }));
      await loop.fetchEventsForPoll();
      fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"q"', serverDateMs: T0 });
      await loop.fetchEventsForPoll();

      // Ikkuna umpeutuu.
      loop.lastPollSummaryAtMs = Date.now() - 21_000;
      loop.maybeLogPollWindow();

      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Pollit");
      expect(logged).toMatch(/3 kpl/);
      expect(logged).toMatch(/304 2/);
      // Juuri tämä erottaa "pollit eivät ajaneet" tilanteesta "pollit ajoivat
      // ja API vastasi vanhaa" — se kysymys jäi 145900:ssa auki.
      expect(logged).toMatch(/viimeisin vastaus 1 tapahtumaa/);
      expect(logged).toMatch(/0 uutta tapahtumaa/);
      expect(logged).toContain("kursori");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("ei kirjaa yhteenvetoa ilman polleja eikä ennen ikkunan umpeutumista (#120)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop();
      // Ei polleja: hiljaisuus on oikea vastaus, ei rivi joka sanoo "0 pollia".
      loop.lastPollSummaryAtMs = Date.now() - 60_000;
      loop.maybeLogPollWindow();
      expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("Pollit");

      // Polleja on, mutta ikkuna ei ole vielä täynnä.
      fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
      await loop.fetchFullEvents();
      fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"q"', serverDateMs: T0 });
      await loop.fetchEventsForPoll();
      loop.lastPollSummaryAtMs = Date.now();
      loop.maybeLogPollWindow();
      expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("Pollit");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("RELAY_POLL_TRACE antaa rivin per polli, oletuksena ei (#120)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const quiet = makeLoop();
      fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
      await quiet.fetchFullEvents();
      fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"q"', serverDateMs: T0 });
      await quiet.fetchEventsForPoll();
      expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("Polli:");

      logSpy.mockClear();
      const traced = makeLoop({ pollTrace: true });
      fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
      await traced.fetchFullEvents();
      fetchMock.mockResolvedValueOnce({ events: [], notModified: true, etag: 'W/"q"', serverDateMs: T0 });
      await traced.fetchEventsForPoll();
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Polli: 304 (ei muutosta)");
      expect(logged).toContain("kursori");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs each failure with its duration and streak position, alarming only from the 3rd on", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop();
      const startedAt = Date.now() - 8000;
      loop.recordPollFailure(new Error("This operation was aborted"), startedAt);
      loop.recordPollFailure(new Error("This operation was aborted"), startedAt);
      expect(logSpy.mock.calls[0][0]).toMatch(/Hakuvirhe \(kesto 8\.\d s, 1\. peräkkäinen\): This operation was aborted/);
      expect(logSpy.mock.calls[1][0]).toContain("2. peräkkäinen");
      expect(logSpy.mock.calls[1][0]).not.toContain("HUOM");

      loop.recordPollFailure(new Error("This operation was aborted"), startedAt);
      expect(logSpy.mock.calls[2][0]).toMatch(/HUOM, hakuvirhesarja \(kesto 8\.\d s, 3\. peräkkäinen\)/);
      expect(loop.pollStatsSummary).toContain("hakuvirheitä 3");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("closes an alarming streak with an explicit all-clear line; short streaks reset silently", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop();
      const startedAt = Date.now();
      loop.recordPollFailure(new Error("x"), startedAt);
      loop.recordPollSuccess(); // streak of 1 → no all-clear noise
      expect(logSpy.mock.calls.filter((c) => String(c[0]).includes("onnistui jälleen"))).toHaveLength(0);

      for (let i = 0; i < 3; i++) loop.recordPollFailure(new Error("x"), startedAt);
      loop.recordPollSuccess();
      expect(logSpy.mock.calls.at(-1)![0]).toContain("Haku onnistui jälleen — 3 peräkkäistä hakuvirhettä takana.");

      // The streak reset: the next failure counts as the 1st again.
      loop.recordPollFailure(new Error("x"), startedAt);
      expect(logSpy.mock.calls.at(-1)![0]).toContain("1. peräkkäinen");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("CommentaryLoop match-start reset streak (issue #46 root cause)", () => {
  /** What every match looks like for the first AFTER_MARGIN_MS: `after`
   *  (server date − 180 s) predates the instant the scorer's match data was
   *  created, so the server answers every delta with that instant — and the
   *  complete history alongside it. Verified live 2026-07-28. */
  function mockStartOfMatchResets() {
    fetchMock.mockImplementation(async (_id, opts) => {
      const after = (opts as { after?: string } | undefined)?.after;
      const events = [ev({ id: 1 }, [palo]), ev({ id: 2 }, [run])];
      return after ? result(events, { reset: RESET_AT_ISO }) : result(events);
    });
  }

  it("costs exactly one request per poll and never trips the breaker", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop();
      mockStartOfMatchResets();
      await loop.fetchFullEvents(); // seed history + server date so delta engages

      fetchMock.mockClear();
      for (let i = 0; i < 20; i++) await loop.fetchEventsForPoll();

      // Before the fix this was 2 requests per poll (delta + fallback full)
      // and the breaker turned delta off after 5 of them.
      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(loop.deltaFetch).toBe(true);
      expect(loop.history.events.map((e) => e.id)).toEqual([1, 2]);
      expect(loop.pollStatsSummary).toContain("reset 20");
      expect(loop.pollStatsSummary).not.toContain("katkaisija");

      // One line for the whole streak, not one per poll.
      const resetLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("reset-leiman"));
      expect(resetLines).toHaveLength(1);
      expect(resetLines[0]).toContain(RESET_AT_ISO);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs a fresh line once the streak has been broken by a healthy delta", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop();
      mockStartOfMatchResets();
      await loop.fetchFullEvents();
      await loop.fetchEventsForPoll();
      await loop.fetchEventsForPoll();

      fetchMock.mockResolvedValueOnce(result([ev({ id: 3 }, [run])], { serverDateMs: T0 + 3000 }));
      await loop.fetchEventsForPoll(); // healthy delta clears the streak
      mockStartOfMatchResets();
      await loop.fetchEventsForPoll();

      const resetLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("reset-leiman"));
      expect(resetLines).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("CommentaryLoop delta reset breaker (observed live 27.7.)", () => {
  /** Every delta resets for a reason our own `after` does NOT explain: the
   *  reset instant is OLDER than what we asked for. Full fetches (no `after`)
   *  answer normally. */
  const UNEXPLAINED_RESET_ISO = new Date(T0 - 600 * 1000).toISOString();
  function mockAlwaysResetting() {
    fetchMock.mockImplementation(async (_id, opts) => {
      const after = (opts as { after?: string } | undefined)?.after;
      const events = [ev({ id: 1 }, [palo]), ev({ id: 2 }, [run])];
      return after ? result(events, { reset: UNEXPLAINED_RESET_ISO }) : result(events);
    });
  }

  it("turns delta off for the run after 5 consecutive unexplained resets and says so once", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop();
      mockAlwaysResetting();
      await loop.fetchFullEvents(); // seed history + server date so delta engages

      for (let i = 0; i < 4; i++) await loop.fetchEventsForPoll();
      expect(loop.deltaFetch).toBe(true); // 4 in a row is not yet enough

      await loop.fetchEventsForPoll(); // the 5th trips it
      expect(loop.deltaFetch).toBe(false);
      const huom = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("HUOM: delta-haku"));
      expect(huom).toHaveLength(1);
      expect(huom[0]).toContain("5 kertaa peräkkäin");

      // From here on the poll is a plain full fetch — no second delta request,
      // and no further reset lines however long the run continues.
      fetchMock.mockClear();
      await loop.fetchEventsForPoll();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0][1] as { after?: string }).after).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps delta on when resets are interrupted by a delta that actually merges", async () => {
    const loop = makeLoop();
    mockAlwaysResetting();
    await loop.fetchFullEvents();

    for (let i = 0; i < 4; i++) await loop.fetchEventsForPoll();
    // One healthy delta clears the streak…
    fetchMock.mockResolvedValueOnce(result([ev({ id: 3 }, [run])], { serverDateMs: T0 + 3000 }));
    await loop.fetchEventsForPoll();
    // …so four more resets still don't reach the threshold.
    mockAlwaysResetting();
    for (let i = 0; i < 4; i++) await loop.fetchEventsForPoll();
    expect(loop.deltaFetch).toBe(true);
  });

  it("reports the tripped breaker on every later heartbeat, and a manual re-enable clears it", async () => {
    const controlFile = "/tmp/pesis-test-control-breaker.json";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = makeLoop({ controlFile });
      mockAlwaysResetting();
      await loop.fetchFullEvents();
      for (let i = 0; i < 5; i++) await loop.fetchEventsForPoll();

      expect(loop.pollStatsSummary).toContain("delta POIS (katkaisija)");

      writeFileSync(controlFile, JSON.stringify({ deltaFetch: true }));
      await loop.refreshRuntimeControls();
      expect(loop.deltaFetch).toBe(true);
      expect(loop.pollStatsSummary).not.toContain("katkaisija");

      // The streak restarted: 4 more resets are tolerated again.
      for (let i = 0; i < 4; i++) await loop.fetchEventsForPoll();
      expect(loop.deltaFetch).toBe(true);
    } finally {
      logSpy.mockRestore();
      rmSync(controlFile, { force: true });
    }
  });
});

describe("CommentaryLoop runtime controls: deltaFetch + pollIntervalMs", () => {
  const controlFile = "/tmp/pesis-test-control-runtime.json";
  afterEach(() => rmSync(controlFile, { force: true }));

  it("flips deltaFetch and pollIntervalMs live from the control file", async () => {
    const loop = makeLoop({ controlFile });
    expect(loop.deltaFetch).toBe(true);
    expect(loop.pollIntervalMs).toBe(3000);

    writeFileSync(controlFile, JSON.stringify({ deltaFetch: false, pollIntervalMs: 5000 }));
    await loop.refreshRuntimeControls();
    expect(loop.deltaFetch).toBe(false);
    expect(loop.pollIntervalMs).toBe(5000);

    writeFileSync(controlFile, JSON.stringify({ deltaFetch: true }));
    await loop.refreshRuntimeControls();
    expect(loop.deltaFetch).toBe(true);
    expect(loop.pollIntervalMs).toBe(5000); // omitted key leaves the setting alone
  });

  /** #206: käynnistys kirjoitti control-tiedoston kokonaan yli omasta
   *  configistaan. Sääntö oli järkevä kun tiedosto oli varapolku; nyt se on
   *  ohjaamon ainoa ottelunaikainen ohjauskanava ja relayn uudelleenkäynnistys
   *  on odotettu tapahtuma. Operaattori kalibroi viiveen korvakuulolta
   *  4000 → 6000 ms, relay käynnistyi uudelleen, ja arvo palasi oletukseen
   *  ilman että mikään sanoi mitään. */
  it("säilyttää operaattorin ajonaikaiset säädöt käynnistyksessä", () => {
    writeFileSync(
      controlFile,
      JSON.stringify({ narrationDelayMs: 6000, announceBatterChanges: false, pollIntervalMs: 5000 }),
    );
    const loop = makeLoop({ controlFile, narrationDelayMs: 4000, announceBatterChanges: true });
    expect(loop.narrationDelayMs, "config on vielä voimassa ennen käynnistystä").toBe(4000);

    loop.writeControlFile();

    expect(loop.narrationDelayMs).toBe(6000);
    expect(loop.announceBatterChanges).toBe(false);
    expect(loop.pollIntervalMs).toBe(5000);
    // Ja tiedostoon jää se mitä käytetään, ei se mitä config sanoi.
    expect(JSON.parse(readFileSync(controlFile, "utf8"))).toMatchObject({
      narrationDelayMs: 6000,
      announceBatterChanges: false,
      pollIntervalMs: 5000,
    });
  });

  it("säilyttää ohjaamon kirjoittamat vieraat avaimet", () => {
    // Ohjaamo kirjoittaa samaan tiedostoon lähteen tilahavainnon (#104).
    // Ylikirjoitus pyyhki senkin.
    writeFileSync(controlFile, JSON.stringify({ sourceIngest: { state: "live", at: "2026-08-05T10:00:00.000Z" } }));
    const loop = makeLoop({ controlFile });

    loop.writeControlFile();

    expect(JSON.parse(readFileSync(controlFile, "utf8")).sourceIngest).toEqual({
      state: "live",
      at: "2026-08-05T10:00:00.000Z",
    });
  });

  it("kirjoittaa configin arvot kun tiedostoa ei ole", () => {
    rmSync(controlFile, { force: true });
    const loop = makeLoop({ controlFile, narrationDelayMs: 4000 });

    loop.writeControlFile();

    expect(JSON.parse(readFileSync(controlFile, "utf8"))).toMatchObject({ narrationDelayMs: 4000 });
  });

  it("clamps pollIntervalMs to the 2000 ms floor", async () => {
    const loop = makeLoop({ controlFile });
    writeFileSync(controlFile, JSON.stringify({ pollIntervalMs: 500 }));
    await loop.refreshRuntimeControls();
    expect(loop.pollIntervalMs).toBe(2000);
  });
});

/** Issue #47: the 4 s constant aborted healthy full fetches once the match
 *  history had grown (observed live: 12 aborts in 2 min, all cut at 4.0 s).
 *  Issue #81: that patience belongs to the full fetch only — the delta poll
 *  runs every cycle and is what decides how fast a hung API is noticed. */
describe("API fetch timeout", () => {
  const timeoutOf = (call: number) => (fetchMock.mock.calls[call][1] as { timeoutMs?: number }).timeoutMs;

  /** Seeds history + server date so the next poll actually goes delta. */
  async function seeded(overrides: Partial<RelayConfig> = {}) {
    const loop = makeLoop(overrides);
    fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
    await loop.fetchFullEvents();
    return loop;
  }

  it("is 10 s for the full fetch, not the old 4 s", async () => {
    await seeded();
    expect(timeoutOf(0)).toBe(10_000);
  });

  it("is a shorter 4 s for the delta poll — the two are not the same value", async () => {
    const loop = await seeded();
    fetchMock.mockResolvedValueOnce(result([ev({ id: 2 }, [run])], { serverDateMs: T0 + 3000 }));
    await loop.fetchEventsForPoll();
    expect(timeoutOf(1)).toBe(4_000);
    expect(timeoutOf(1)).not.toBe(timeoutOf(0));
  });

  it("is never shorter than the poll interval, however slow the cadence is set", async () => {
    await seeded({ pollInterval: 15000 });
    expect(timeoutOf(0)).toBe(15000);
  });

  it("lifts the delta timeout with the cadence when the control file raises it live", async () => {
    const controlFile = "/tmp/pesis-test-control-timeout.json";
    try {
      const loop = await seeded({ controlFile });
      writeFileSync(controlFile, JSON.stringify({ pollIntervalMs: 6000 }));
      await loop.refreshRuntimeControls();

      fetchMock.mockResolvedValueOnce(result([ev({ id: 2 }, [run])], { serverDateMs: T0 + 3000 }));
      await loop.fetchEventsForPoll();
      expect(timeoutOf(1)).toBe(6000); // floor wins over the 4 s base…

      fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
      await loop.fetchFullEvents();
      expect(timeoutOf(2)).toBe(10_000); // …but the full fetch is still longer
    } finally {
      rmSync(controlFile, { force: true });
    }
  });

  it("gives the full-fetch value to a refetch forced by a shrinking reset answer", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = await seeded();
      fetchMock.mockResolvedValueOnce(result([], { reset: RESET_AT_ISO })); // fewer events than we hold
      fetchMock.mockResolvedValueOnce(result([ev({ id: 1 }, [palo])]));
      await loop.fetchEventsForPoll();

      expect(timeoutOf(1)).toBe(4_000); // the delta that got the reset
      expect(timeoutOf(2)).toBe(10_000); // the full refetch it forced
    } finally {
      logSpy.mockRestore();
    }
  });
});
