// deriveHealth is the priority-ordered rule table behind the one headline the
// operator reads standing in a field (apps/control/src/server/live.ts). Order
// IS the policy — rule 1 (disk) must win over every other rule, a job that
// claims "live" while the unit is down must never read as merely a warning,
// etc. deriveHealth and its Snapshot type are marked `export` in live.ts
// purely so this file can call them directly; no logic was touched.
import { describe, expect, it } from "vitest";
import { deriveHealth, type Snapshot } from "../src/server/live.js";
import type {
  Job,
  LogLine,
  MatchState,
  RelayProcess,
  RelayTelemetry,
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
    // Null by default: most rules must hold for a relay that publishes no
    // telemetry at all (an older deploy), and the rules that read it say so.
    telemetry: null,
    log: [],
    errors: new Map(),
    ...overrides,
  };
}

/** A relay reporting a healthy, attached, live run. */
function baseTelemetry(overrides: Partial<RelayTelemetry> = {}): RelayTelemetry {
  return {
    at: new Date().toISOString(),
    matchId: 1,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    uptimeSec: 600,
    readerAttached: true,
    pendingClips: 1,
    respawns: 0,
    source: { state: "live", detail: "ffmpeg käynnissä" },
    match: { finished: false, eventCount: 5, lastEventAt: new Date().toISOString() },
    narration: { detected: 10, spoken: 9, muted: 0, queued: 1 },
    tts: { engine: "piper", elevenLabsCharsUsed: 0 },
    lastProblem: null,
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

  // Match 145889, 29.7.2026: the relay ran, the feed advanced, every clip was
  // counted — and ffmpeg was not attached, so five minutes of narration
  // including two runs were never heard. The old view called that "kunnossa".
  it("a live source with no ffmpeg reader is a warning, not a healthy broadcast", () => {
    const { health, headline } = deriveHealth(
      snapshot({
        job: baseJob({ status: "live" }),
        telemetry: baseTelemetry({
          readerAttached: false,
          uptimeSec: 300,
          narration: { detected: 12, spoken: 0, muted: 12, queued: 0 },
        }),
      })
    );
    expect(health).toBe("warn");
    expect(headline).toMatch(/ei ole kytkeytynyt/);
    expect(headline).toMatch(/12/);
  });

  it("the first minute of a run is not yet a warning — the reader attaches a moment after ffmpeg starts", () => {
    const { health } = deriveHealth(
      snapshot({
        job: baseJob({ status: "live" }),
        telemetry: baseTelemetry({ readerAttached: false, uptimeSec: 20 }),
      })
    );
    expect(health).toBe("ok");
  });

  it("waiting for a scheduled source is not a missing reader — nothing is supposed to be playing yet", () => {
    const { health } = deriveHealth(
      snapshot({
        job: baseJob({ status: "live" }),
        telemetry: baseTelemetry({
          readerAttached: false,
          uptimeSec: 900,
          source: { state: "scheduled", detail: "alkaa noin 8 min kuluttua" },
        }),
      })
    );
    expect(health).toBe("ok");
  });

  it("a stale snapshot from a relay that stopped reporting is not believed", () => {
    const now = Date.now();
    const { health } = deriveHealth(
      snapshot({
        now,
        job: baseJob({ status: "live" }),
        telemetry: baseTelemetry({
          at: new Date(now - 10 * 60_000).toISOString(),
          readerAttached: false,
          uptimeSec: 900,
        }),
      })
    );
    expect(health).toBe("ok");
  });
});
