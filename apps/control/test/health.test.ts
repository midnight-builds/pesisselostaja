// deriveHealth is the priority-ordered rule table behind the one headline the
// operator reads standing in a field (apps/control/src/server/live.ts). Order
// IS the policy — rule 1 (disk) must win over every other rule, a job that
// claims "live" while the unit is down must never read as merely a warning,
// etc. deriveHealth and its Snapshot type are marked `export` in live.ts
// purely so this file can call them directly; no logic was touched.
import { describe, expect, it } from "vitest";
import { buildChain, deriveHealth, type Snapshot } from "../src/server/live.js";
import { SOURCE_INGEST_STALE_MS } from "../src/server/sourceIngest.js";
import type {
  Job,
  LogLine,
  MatchState,
  RelayProcess,
  SourceIngest,
  SystemState,
} from "../src/shared/types.js";

function baseRelay(overrides: Partial<RelayProcess> = {}): RelayProcess {
  return {
    activeState: "active",
    active: true,
    uptimeSec: 120,
    deployedCommit: "abcdef1",
    nRestarts: 0,
    ...overrides,
  };
}

function baseMatch(overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: 1,
    home: "Koti",
    away: "Vieras",
    periodScores: [{ home: 1, away: 0 }],
    totalHome: 1,
    totalAway: 0,
    periodsWonHome: 0,
    periodsWonAway: 0,
    currentPeriod: 0,
    palot: 1,
    battingTeam: "Koti",
    finished: false,
    eventCount: 5,
    lastEventAt: new Date().toISOString(),
    ...overrides,
  };
}

function baseSystem(overrides: Partial<SystemState> = {}): SystemState {
  return {
    diskFreeBytes: 10 * 1024 ** 3,
    diskTotalBytes: 30 * 1024 ** 3,
    diskCritical: false,
    memFreeBytes: 1024 ** 3,
    memTotalBytes: 4 * 1024 ** 3,
    load1: 0.5,
    cpuCount: 4,
    ...overrides,
  };
}

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job1",
    status: "live",
    createdAt: new Date().toISOString(),
    matchId: 1,
    home: "Koti",
    away: "Vieras",
    seriesName: null,
    stadium: null,
    startsAt: null,
    sourceUrl: "https://youtube.com/x",
    targetStreamKey: "key",
    targetRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    targetVideoId: null,
    startedAt: null,
    endedAt: null,
    note: null,
    ...overrides,
  };
}

function respawnLogs(now: number, count: number): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(now - 1000 * (i + 1)).toISOString(),
    level: "info" as const,
    code: null,
    msg: "ffmpeg päättyi koodilla 1",
  }));
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const now = Date.now();
  return {
    now,
    job: baseJob(),
    relay: baseRelay(),
    match: baseMatch(),
    system: baseSystem(),
    log: [],
    errors: new Map(),
    ...overrides,
  };
}

describe("deriveHealth", () => {
  it("rule 1: a critical disk wins over every other condition, even a live/relay-down mismatch", () => {
    const { health, headline } = deriveHealth(
      snapshot({
        system: baseSystem({ diskCritical: true }),
        job: baseJob({ status: "live" }),
        relay: baseRelay({ active: false, activeState: "inactive" }),
      })
    );
    expect(health).toBe("fail");
    expect(headline).toMatch(/Levytila/);
  });

  it("a job claiming to be live while the relay unit is down is a hard failure", () => {
    const { health, headline } = deriveHealth(
      snapshot({
        job: baseJob({ status: "live" }),
        relay: baseRelay({ active: false, activeState: "inactive" }),
      })
    );
    expect(health).toBe("fail");
    expect(headline).toMatch(/Relay ei ole käynnissä/);
  });

  it("relay active and the match still going is the normal ok case", () => {
    const { health, headline } = deriveHealth(
      snapshot({
        job: baseJob({ status: "live" }),
        relay: baseRelay({ active: true, activeState: "active" }),
        match: baseMatch({ finished: false }),
      })
    );
    expect(health).toBe("ok");
    expect(headline).toMatch(/Lähetys kunnossa/);
  });

  it("no active job at all reads as idle, not as a healthy broadcast", () => {
    const { health, headline } = deriveHealth(
      snapshot({
        job: null,
        relay: baseRelay({ active: false, activeState: "inactive" }),
      })
    );
    expect(health).toBe("idle");
    expect(headline).toMatch(/Ei aktiivista lähetystä/);
  });

  it("relay running with no job is a warning, not idle or ok — it's live but unowned", () => {
    const { health, headline } = deriveHealth(
      snapshot({
        job: null,
        relay: baseRelay({ active: true, activeState: "active" }),
      })
    );
    expect(health).toBe("warn");
    expect(headline).toMatch(/ilman ohjaussovelluksen työtä/);
  });

  it("repeated ffmpeg respawns inside the recent window is a warning", () => {
    const now = Date.now();
    const { health, headline } = deriveHealth(
      snapshot({
        now,
        job: baseJob({ status: "live" }),
        relay: baseRelay({ active: true, activeState: "active" }),
        match: baseMatch({ finished: false }),
        log: respawnLogs(now, 2),
      })
    );
    expect(health).toBe("warn");
    expect(headline).toMatch(/respawnasi/);
  });

  it("a single ffmpeg exit does not count as flapping", () => {
    const now = Date.now();
    const { health } = deriveHealth(
      snapshot({
        now,
        job: baseJob({ status: "live" }),
        relay: baseRelay({ active: true, activeState: "active" }),
        match: baseMatch({ finished: false }),
        log: respawnLogs(now, 1),
      })
    );
    expect(health).toBe("ok");
  });

  it("unreadable job/relay state is reported as failing, never as calm", () => {
    const errors: Snapshot["errors"] = new Map([["relay", "systemctl timeout"]]);
    const { health, headline } = deriveHealth(snapshot({ errors }));
    expect(health).toBe("fail");
    expect(headline).toMatch(/systemctl timeout/);
  });

  it("match finished but relay still up is ok — the relay is expected to self-stop", () => {
    const { health, headline } = deriveHealth(
      snapshot({
        job: baseJob({ status: "live" }),
        relay: baseRelay({ active: true }),
        match: baseMatch({ finished: true }),
      })
    );
    expect(health).toBe("ok");
    expect(headline).toMatch(/sammuu itse/);
  });
});

// --------------------------------------------------------- Lähde-rivi + #104
//
// Sääntö jota nämä vartioivat: ohjaamon YouTube-havainto voi vain LISÄTÄ
// epäilystä, ei koskaan tuottaa vihreää. Kaksi mielipidettä samasta rivistä on
// juuri se ongelma jonka issue #97 poistaa — relayn oma havainto päättää
// lähtötason, ja API-havainto saa korkeintaan pudottaa sen.
describe("buildChain: lähde-rivi ja YouTube-havainto", () => {
  /** Lokitilanne jossa lokipohjainen logiikka antaa "ok": ffmpeg kiinni
   *  lähteessä ja relay ajossa. */
  function ffmpegRunning(now: number): LogLine[] {
    return [
      { ts: new Date(now - 60_000).toISOString(), level: "info", code: null, msg: "Käynnistetään ffmpeg" },
    ];
  }

  function ingest(overrides: Partial<SourceIngest> = {}): SourceIngest {
    return {
      observedAt: new Date().toISOString(),
      videoId: "SOURCEID123",
      lifeCycleStatus: "live",
      streamStatus: "active",
      healthStatus: "good",
      error: null,
      ...overrides,
    };
  }

  function sourceRow(overrides: Partial<Snapshot> = {}) {
    const now = Date.now();
    const snap = snapshot({ now, log: ffmpegRunning(now), ...overrides });
    const row = buildChain(snap, null).find((r) => r.key === "source");
    if (!row) throw new Error("lähde-riviä ei löytynyt");
    return row;
  }

  it("aktiivinen syöte säilyttää terveyden ja mainitaan detailissa", () => {
    const row = sourceRow({ sourceIngest: ingest() });
    expect(row.health).toBe("ok");
    expect(row.detail).toMatch(/syöte aktiivinen/);
  });

  it("ei-aktiivinen syöte pudottaa ok → warn ja näyttää raa'an arvon", () => {
    const row = sourceRow({ sourceIngest: ingest({ streamStatus: "inactive" }) });
    expect(row.health).toBe("warn");
    expect(row.detail).toMatch(/syöte ei virtaa \(inactive\)/);
  });

  it("päättynyt lähde relayn yhä ajaessa on warn, ei fail — vaiheessa 1 kukaan ei toimi tämän varassa", () => {
    const row = sourceRow({
      sourceIngest: ingest({ lifeCycleStatus: "complete", streamStatus: "inactive" }),
    });
    expect(row.health).toBe("warn");
    expect(row.detail).toMatch(/lähde on päättynyt/);
  });

  it("havainto ei koskaan nosta riviä vihreäksi", () => {
    // Lokissa ei ole havaintoa lähteestä -> "warn". Täydellinen API-havainto ei
    // saa korjata sitä vihreäksi.
    const row = sourceRow({ log: [], sourceIngest: ingest() });
    expect(row.health).toBe("warn");
    expect(row.detail).toMatch(/ei havaintoa lähteestä lokissa/);
  });

  it("idle-rivi pysyy idlenä vaikka syöte ei virtaisi — relay ei edes lue lähdettä", () => {
    const row = sourceRow({
      relay: baseRelay({ active: false, activeState: "inactive" }),
      job: baseJob({ status: "scheduled" }),
      sourceIngest: ingest({ streamStatus: "inactive" }),
    });
    expect(row.health).toBe("idle");
  });

  it("vanhentunut havainto ei muuta terveyttä", () => {
    const now = Date.now();
    const row = sourceRow({
      now,
      sourceIngest: ingest({
        observedAt: new Date(now - SOURCE_INGEST_STALE_MS - 1).toISOString(),
        streamStatus: "inactive",
      }),
    });
    expect(row.health).toBe("ok");
    expect(row.detail).toMatch(/vanhentunut/);
  });

  it("virheellinen havainto ei muuta terveyttä", () => {
    const row = sourceRow({
      sourceIngest: ingest({
        lifeCycleStatus: null,
        streamStatus: null,
        healthStatus: null,
        error: "lähdelähetystä ei löytynyt tältä kanavalta",
      }),
    });
    expect(row.health).toBe("ok");
    expect(row.detail).toMatch(/havaintoa ei saatu/);
  });

  it("ilman havaintoa pollerin syy näkyy detailissa", () => {
    const row = sourceRow({
      sourceIngest: null,
      sourceIngestReason: "lähde-URL osoittaa selostettuun lähetykseen — korjaa työn lähde-URL",
    });
    expect(row.health).toBe("ok");
    expect(row.detail).toMatch(/selostettuun lähetykseen/);
  });

  it("ilman työtä pollerin syytä ei toisteta riville", () => {
    const row = sourceRow({ job: null, sourceIngest: null, sourceIngestReason: "ei aktiivista työtä" });
    expect(row.detail).toBe("ei aktiivista työtä");
  });
});
