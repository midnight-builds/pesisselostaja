// deriveHealth is the priority-ordered rule table behind the one headline the
// operator reads standing in a field (apps/control/src/server/live.ts). Order
// IS the policy — rule 1 (disk) must win over every other rule, a job that
// claims "live" while the unit is down must never read as merely a warning,
// etc. deriveHealth and its Snapshot type are marked `export` in live.ts
// purely so this file can call them directly; no logic was touched.
import { describe, expect, it } from "vitest";
import { buildChain, deriveHealth, type Snapshot } from "../src/server/live.js";
import { SOURCE_INGEST_STALE_MS } from "../src/server/sourceIngest.js";
import { TARGET_INGEST_STALE_MS } from "../src/shared/targetHealth.js";
import type {
  Job,
  LogLine,
  MatchState,
  RelayProcess,
  RelayTelemetry,
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
    armedAt: null,
    startedAt: null,
    endedAt: null,
    cleanup: null,
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

  it("kertoo hallitusti päättyneen lähteen terveenä, ei telemetrian puutteena (#103)", () => {
    const row = sourceRow({
      telemetry: baseTelemetry({
        source: { state: "ended", detail: "yt-dlp: live_status=post_live" },
        match: { finished: true, eventCount: 5, lastEventAt: new Date().toISOString() },
      }),
    });
    // Kuvaaja lopetti lähteen ottelun jälkeen: normaali lopputila, ei vika
    // josta herätetään.
    expect(row.health).toBe("ok");
    expect(row.detail).not.toMatch(/ei kerro raakalähetyksen tilaa/);
  });

  it("kesken ottelun päättynyt lähde on KELTAINEN, ei 'siisti lopetus' (#117)", () => {
    const row = sourceRow({
      telemetry: baseTelemetry({ source: { state: "ended", detail: null } }),
    });
    // baseTelemetryn ottelu ei ole päättynyt: lähteen loppuminen nyt tarkoittaa
    // että lähetys on kuolemassa ennen aikojaan, eikä sitä saa kuitata vihreällä.
    expect(row.health).toBe("warn");
    expect(row.detail).toMatch(/kesken ottelun/);
  });

  it("näyttää katvekuvan KELTAISENA — se ei saa peittää poikki olevaa kuvaa (#104)", () => {
    const row = sourceRow({
      telemetry: baseTelemetry({ source: { state: "no_signal", detail: "kuvayhteys katkesi" } }),
    });
    // Juuri tässä tilassa lähetys näyttää ulospäin sujuvalta: RTMP-työntö
    // jatkuu ja selostus kuuluu, mutta kamera on poissa. Issuen oma rajaus on
    // ettei katve saa peittää ongelmaa operaattorilta.
    expect(row.health).toBe("warn");
    expect(row.detail).toMatch(/katvekuva päällä/);
    expect(row.detail).toMatch(/selostus jatkuu/);
    expect(row.detail).not.toMatch(/ei kerro raakalähetyksen tilaa/);
  });

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
    expect(row.detail).toMatch(/raakalähetys on päättynyt/);
  });

  it("havainto ei koskaan nosta riviä vihreäksi", () => {
    // Lokissa ei ole havaintoa lähteestä -> "warn". Täydellinen API-havainto ei
    // saa korjata sitä vihreäksi.
    const row = sourceRow({ log: [], sourceIngest: ingest() });
    expect(row.health).toBe("warn");
    // Lokivarapolun oma sanamuoto säilyy, ja havainto tulee sen PERÄÄN — se ei
    // korvaa relayn omaa havaintoa eikä nosta riviä vihreäksi.
    expect(row.detail).toMatch(/havaintoa raakalähetyksestä/);
    expect(row.detail).toMatch(/syöte aktiivinen/);
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

  // Tulevaisuuteen jäänyt aikaleima (kello siirtynyt kirjoituksen jälkeen,
  // käsin muokattu tiedosto) olisi ilman alarajaa IKUISESTI "tuore" ja ohjaisi
  // tilariviä siitä eteenpäin.
  it("tulevaisuudessa oleva aikaleima ei ole tuore havainto", () => {
    const now = Date.now();
    const row = sourceRow({
      now,
      sourceIngest: ingest({
        observedAt: new Date(now + 60_000).toISOString(),
        streamStatus: "inactive",
      }),
    });
    expect(row.health).toBe("ok");
    expect(row.detail).not.toMatch(/syöte ei virtaa/);
  });

  // Havainto muistissa ei tarkoita että relay olisi nähnyt sen: jos kirjoitus
  // control-tiedostoon epäonnistuu (levy täynnä, vain luku), polleri pitää
  // havainnon mutta julkaisu on poikki. Ilman tätä rivi näyttäisi "syöte
  // aktiivinen" vihreänä.
  it("havainnon kirjoitusvirhe näkyy rivillä ja pudottaa ok → warn", () => {
    const row = sourceRow({
      sourceIngest: ingest(),
      sourceIngestReason: "havainnon kirjoitus epäonnistui: levy täynnä",
    });
    expect(row.health).toBe("warn");
    expect(row.detail).toMatch(/kirjoitus epäonnistui: levy täynnä/);
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

/** #118: the run was bound to the previous evening's job, so every row on the
 *  screen described match 145895 while the relay narrated 145900. Nothing said
 *  so — and the operator's knobs were being written to a control file the
 *  running relay never reads. "Ei tietoa" beats "toisen ottelun tieto". */
describe("työ ja ajossa oleva ottelu ovat eri", () => {
  it("nostaa ristiriidan otsikkoon ja kertoo kumpi on kumpi", () => {
    const { health, headline } = deriveHealth(
      snapshot({ job: baseJob({ matchId: 145895, status: "live" }), runningMatchId: 145900 })
    );
    expect(health).toBe("fail");
    expect(headline).toContain("145900");
    expect(headline).toContain("145895");
  });

  it("merkitsee Relay-rivin punaiseksi vaikka unit olisi pystyssä", () => {
    const rows = buildChain(
      snapshot({ job: baseJob({ matchId: 145895, status: "live" }), runningMatchId: 145900 }),
      null
    );
    expect(rows.find((r) => r.key === "relay")).toMatchObject({ health: "fail" });
  });

  it("ei väitä ristiriitaa kun relay ei kerro mitä se ajaa", () => {
    // Näytön puute ei ole näyttö: relay ei ole ehtinyt kirjoittaa statustaan.
    const { health } = deriveHealth(
      snapshot({ job: baseJob({ matchId: 145895, status: "live" }), runningMatchId: null })
    );
    expect(health).not.toBe("fail");
  });

  it("ei renderöi toisen ottelun telemetriaa tämän hetken lähetyksenä", () => {
    // Ilman matchId-vartijaa lähde-rivi luki eilisen ottelun status-tiedostoa
    // ja näytti sen vihreänä.
    const rows = buildChain(
      snapshot({
        job: baseJob({ matchId: 145900, status: "live" }),
        telemetry: baseTelemetry({
          matchId: 145895,
          source: { state: "live", detail: "ffmpeg käynnissä" },
        }),
      }),
      null
    );
    expect(rows.find((r) => r.key === "source")?.detail).not.toContain("ffmpeg käynnissä");

    // Kontrolli: sama snapshot oikealla ottelulla menee läpi, joten väite yllä
    // mittaa vartijaa eikä jotain muuta joka pudottaisi telemetrian.
    const sameMatch = buildChain(
      snapshot({
        job: baseJob({ matchId: 145895, status: "live" }),
        telemetry: baseTelemetry({
          matchId: 145895,
          source: { state: "live", detail: "ffmpeg käynnissä" },
        }),
      }),
      null
    );
    expect(sameMatch.find((r) => r.key === "source")?.detail).toContain("ffmpeg käynnissä");
  });
});

/** #250: YouTuben autostop päätti selostetun lähetyksen kesken ottelun
 *  16.8.2026 (ottelu 136771). Relayn kirjanpito näytti tervettä ajoa — RTMP-
 *  työntö kuolleeseen lähetykseen onnistuu — joten kuolema näkyy vain ohjaamon
 *  omassa YouTube-havainnossa. Nämä testit pinnaavat sekä hälytyksen että sen
 *  rajauksen: ottelun jälkeen sama "complete" on normaali, terve lopputila. */
describe("kohde kuoli kesken ottelun (#250)", () => {
  const TARGET_VID = "TARGETVID99";

  function deadTarget(overrides: Partial<SourceIngest> = {}): SourceIngest {
    return {
      observedAt: new Date().toISOString(),
      videoId: TARGET_VID,
      lifeCycleStatus: "complete",
      streamStatus: null,
      healthStatus: null,
      error: null,
      ...overrides,
    };
  }

  function deadSnap(overrides: Partial<Snapshot> = {}): Snapshot {
    return snapshot({
      job: baseJob({ status: "live", targetVideoId: TARGET_VID }),
      targetIngest: deadTarget(),
      ...overrides,
    });
  }

  function targetRow(overrides: Partial<Snapshot> = {}) {
    const row = buildChain(deadSnap(overrides), null).find((r) => r.key === "target");
    if (!row) throw new Error("kohde-riviä ei löytynyt");
    return row;
  }

  it("deriveHealth: tuore complete-havainto kesken ottelun on FAIL ja otsikko sanoo sen suoraan", () => {
    const { health, headline } = deriveHealth(deadSnap());
    expect(health).toBe("fail");
    expect(headline).toMatch(/Selostettu lähetys on päättynyt/);
    expect(headline).toMatch(/kesken ottelun/);
  });

  it("myös revoked on kuollut kohde", () => {
    const { health } = deriveHealth(deadSnap({ targetIngest: deadTarget({ lifeCycleStatus: "revoked" }) }));
    expect(health).toBe("fail");
  });

  it("ottelun päätyttyä complete on normaali lopputila, ei hälytys", () => {
    const { health } = deriveHealth(deadSnap({ match: baseMatch({ finished: true }) }));
    expect(health).toBe("ok");
  });

  it("vanhentunut havainto ei hälytä — tietämättömyys ei ole todiste", () => {
    const stale = deadTarget({
      observedAt: new Date(Date.now() - TARGET_INGEST_STALE_MS - 1000).toISOString(),
    });
    const { health } = deriveHealth(deadSnap({ targetIngest: stale }));
    expect(health).toBe("ok");
  });

  it("toisen videon havainto ei hälytä tämän työn nimissä", () => {
    const other = deadTarget({ videoId: "JOKUMUU1234" });
    const { health } = deriveHealth(deadSnap({ targetIngest: other }));
    expect(health).toBe("ok");
  });

  it("relayn ollessa alhaalla vika on relay, ei kohde — sääntö 3 voittaa", () => {
    const { headline } = deriveHealth(
      deadSnap({ relay: baseRelay({ active: false, activeState: "inactive" }) })
    );
    expect(headline).toMatch(/Relay ei ole käynnissä/);
  });

  it("kohde-rivi on FAIL ja kertoo että työntö menee kuolleeseen kohteeseen", () => {
    const row = targetRow();
    expect(row.health).toBe("fail");
    expect(row.detail).toMatch(/kuolleeseen kohteeseen/);
  });

  it("ottelun jälkeen kohde-rivi pysyy vihreänä ja mainitsee päättymisen", () => {
    const row = targetRow({ match: baseMatch({ finished: true }) });
    expect(row.health).toBe("ok");
    expect(row.detail).toMatch(/selostettu lähetys on päättynyt/);
  });

  it("työntö joka ei mene perille pudottaa kohde-rivin ok → warn", () => {
    const row = targetRow({
      targetIngest: deadTarget({ lifeCycleStatus: "live", streamStatus: "inactive" }),
    });
    expect(row.health).toBe("warn");
    expect(row.detail).toMatch(/työntö ei mene perille \(inactive\)/);
  });

  it("perille menevä työntö vahvistaa vihreän rivin", () => {
    const row = targetRow({
      targetIngest: deadTarget({ lifeCycleStatus: "live", streamStatus: "active" }),
    });
    expect(row.health).toBe("ok");
    expect(row.detail).toMatch(/työntö menee perille/);
  });
});
