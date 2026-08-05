// The notification trigger logic (apps/control/src/server/notifications.ts) is
// a state machine over LiveState edges, and its whole value is what it does
// NOT send: the live aggregator publishes every 5 s, so a rule that fires on a
// condition instead of a transition would buzz the phone twelve times a minute
// until the operator stops reading notifications altogether. These tests pin
// the silence as tightly as the alerts.
//
// push.ts is mocked, so no test can reach a real push service — and, just as
// importantly, none can read the operator's real run/push-subscriptions.json
// and buzz an actual phone mid-development.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobCleanup, LiveState, MatchState, RelayProcess } from "../src/shared/types.js";
import { jobStateWord } from "../src/shared/jobState.js";

const sendPush = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/server/push.js", () => ({ sendPush }));

type Notifications = typeof import("../src/server/notifications.js");

let tmpDir: string;
let notifications: Notifications;

beforeEach(async () => {
  // notifications.ts builds its prefs store at module load, capturing
  // CONFIG.stateDir at that moment — so the registry is reset, config is
  // redirected, and only THEN is notifications imported. The config import
  // must be dynamic and come after the reset: a static top-level import would
  // hand back a different module instance than the one the fresh
  // notifications.js sees, and the tests would quietly write their state into
  // the operator's real apps/control/run/.
  tmpDir = mkdtempSync(join(tmpdir(), "pesis-control-notif-"));
  vi.resetModules();
  const { CONFIG } = await import("../src/server/config.js");
  CONFIG.stateDir = tmpDir;
  sendPush.mockClear();
  notifications = await import("../src/server/notifications.js");
  notifications.resetNotificationState();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Titles only: the bodies are Finnish prose that should be free to improve
 *  without rewriting the tests. */
function titles(): string[] {
  return sendPush.mock.calls.map((call) => (call as unknown as string[])[0]);
}

function baseRelay(overrides: Partial<RelayProcess> = {}): RelayProcess {
  return { activeState: "active", active: true, uptimeSec: 60, deployedCommit: null, nRestarts: 0, ...overrides };
}

function baseMatch(overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: 1,
    home: "Koti",
    away: "Vieras",
    periodScores: [],
    totalHome: 0,
    totalAway: 0,
    periodsWonHome: 0,
    periodsWonAway: 0,
    currentPeriod: 0,
    palot: 0,
    battingTeam: null,
    finished: false,
    eventCount: 10,
    lastEventAt: null,
    ...overrides,
  };
}

function baseJob(): Job {
  return {
    id: "job1",
    status: "live",
    createdAt: "2026-07-28T10:00:00.000Z",
    matchId: 1,
    home: "Koti",
    away: "Vieras",
    seriesName: null,
    stadium: null,
    startsAt: null,
    sourceUrl: "https://example.invalid/live",
    targetStreamKey: "avain",
    targetRtmpUrl: "rtmp://example.invalid/live2",
    targetVideoId: null,
    armedAt: null,
    startedAt: null,
    endedAt: null,
    cleanup: null,
    note: null,
  };
}

/** A LiveState is a big object and only four of its fields drive this module;
 *  everything else is filled with something plausible and ignored. */
function state(overrides: {
  at: string;
  health?: LiveState["health"];
  relayActive?: boolean;
  matchFinished?: boolean;
  job?: Job | null;
}): LiveState {
  return {
    now: overrides.at,
    health: overrides.health ?? "ok",
    headline: "otsikko",
    chain: [],
    relay: baseRelay({ active: overrides.relayActive ?? true }),
    match: baseMatch({ finished: overrides.matchFinished ?? false }),
    system: {
      diskFreeBytes: 10 * 1024 ** 3,
      diskTotalBytes: 30 * 1024 ** 3,
      diskCritical: false,
      memFreeBytes: 1024 ** 3,
      memTotalBytes: 4 * 1024 ** 3,
      load1: 0.5,
      cpuCount: 4,
    },
    knobs: null,
    job: overrides.job === undefined ? baseJob() : overrides.job,
    telemetry: null,
    narration: [],
    log: [],
  };
}

/** Wall clock helper: `at(seconds)` from a fixed match-day origin. */
const ORIGIN = Date.parse("2026-07-28T12:00:00.000Z");
function at(seconds: number): string {
  return new Date(ORIGIN + seconds * 1000).toISOString();
}

describe("relay lifecycle triggers", () => {
  it("says nothing about the first observation, so a control-server restart mid-broadcast is not a 'start'", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: true }));
    expect(titles()).toEqual([]);
  });

  it("announces the start once on the false -> true edge, not on every poll after it", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: false, health: "idle" }));
    await notifications.observeLiveState(state({ at: at(5), relayActive: true }));
    await notifications.observeLiveState(state({ at: at(10), relayActive: true }));
    await notifications.observeLiveState(state({ at: at(15), relayActive: true }));
    expect(titles()).toEqual(["Lähetys käynnistyi"]);
  });

  it("vaikenee normaalista lopetuksesta: päättymispush odottaa siivousta (#187)", async () => {
    // Relayn sammuminen päättyneen ottelun jälkeen ON odotettu lopetus, mutta
    // lähetykset ovat sillä sekunnilla vielä auki. Tästä reunasta ei siis
    // piipata lainkaan — päivän kolmas push lähtee vasta siivouksen kirjauksesta.
    await notifications.observeLiveState(state({ at: at(0), relayActive: true, matchFinished: true }));
    await notifications.observeLiveState(
      state({ at: at(5), relayActive: false, matchFinished: true, health: "idle" })
    );
    expect(titles()).toEqual([]);
  });

  it("ilmoittaa kesken ottelun katkenneesta selostuksesta", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: true }));
    await notifications.observeLiveState(state({ at: at(5), relayActive: false, health: "warn" }));
    expect(titles()).toEqual(["Lähetys katkesi"]);
  });

  it("does not report an ending for a relay that was never running a job", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: true, job: null, health: "warn" }));
    await notifications.observeLiveState(state({ at: at(5), relayActive: false, job: null, health: "idle" }));
    expect(titles()).toEqual([]);
  });
});

describe("työn tilasiirtymät (#185)", () => {
  const draft = (): Job => ({ ...baseJob(), status: "draft" });
  const scheduled = (): Job => ({ ...baseJob(), status: "scheduled" });

  it("ilmoittaa lähetysparista kun työ siirtyy valmisteluun valmiiksi — kortin omalla otsikolla", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: false, health: "idle", job: draft() }));
    await notifications.observeLiveState(
      state({ at: at(5), relayActive: false, health: "idle", job: scheduled() })
    );
    // Sama teksti kuin tilakortin otsikossa: yksi sanamuotolähde (#174).
    expect(titles()).toEqual([jobStateWord("scheduled").word]);
  });

  it("ei ilmoita mitään ensimmäisestä havainnosta — ohjaamon uudelleenkäynnistys ei ole uusi lähetyspari", async () => {
    await notifications.observeLiveState(
      state({ at: at(0), relayActive: false, health: "idle", job: scheduled() })
    );
    await notifications.observeLiveState(
      state({ at: at(5), relayActive: false, health: "idle", job: scheduled() })
    );
    expect(titles()).toEqual([]);
  });

  it("ei toista samaa tilaa joka pollilla", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: false, health: "idle", job: draft() }));
    for (const sec of [5, 10, 15, 20]) {
      await notifications.observeLiveState(
        state({ at: at(sec), relayActive: false, health: "idle", job: scheduled() })
      );
    }
    expect(titles()).toEqual([jobStateWord("scheduled").word]);
  });

  it("käynnistys piippaa kerran, vaikka relayn ja työn reunat osuvat eri pollille", async () => {
    // Ajastimen ajossa relay käynnistetään ennen kuin työ leimataan käyntiin,
    // joten kaksi reunaa kertoo yhdestä tapahtumasta. Yksi yhteinen tagi pitää
    // puhelimen piippaukset yhdessä.
    await notifications.observeLiveState(
      state({ at: at(0), relayActive: false, health: "idle", job: scheduled() })
    );
    await notifications.observeLiveState(
      state({ at: at(5), relayActive: true, job: { ...baseJob(), status: "arming" } })
    );
    await notifications.observeLiveState(state({ at: at(10), relayActive: true, job: baseJob() }));
    expect(titles()).toEqual(["Lähetys käynnistyi"]);
  });

  it("ei ilmoita luonnoksesta eikä perumisesta — ne ovat operaattorin omia tekoja", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: false, health: "idle", job: null }));
    await notifications.observeLiveState(state({ at: at(5), relayActive: false, health: "idle", job: draft() }));
    await notifications.observeLiveState(
      state({ at: at(10), relayActive: false, health: "idle", job: { ...baseJob(), status: "cancelled" } })
    );
    expect(titles()).toEqual([]);
  });
});

describe("päättymispush (#187)", () => {
  const finished = (): Job => ({ ...baseJob(), status: "finished", endedAt: at(300) });
  const cleaned = (overrides: Partial<JobCleanup> = {}): Job => ({
    ...finished(),
    cleanup: {
      at: at(305),
      indicators: ["Tulospalvelu kirjasi ottelun päättyneeksi."],
      actions: [],
      ...overrides,
    },
  });

  it("lähtee vasta kun siivous on kirjattu, ei siitä että työ sulkeutui", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: true, matchFinished: true }));
    // Työ suljettiin: lähetykset voivat olla vielä auki, joten hiljaisuus.
    await notifications.observeLiveState(
      state({ at: at(5), relayActive: false, matchFinished: true, health: "idle", job: finished() })
    );
    expect(titles()).toEqual([]);
    // Siivous kirjattiin: nyt lupaus on katettu.
    await notifications.observeLiveState(
      state({ at: at(10), relayActive: false, matchFinished: true, health: "idle", job: cleaned() })
    );
    expect(titles()).toEqual([jobStateWord("finished").word]);
  });

  it("ei toistu joka pollilla eikä ohjaamon uudelleenkäynnistyksestä", async () => {
    await notifications.observeLiveState(
      state({ at: at(0), relayActive: false, matchFinished: true, health: "idle", job: finished() })
    );
    for (const sec of [5, 10, 15]) {
      await notifications.observeLiveState(
        state({ at: at(sec), relayActive: false, matchFinished: true, health: "idle", job: cleaned() })
      );
    }
    expect(titles()).toEqual([jobStateWord("finished").word]);

    // Uudelleenkäynnistys: eilen päättyneen ottelun siivousmerkintä on
    // ensimmäinen havainto, eikä ensimmäinen havainto ole koskaan uutinen.
    notifications.resetNotificationState();
    await notifications.observeLiveState(
      state({ at: at(600), relayActive: false, matchFinished: true, health: "idle", job: cleaned() })
    );
    expect(titles()).toEqual([jobStateWord("finished").word]);
  });

  it("nostaa auki jääneen lähetyksen leipätekstiin, koska se on ainoa jäljellä oleva teko", async () => {
    const stuck = cleaned({
      actions: [
        { what: "Selostettu lähetys ei sulkeutunut.", ok: false, detail: "Sulje selostettu lähetys YouTubessa itse." },
      ],
    });
    await notifications.observeLiveState(
      state({ at: at(0), relayActive: false, matchFinished: true, health: "idle", job: finished() })
    );
    await notifications.observeLiveState(
      state({ at: at(5), relayActive: false, matchFinished: true, health: "idle", job: stuck })
    );
    const bodies = sendPush.mock.calls.map((call) => (call as unknown as string[])[1]);
    expect(titles()).toEqual([jobStateWord("finished").word]);
    expect(bodies[0]).toContain("Sulje selostettu lähetys YouTubessa itse.");
  });
});

describe("broken-broadcast trigger", () => {
  it("stays quiet about a failure that heals inside the confirmation window", async () => {
    await notifications.observeLiveState(state({ at: at(0), health: "ok" }));
    await notifications.observeLiveState(state({ at: at(5), health: "fail" }));
    await notifications.observeLiveState(state({ at: at(30), health: "fail" }));
    await notifications.observeLiveState(state({ at: at(40), health: "ok" }));
    expect(titles()).toEqual([]);
  });

  it("announces a failure that persists, exactly once, and then its recovery", async () => {
    await notifications.observeLiveState(state({ at: at(0), health: "ok" }));
    await notifications.observeLiveState(state({ at: at(5), health: "fail" }));
    await notifications.observeLiveState(state({ at: at(60), health: "fail" }));
    expect(titles()).toEqual([]); // 55 s of failure is not yet 60

    await notifications.observeLiveState(state({ at: at(65), health: "fail" }));
    await notifications.observeLiveState(state({ at: at(70), health: "fail" }));
    await notifications.observeLiveState(state({ at: at(75), health: "fail" }));
    expect(titles()).toEqual(["Lähetys rikki"]);

    await notifications.observeLiveState(state({ at: at(80), health: "ok" }));
    expect(titles()).toEqual(["Lähetys rikki", "Lähetys taas kunnossa"]);
  });

  it("reports a mid-match stop once, not again a minute later as a separate failure", async () => {
    await notifications.observeLiveState(state({ at: at(0), relayActive: true, health: "ok" }));
    await notifications.observeLiveState(state({ at: at(5), relayActive: false, health: "fail" }));
    for (let t = 10; t <= 120; t += 5) {
      await notifications.observeLiveState(state({ at: at(t), relayActive: false, health: "fail" }));
    }
    expect(titles()).toEqual(["Lähetys katkesi"]);
  });
});

describe("preferences", () => {
  it("silences a trigger the operator switched off", async () => {
    await notifications.setNotificationPrefs({ startup: false });
    await notifications.observeLiveState(state({ at: at(0), relayActive: false, health: "idle" }));
    await notifications.observeLiveState(state({ at: at(5), relayActive: true }));
    expect(titles()).toEqual([]);
  });

  it("treats a preferences file missing a key as 'on' rather than silently disabled", async () => {
    await notifications.setNotificationPrefs({ ended: false });
    await expect(notifications.getNotificationPrefs()).resolves.toEqual({
      broken: true,
      autoFix: true,
      startup: true,
      ended: false,
    });
  });
});

describe("repeat suppression", () => {
  it("sends the same tag at most once per window even when the state machine flaps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ORIGIN);
    for (let cycle = 0; cycle < 4; cycle++) {
      const base = cycle * 20;
      await notifications.observeLiveState(state({ at: at(base), relayActive: false, health: "idle" }));
      await notifications.observeLiveState(state({ at: at(base + 5), relayActive: true }));
      vi.setSystemTime(ORIGIN + (base + 10) * 1000);
    }
    // Four full stop/start cycles inside the window produce two notifications
    // in total — one per subject — instead of eight.
    expect(titles()).toEqual(["Lähetys käynnistyi", "Lähetys katkesi"]);
  });
});

describe("auto-fix interface", () => {
  it("reports each distinct repair, since two different fixes are two different facts", async () => {
    await notifications.notifyAutoFix("Relay käynnistettiin uudelleen", "prosessi oli kuollut");
    await notifications.notifyAutoFix("Delta-haku pois päältä", "tapahtumia katosi");
    expect(titles()).toEqual(["Automaattinen korjaus", "Automaattinen korjaus"]);
  });
});
