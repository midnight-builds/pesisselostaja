// The scheduler is the only part of the control app that starts a broadcast
// without a human touching anything, so these tests are mostly about what it
// REFUSES to do. The safety property that matters most is the first describe
// block: with the switch off, not one write may happen — no .env.relay, no
// systemctl, no job status change — while the decision is still computed and
// reported, because that dry run is what earns the operator's trust before the
// switch is ever flipped.
//
// Two independent guards keep the real world out of this file:
//   1. apps/broadcast/src/preflight.ts (yt-dlp) and src/server/relay.js
//      (systemctl, .env.relay) are module-mocked, so even a mistake in the
//      wiring below cannot reach a subprocess.
//   2. Every scheduler under test is built with injected fakes, so nothing in
//      it ever calls the real modules in the first place.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Check } from "../../broadcast/src/preflight.js";
import type { Job, PreflightResult, SystemState } from "../src/shared/types.js";

// --- Guard 1: nothing in this process may run yt-dlp or systemctl. A failure
// here would be a real yt-dlp resolve against YouTube from a test run, or —
// far worse — a systemctl call at the live relay unit.
const realCheckSource = vi.hoisted(() =>
  vi.fn(async (): Promise<Check> => {
    throw new Error("yt-dlp ei saa ajaa testissä");
  })
);
vi.mock("../../broadcast/src/preflight.js", () => ({
  checkSource: realCheckSource,
  runPreflight: vi.fn(async () => {
    throw new Error("preflight ei saa ajaa testissä");
  }),
  summarize: vi.fn(() => ({ text: "", exitCode: 0 })),
}));
vi.mock("../src/server/relay.js", () => ({
  startRelay: vi.fn(async () => {
    throw new Error("systemctl ei saa ajaa testissä");
  }),
  stopRelay: vi.fn(async () => {
    throw new Error("systemctl ei saa ajaa testissä");
  }),
  restartRelay: vi.fn(async () => {
    throw new Error("systemctl ei saa ajaa testissä");
  }),
  writeRelayEnv: vi.fn(async () => {
    throw new Error(".env.relay ei saa kirjoittua testissä");
  }),
}));
// push.ts reaches a real push service AND reads the operator's real
// subscriptions; mocked so no test can buzz an actual phone.
vi.mock("../src/server/push.js", () => ({ sendPush: vi.fn(async () => undefined) }));

type Scheduler = typeof import("../src/server/scheduler.js");

let tmpDir: string;
let mod: Scheduler;

beforeEach(async () => {
  // scheduler.ts builds its store at module load, capturing CONFIG.stateDir at
  // that moment — reset the registry, redirect the config, and only then import
  // it, or the tests would write run/scheduler.json into the operator's real
  // state directory and could leave the live scheduler enabled.
  tmpDir = mkdtempSync(join(tmpdir(), "pesis-control-sched-"));
  vi.resetModules();
  const { CONFIG } = await import("../src/server/config.js");
  CONFIG.stateDir = tmpDir;
  mod = await import("../src/server/scheduler.js");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

const NOW = Date.parse("2026-07-29T05:30:00.000Z"); // 8:30 Suomen aikaa

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-a",
    status: "scheduled",
    createdAt: "2026-07-29T04:00:00.000Z",
    matchId: 146210,
    home: "Kotijoukkue",
    away: "Vierasjoukkue",
    seriesName: null,
    stadium: null,
    startsAt: "2026-07-29T05:30:00.000Z",
    sourceUrl: "https://example.invalid/live-a",
    targetStreamKey: "avain",
    targetRtmpUrl: "rtmp://example.invalid/live2",
    targetVideoId: null,
    startedAt: null,
    endedAt: null,
    note: null,
    ...overrides,
  };
}

/** Exactly the strings apps/broadcast/src/preflight.ts's checkSource produces —
 *  the scheduler reads its verdict off that wording, so these literals are the
 *  contract. */
const SOURCE = {
  liveFull: { name: "Lähde", status: "ok", detail: "livenä, HLS-manifesti (täysi laatu)" } as Check,
  liveDegraded: {
    name: "Lähde",
    status: "warn",
    detail: "livenä, mutta EI HLS-manifestia — kuva menisi heikkolaatuisena",
  } as Check,
  scheduled: {
    name: "Lähde",
    status: "ok",
    detail: "ei vielä livenä, ajastettu alkavaksi (~12 min) — relay odottaa",
  } as Check,
  scheduledFar: {
    name: "Lähde",
    status: "ok",
    detail: "ei vielä livenä, ajastettu alkavaksi (~95 min) — relay odottaa",
  } as Check,
  error: {
    name: "Lähde",
    status: "fail",
    detail: "ERROR: [youtube] Video unavailable",
  } as Check,
};

function system(overrides: Partial<SystemState> = {}): SystemState {
  return {
    diskFreeBytes: 12 * 1024 ** 3,
    diskTotalBytes: 30 * 1024 ** 3,
    diskCritical: false,
    memFreeBytes: 1024 ** 3,
    memTotalBytes: 4 * 1024 ** 3,
    load1: 0.4,
    cpuCount: 4,
    ...overrides,
  };
}

function preflight(blockers: number): PreflightResult {
  return {
    ranAt: new Date(NOW).toISOString(),
    checks: [],
    blockers,
    warnings: 0,
    summary: blockers ? `${blockers} estettä` : "Kaikki kunnossa",
  };
}

/** A scheduler wired entirely to spies. Anything the caller does not override
 *  gets a fake that records the call and succeeds. */
function build(opts: {
  jobs: Job[];
  source?: Check;
  system?: SystemState;
  preflight?: PreflightResult;
  startThrows?: Error;
}) {
  const calls = {
    checkSource: vi.fn(async () => opts.source ?? SOURCE.scheduled),
    writeRelayEnv: vi.fn(async () => undefined),
    runPreflight: vi.fn(async () => opts.preflight ?? preflight(0)),
    activateJob: vi.fn(async (id: string) => job({ id, status: "arming" })),
    setJobStatus: vi.fn(async (id: string, status: Job["status"]) => job({ id, status })),
    startRelay: vi.fn(async () => {
      if (opts.startThrows) throw opts.startThrows;
      return undefined;
    }),
    // Parametrit on kirjoitettu auki, jotta mock.calls[n][1] on tyypitetty ja
    // ilmoitusten otsikoita voi väittää ilman as-castia.
    notify: vi.fn(async (_tag: string, _title: string, _body: string) => true),
    listJobs: vi.fn(async () => opts.jobs),
    getSystemState: vi.fn(async () => opts.system ?? system()),
  };
  const scheduler = mod.createScheduler({ now: () => NOW, ...calls });
  return { scheduler, calls };
}

/** Every dep that changes something outside the process. If none of these fired,
 *  the tick was genuinely read-only. */
function writes(calls: ReturnType<typeof build>["calls"]) {
  return [
    ...calls.writeRelayEnv.mock.calls,
    ...calls.activateJob.mock.calls,
    ...calls.setJobStatus.mock.calls,
    ...calls.startRelay.mock.calls,
    ...calls.notify.mock.calls,
  ];
}

// ------------------------------------------------------------------- the tests

describe("ajastin pois päältä", () => {
  it("on oletuksena pois päältä, ilman että kukaan on tallentanut mitään", async () => {
    const { scheduler } = build({ jobs: [job()], source: SOURCE.liveFull });
    await expect(scheduler.getState()).resolves.toMatchObject({ enabled: false });
  });

  it("EI käynnistä relayta vaikka lähde on livenä — eikä kirjoita yhtään mitään", async () => {
    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.liveFull });

    const state = await scheduler.tick();

    expect(writes(calls)).toEqual([]);
    expect(state.lastAction).toBeNull();
  });

  it("kirjaa silti mitä olisi tehnyt, jotta logiikan voi todeta toimivaksi ennen kytkemistä", async () => {
    const { scheduler } = build({ jobs: [job()], source: SOURCE.liveFull });

    const state = await scheduler.tick();

    expect(state.wouldHaveDone).toMatchObject({
      decision: "start",
      jobId: "job-a",
      applied: false,
    });
    expect(state.wouldHaveDone?.reason).toContain("Ajastin on pois päältä");
    // Lähteen tila näkyy silti, koska sen lukeminen ei muuta mitään.
    expect(state.nextJob).toMatchObject({ id: "job-a", sourceState: "live" });
  });

  it("lukee kytkimen levyltä joka tarkistuksella, joten päälle jäänyt muistitila ei voi ohittaa sitä", async () => {
    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.liveFull });
    await scheduler.setEnabled(true);
    await scheduler.setEnabled(false);

    await scheduler.tick();

    expect(writes(calls)).toEqual([]);
  });

  it("ei aseille itseään merkkijonolla 'false' käsin muokatussa tiedostossa", async () => {
    const { CONFIG } = await import("../src/server/config.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(CONFIG.stateDir, "scheduler.json"), '{"enabled":"false"}');

    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.liveFull });
    const state = await scheduler.tick();

    expect(state.enabled).toBe(false);
    expect(writes(calls)).toEqual([]);
  });
});

describe("ajastin päällä", () => {
  it("käynnistää lähetyksen kun lähde on livenä, preflight puhdas eikä muuta ole ajossa", async () => {
    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.liveFull });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    // Järjestys on osa sopimusta: .env.relay ensin, koska preflight tarkistaa
    // juuri sen tiedoston — muuten portti tutkisi edellisen ottelun asetuksia.
    expect(calls.writeRelayEnv).toHaveBeenCalledWith(expect.objectContaining({ id: "job-a" }));
    expect(calls.runPreflight).toHaveBeenCalledOnce();
    expect(calls.activateJob).toHaveBeenCalledWith("job-a");
    expect(calls.startRelay).toHaveBeenCalledOnce();
    expect(calls.setJobStatus).toHaveBeenCalledWith("job-a", "live");
    expect(state.lastAction).toMatchObject({ decision: "start", applied: true });
  });

  it("ilmoittaa käynnistyksestä, koska kukaan ei katso ruutua sillä hetkellä", async () => {
    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.liveFull });
    await scheduler.setEnabled(true);

    await scheduler.tick();

    expect(calls.notify).toHaveBeenCalledOnce();
    expect(calls.notify.mock.calls[0][1]).toBe("Ajastin käynnisti lähetyksen");
  });

  it("käynnistää myös heikkolaatuisen lähteen — vajaa lähetys on parempi kuin ei lähetystä", async () => {
    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.liveDegraded });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(calls.startRelay).toHaveBeenCalledOnce();
    expect(state.lastAction?.reason).toContain("heikkolaatuisena");
  });
});

describe("portit", () => {
  it("preflightin este estää käynnistyksen ja tuottaa ilmoituksen", async () => {
    const { scheduler, calls } = build({
      jobs: [job()],
      source: SOURCE.liveFull,
      preflight: preflight(2),
    });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(calls.startRelay).not.toHaveBeenCalled();
    expect(calls.activateJob).not.toHaveBeenCalled();
    // Työ jää "scheduled"-tilaan: jono ei saa jäädä varatuksi työstä joka ei aja.
    expect(calls.setJobStatus).not.toHaveBeenCalled();
    expect(state.lastAction).toMatchObject({ decision: "blocked-preflight", applied: false });
    expect(calls.notify.mock.calls[0][1]).toBe("Ajastin: käynnistys estyi");
  });

  it("ei yritä samaa estettä uudelleen joka 30 sekunti", async () => {
    const { scheduler, calls } = build({
      jobs: [job()],
      source: SOURCE.liveFull,
      preflight: preflight(1),
    });
    await scheduler.setEnabled(true);

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(calls.runPreflight).toHaveBeenCalledOnce();
    // Eikä lähdettäkään enää kysellä turhaan takalukossa.
    expect(calls.checkSource).toHaveBeenCalledOnce();
  });

  it("kriittinen levytila estää kaiken — lähdettä ei edes selvitetä", async () => {
    const { scheduler, calls } = build({
      jobs: [job()],
      source: SOURCE.liveFull,
      system: system({ diskCritical: true, diskFreeBytes: 1024 ** 3 }),
    });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(calls.checkSource).not.toHaveBeenCalled();
    expect(calls.writeRelayEnv).not.toHaveBeenCalled();
    expect(calls.startRelay).not.toHaveBeenCalled();
    expect(state.lastAction).toMatchObject({ decision: "blocked-disk", applied: false });
  });

  it("jonossa oleva työ ei käynnisty toisen ollessa ajossa, eikä ajossa olevaan kosketa", async () => {
    const running = job({ id: "job-live", status: "live", home: "Aamu", away: "Ilta" });
    const queued = job({ id: "job-b", startsAt: "2026-07-29T08:00:00.000Z" });
    const { scheduler, calls } = build({ jobs: [running, queued], source: SOURCE.liveFull });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(calls.startRelay).not.toHaveBeenCalled();
    expect(calls.writeRelayEnv).not.toHaveBeenCalled();
    // Ajossa olevaa ei kosketa millään tavalla — ei statuksen kautta, ei muuten.
    expect(calls.setJobStatus).not.toHaveBeenCalled();
    expect(calls.activateJob).not.toHaveBeenCalled();
    expect(state.lastAction).toMatchObject({ decision: "blocked-busy", jobId: "job-b" });
    expect(calls.notify.mock.calls[0][1]).toBe("Ajastin: lähetys jonossa");
    expect(calls.notify.mock.calls[0][2]).toContain("Aamu – Ilta");
  });

  it("lähde ei vielä livenä: ei tehdä mitään eikä se ole virhe", async () => {
    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.scheduled });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(writes(calls)).toEqual([]);
    expect(state.lastAction).toMatchObject({ decision: "waiting", applied: false });
    expect(state.lastAction?.reason).toContain("12 min");
    expect(state.nextJob).toMatchObject({ sourceState: "scheduled" });
  });

  it("selvittämätön lähde ei kaada silmukkaa eikä hälytä", async () => {
    const { scheduler, calls } = build({ jobs: [job()], source: SOURCE.error });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(state.lastAction).toMatchObject({ decision: "source-error" });
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("kaatunut käynnistys palauttaa työn jonoon eikä jätä sitä varaamaan paikkaa", async () => {
    const { scheduler, calls } = build({
      jobs: [job()],
      source: SOURCE.liveFull,
      startThrows: new Error("Job for pesisselostaja-relay.service failed"),
    });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(calls.setJobStatus).toHaveBeenCalledWith("job-a", "scheduled");
    expect(state.lastAction).toMatchObject({ decision: "start-failed", applied: false });
  });
});

describe("ehdokkaan valinta", () => {
  it("ei kysele yt-dlp:ltä mitään kun jonossa ei ole töitä", async () => {
    const { scheduler, calls } = build({ jobs: [job({ status: "finished" })] });
    await scheduler.setEnabled(true);

    const state = await scheduler.tick();

    expect(calls.checkSource).not.toHaveBeenCalled();
    expect(state.lastAction).toMatchObject({ decision: "idle" });
    expect(state.nextJob).toBeNull();
  });

  it("jättää keskeneräisen luonnoksen rauhaan", () => {
    expect(mod.pickCandidate([job({ status: "draft" })])).toBeNull();
  });

  it("jättää työn jolla ei ole lähde-URLia", () => {
    expect(mod.pickCandidate([job({ sourceUrl: null })])).toBeNull();
  });

  it("valitsee aikaisimmin alkavan", () => {
    const late = job({ id: "late", startsAt: "2026-07-29T12:00:00.000Z" });
    const early = job({ id: "early", startsAt: "2026-07-29T09:00:00.000Z" });
    expect(mod.pickCandidate([late, early])?.id).toBe("early");
  });
});

describe("lähteen tilan tulkinta", () => {
  it("tunnistaa livenä olevan HLS-lähteen", () => {
    expect(mod.classifySource(SOURCE.liveFull)).toEqual({
      state: "live",
      quality: "full",
      detail: SOURCE.liveFull.detail,
    });
  });

  it("tunnistaa heikkolaatuisen mutta livenä olevan lähteen", () => {
    expect(mod.classifySource(SOURCE.liveDegraded)).toMatchObject({
      state: "live",
      quality: "degraded",
    });
  });

  it("ei lue 'ei vielä livenä' liveksi, vaikka lause sisältää sanan 'livenä'", () => {
    expect(mod.classifySource(SOURCE.scheduled)).toMatchObject({
      state: "scheduled",
      startsInMs: 12 * 60_000,
    });
  });

  it("kestää ajastetun lähteen ilman aika-arviota", () => {
    expect(
      mod.classifySource({
        name: "Lähde",
        status: "ok",
        detail: "ei vielä livenä, ajastettu alkavaksi — relay odottaa",
      })
    ).toMatchObject({ state: "scheduled", startsInMs: null });
  });

  it("tulkitsee yt-dlp:n virheen virheeksi", () => {
    expect(mod.classifySource(SOURCE.error)).toMatchObject({ state: "error" });
  });
});

describe("pollausväli", () => {
  it("on harva kun jonossa ei ole mitään", () => {
    expect(mod.pollIntervalMs({ now: NOW, hasCandidate: false, startsAt: null })).toBe(5 * 60_000);
  });

  it("on harva kun alkuun on yli varttitunti", () => {
    const startsAt = new Date(NOW + 60 * 60_000).toISOString();
    expect(mod.pollIntervalMs({ now: NOW, hasCandidate: true, startsAt })).toBe(5 * 60_000);
  });

  it("tihenee kun alkuaika lähestyy", () => {
    const far = new Date(NOW + 20 * 60_000).toISOString();
    const near = new Date(NOW + 10 * 60_000).toISOString();
    expect(mod.pollIntervalMs({ now: NOW, hasCandidate: true, startsAt: far })).toBe(5 * 60_000);
    expect(mod.pollIntervalMs({ now: NOW, hasCandidate: true, startsAt: near })).toBe(30_000);
  });

  it("pysyy tiheänä hetken alkuajan jälkeen, koska lähde tulee usein myöhässä", () => {
    const started = new Date(NOW - 25 * 60_000).toISOString();
    expect(mod.pollIntervalMs({ now: NOW, hasCandidate: true, startsAt: started })).toBe(30_000);
  });

  it("palaa harvaan kun työ on roikkunut tunteja alkuaikansa yli", () => {
    const abandoned = new Date(NOW - 3 * 60 * 60_000).toISOString();
    expect(mod.pollIntervalMs({ now: NOW, hasCandidate: true, startsAt: abandoned })).toBe(5 * 60_000);
  });

  it("uskoo YouTuben omaa aika-arviota enemmän kuin työn kellonaikaa", () => {
    const far = new Date(NOW + 60 * 60_000).toISOString();
    expect(
      mod.pollIntervalMs({ now: NOW, hasCandidate: true, startsAt: far, sourceStartsInMs: 5 * 60_000 })
    ).toBe(30_000);
  });

  it("tihenee oikeasti silmukassa kun lähde ilmoittaa alkavansa pian", async () => {
    const startsAt = new Date(NOW + 3 * 60 * 60_000).toISOString();
    const soon = build({ jobs: [job({ startsAt })], source: SOURCE.scheduled });
    const later = build({ jobs: [job({ startsAt })], source: SOURCE.scheduledFar });

    expect((await soon.scheduler.tick()).nextCheckInMs).toBe(30_000);
    expect((await later.scheduler.tick()).nextCheckInMs).toBe(5 * 60_000);
  });
});

describe("kytkin", () => {
  it("tallentaa tilan levylle, jotta se säilyy palvelun uudelleenkäynnistyksen yli", async () => {
    const first = build({ jobs: [job()], source: SOURCE.scheduled });
    await first.scheduler.setEnabled(true);

    const second = build({ jobs: [job()], source: SOURCE.scheduled });
    await expect(second.scheduler.getState()).resolves.toMatchObject({ enabled: true });
  });

  it("pois kytkeminen ei pysäytä mitään — se vain lopettaa uudet toimet", async () => {
    const { scheduler, calls } = build({ jobs: [job({ status: "live" })], source: SOURCE.liveFull });
    await scheduler.setEnabled(true);
    await scheduler.setEnabled(false);
    await scheduler.tick();

    expect(writes(calls)).toEqual([]);
  });
});
