/** Deterministic fixture state for the UI tests.
 *
 *  Fictional teams and players only — the repo is public and real rosters
 *  include minors (CLAUDE.md / fixtures rule). Every builder returns a COMPLETE
 *  object of the shared contract type, so a field added to src/shared/types.ts
 *  breaks these builders (typecheck) instead of silently rendering "undefined"
 *  in a test that still passes. */

import type { AuthHealth } from "../../src/server/googleAuth";
import type {
  ChainStatus,
  ControlKnobs,
  DayMatches,
  Health,
  Job,
  LiveState,
  LogLine,
  MatchOption,
  MatchState,
  NarrationLine,
  PreflightResult,
  RelayProcess,
  RelayTelemetry,
  SchedulerState,
  SystemState,
} from "../../src/shared/types";

export const NOW = "2026-07-29T05:30:00.000Z"; // 08:30 Suomen aikaa

/** Ajastimen tila. `enabled: false` on oletus tässäkin — testi joka haluaa
 *  päällä olevan ajastimen sanoo sen ääneen. */
export function schedulerState(p: Partial<SchedulerState> = {}): SchedulerState {
  return {
    enabled: false,
    lastCheckAt: NOW,
    nextJob: {
      id: "job-1",
      home: "Kuusikon Kipinä",
      away: "Rantalan Rasti",
      startsAt: "2026-07-29T06:30:00.000Z",
      sourceUrl: "https://www.youtube.com/watch?v=testivirta",
      sourceState: "scheduled",
      sourceDetail: "ajastettu, alkaa noin 12 min kuluttua",
    },
    lastAction: null,
    wouldHaveDone: {
      at: NOW,
      decision: "waiting",
      jobId: "job-1",
      reason: "Lähde ei ole vielä livenä.",
      applied: false,
    },
    nextCheckInMs: 30_000,
    ...p,
  };
}

/** Google-yhteyden terveys. Oletus on TARKOITUKSELLA "ei yhdistetty": se on
 *  tila jossa ohjaamo oikeasti on niin kauan kuin tunnuksia ei ole kopioitu
 *  koneelle, ja se on ainoa tila jonka YouTube-välilehti osaa näyttää ilman
 *  että yksikään kirjoittava Google-kutsu lähtee liikkeelle. */
export function authHealth(p: Partial<AuthHealth> = {}): AuthHealth {
  return {
    connected: false,
    health: "idle",
    headline: "Google-tiliä ei ole yhdistetty.",
    channel: null,
    scopes: [],
    missingScopes: [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
    tokenObtainedAt: null,
    lastRefreshAt: null,
    daysSinceSuccess: null,
    tokenAgeDays: null,
    warnings: [],
    quota: { day: "2026-07-28", used: 0, limit: 10000, remaining: 10000 },
    pending: null,
    ...p,
  };
}

/** Yhdistetty tila oikealle kanavalle (runbook: Talonkuningas). */
export function authHealthConnected(p: Partial<AuthHealth> = {}): AuthHealth {
  return authHealth({
    connected: true,
    health: "ok",
    headline: "Yhteys kanavaan Talonkuningas.",
    channel: { id: "UC4oXm9z5eNyh1snqGsRqcnw", title: "Talonkuningas" },
    scopes: [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
    missingScopes: [],
    tokenObtainedAt: "2026-07-28T06:00:00.000Z",
    lastRefreshAt: "2026-07-29T05:00:00.000Z",
    daysSinceSuccess: 0,
    tokenAgeDays: 1,
    ...p,
  });
}

export function relayProcess(p: Partial<RelayProcess> = {}): RelayProcess {
  return {
    activeState: "active",
    active: true,
    uptimeSec: 2520,
    deployedCommit: "bbd3baf",
    nRestarts: 0,
    ...p,
  };
}

export function matchState(p: Partial<MatchState> = {}): MatchState {
  return {
    matchId: 999001,
    home: "KUV",
    away: "LAP",
    periodScores: [
      { home: 3, away: 1 },
      { home: 2, away: 2 },
    ],
    totalHome: 5,
    totalAway: 3,
    periodsWonHome: 1,
    periodsWonAway: 0,
    currentPeriod: 1,
    palot: 2,
    battingTeam: "LAP",
    finished: false,
    eventCount: 137,
    lastEventAt: "2026-07-29T05:29:48.000Z",
    ...p,
  };
}

export function systemState(p: Partial<SystemState> = {}): SystemState {
  return {
    diskFreeBytes: 12 * 1024 ** 3,
    diskTotalBytes: 30 * 1024 ** 3,
    diskCritical: false,
    memFreeBytes: 3 * 1024 ** 3,
    memTotalBytes: 8 * 1024 ** 3,
    load1: 1.24,
    cpuCount: 4,
    ...p,
  };
}

export function knobs(p: Partial<ControlKnobs> = {}): ControlKnobs {
  return {
    announceBatterChanges: true,
    narrationDelayMs: 4000,
    deltaFetch: true,
    pollIntervalMs: 3000,
    ...p,
  };
}

export function chain(p: Partial<Record<ChainStatus["key"], Partial<ChainStatus>>> = {}): ChainStatus[] {
  const rows: ChainStatus[] = [
    { key: "source", label: "Lähde", health: "ok", detail: "ffmpeg kiinni lähteessä" },
    { key: "relay", label: "Relay", health: "ok", detail: "active, 42 min, commit bbd3baf" },
    { key: "queue", label: "Jono", health: "ok", detail: "1 klippiä jonossa, viive 4000 ms" },
    { key: "target", label: "Kohde", health: "ok", detail: "push rtmp://a.rtmp.youtube.com/live2" },
    { key: "api", label: "Tulospalvelu", health: "ok", detail: "137 tapahtumaa" },
    { key: "system", label: "Järjestelmä", health: "ok", detail: "12.0 Gt vapaana, kuorma 1.24" },
  ];
  return rows.map((row) => ({ ...row, ...(p[row.key] ?? {}) }));
}

export function job(p: Partial<Job> = {}): Job {
  return {
    id: "job-0001",
    status: "live",
    createdAt: "2026-07-29T04:00:00.000Z",
    matchId: 999001,
    home: "Kuvitteellisen Kylän Veikot",
    away: "Lapinlahden Peikot",
    seriesName: "Testisarja",
    stadium: "Testikenttä 1",
    startsAt: "2026-07-29T05:30:00.000Z",
    sourceUrl: "https://www.youtube.com/watch?v=TESTSOURCE1",
    targetStreamKey: "aaaa-bbbb-cccc-dddd",
    targetRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    targetVideoId: null,
    armedAt: null,
    startedAt: "2026-07-29T05:29:00.000Z",
    endedAt: null,
    note: null,
    ...p,
  };
}

export function narration(): NarrationLine[] {
  return [
    {
      id: "1:c1",
      detectedAt: "2026-07-29T05:29:10.000Z",
      spokenAt: null,
      muted: false,
      text: "Toinen palo Peikoille.",
    },
    {
      id: "2:c2",
      detectedAt: "2026-07-29T05:29:30.000Z",
      spokenAt: "2026-07-29T05:29:34.000Z",
      muted: false,
      text: "Kotiutus! Veikot johtaa 5–3.",
    },
    // The line nobody heard: spoken as far as the relay's bookkeeping goes,
    // dropped because ffmpeg was not attached.
    {
      id: "3:c3",
      detectedAt: "2026-07-29T05:29:40.000Z",
      spokenAt: "2026-07-29T05:29:40.000Z",
      muted: true,
      text: "Kolmas palo Peikoille.",
    },
  ];
}

export function telemetry(p: Partial<RelayTelemetry> = {}): RelayTelemetry {
  return {
    at: NOW,
    matchId: 999001,
    startedAt: "2026-07-29T05:29:00.000Z",
    uptimeSec: 2520,
    readerAttached: true,
    pendingClips: 1,
    respawns: 0,
    source: { state: "live", detail: "ffmpeg käynnissä" },
    match: { finished: false, eventCount: 412, lastEventAt: "2026-07-29T05:29:40.000Z" },
    narration: { detected: 3, spoken: 2, muted: 1, queued: 1 },
    tts: { engine: "piper", elevenLabsCharsUsed: 0 },
    lastProblem: null,
    ...p,
  };
}

export function logLines(): LogLine[] {
  return [
    { ts: "2026-07-29T05:28:00.000Z", level: "debug", code: null, msg: "Poll 412: 3 uutta tapahtumaa" },
    { ts: "2026-07-29T05:28:20.000Z", level: "info", code: null, msg: "Sydänääni: relay käynnissä 2400s, selostusjonossa 1 klippiä." },
    { ts: "2026-07-29T05:28:40.000Z", level: "warn", code: null, msg: "ffmpeg päättyi koodilla 1 — käynnistetään uudelleen" },
    { ts: "2026-07-29T05:29:00.000Z", level: "error", code: null, msg: "Tulospalvelun haku epäonnistui: timeout" },
  ];
}

export function liveState(p: Partial<LiveState> = {}): LiveState {
  return {
    now: NOW,
    health: "ok",
    headline: "Lähetys kunnossa, 42 min",
    chain: chain(),
    relay: relayProcess(),
    match: matchState(),
    system: systemState(),
    knobs: knobs(),
    job: job(),
    telemetry: telemetry(),
    narration: narration(),
    log: logLines(),
    ...p,
  };
}

/** Health-state variants for the banner test — headline wording mirrors
 *  deriveHealth() in src/server/live.ts. */
export const HEALTH_CASES: Array<{ health: Health; word: string; headline: string }> = [
  { health: "ok", word: "Kunnossa", headline: "Lähetys kunnossa, 42 min" },
  { health: "warn", word: "Huomio", headline: "ffmpeg respawnasi 3× viime minuutteina — kuva pätkii" },
  { health: "fail", word: "Vika", headline: "Relay ei ole käynnissä (inactive) vaikka lähetyksen pitäisi olla ajossa" },
  { health: "idle", word: "Valmiudessa", headline: "Ei aktiivista lähetystä" },
];

export function matchOption(p: Partial<MatchOption> = {}): MatchOption {
  return {
    id: 999001,
    home: "Kuvitteellisen Kylän Veikot",
    away: "Lapinlahden Peikot",
    homeShort: "KUV",
    awayShort: "LAP",
    startsAt: "2026-07-29T14:00:00.000Z",
    seriesName: "Testisarja",
    stadium: "Testikenttä 1",
    live: false,
    status: "upcoming",
    resultString: null,
    ...p,
  };
}

/** A day with two stadiums and two series, so both filters have something to
 *  actually filter. */
export function dayMatches(date: string): DayMatches {
  const matches: MatchOption[] = [
    matchOption({
      id: 999001,
      home: "Kuvitteellisen Kylän Veikot",
      away: "Lapinlahden Peikot",
      startsAt: `${date}T09:00:00.000Z`,
      stadium: "Testikenttä 1",
      seriesName: "Testisarja",
    }),
    matchOption({
      id: 999002,
      home: "Mustikkamäen Maila",
      away: "Puolukkalan Pesä",
      homeShort: "MUM",
      awayShort: "PUP",
      startsAt: `${date}T11:00:00.000Z`,
      stadium: "Testikenttä 2",
      seriesName: "Testisarja",
    }),
    matchOption({
      id: 999003,
      home: "Ankkalammen Ampujat",
      away: "Sammakkosuon Sinkot",
      homeShort: "ANA",
      awayShort: "SAS",
      startsAt: `${date}T13:00:00.000Z`,
      stadium: "Testikenttä 1",
      seriesName: "Juniorileiri",
      status: "live",
      live: true,
    }),
    matchOption({
      id: 999004,
      home: "Karhunpesän Kiitäjät",
      away: "Vesiheinän Veto",
      homeShort: "KAK",
      awayShort: "VEV",
      startsAt: `${date}T07:00:00.000Z`,
      stadium: "Testikenttä 2",
      seriesName: "Juniorileiri",
      status: "finished",
      resultString: "2–0",
    }),
  ];
  return {
    date,
    stadiums: ["Testikenttä 1", "Testikenttä 2"],
    seriesNames: ["Juniorileiri", "Testisarja"],
    matches,
  };
}

export function preflightResult(p: Partial<PreflightResult> = {}): PreflightResult {
  return {
    ranAt: NOW,
    checks: [
      { name: "ffmpeg", status: "ok", detail: "löytyy polusta" },
      { name: "yt-dlp", status: "ok", detail: "2026.07.01" },
      { name: "Levytila", status: "warn", detail: "12.0 Gt vapaana" },
      { name: "RELAY_STREAM_KEY", status: "ok", detail: "asetettu" },
    ],
    blockers: 0,
    warnings: 1,
    summary: "Ei esteitä, 1 huomautus — relay voidaan käynnistää.",
    ...p,
  };
}

export function preflightWithBlockers(): PreflightResult {
  return preflightResult({
    checks: [
      { name: "ffmpeg", status: "ok", detail: "löytyy polusta" },
      { name: "RELAY_STREAM_KEY", status: "fail", detail: "puuttuu .env.relay-tiedostosta" },
      { name: "Levytila", status: "warn", detail: "12.0 Gt vapaana" },
      { name: "Lähde-URL", status: "fail", detail: "RELAY_YOUTUBE_URL puuttuu" },
    ],
    blockers: 2,
    warnings: 1,
    summary: "2 estettä — älä käynnistä relayta.",
  });
}

/** Tekstipaketti jonka esikatselureitti palauttaa. `matchup` heijastaa
 *  otsikko-ohitukset, jotta selaintesti näkee menivätkö ne palvelimelle. */
export function broadcastTexts(p: { teamLabel?: string; opponent?: string; shortVenue?: string } = {}) {
  const own = p.teamLabel ?? "Kuvitteellisen Kylän Veikot";
  const opponent = p.opponent ?? "Lapinlahden Peikot";
  const place = p.shortVenue ?? "Testikenttä 1";
  const matchup = `${own} - ${opponent}`;
  return {
    title: `${matchup}, 29.7.2026 ${place}`,
    narratedTitle: `Selostettu ${matchup}, 29.7.2026 ${place}`,
    description: `Ottelu: ${matchup}\nPäivä: 29.7.2026 klo 8:30`,
    shareMessage: [
      `Seuraava live on klo 8:30: ${matchup}. Alla linkit:`,
      "YouTube: <youtube-linkki>",
      "YouTube selostettu: <selostettu-youtube-linkki>",
      "Tulospalvelu: https://www.pesistulokset.fi/ottelut/999001",
    ].join("\n"),
    playlistId: "PLtesti",
    playlistName: "Pesä Ysit F 2026",
    ageGroup: "F" as const,
    localDate: "29.7.2026",
    localTime: "8:30",
    scheduledLocal: "29.7.2026 klo 8:30",
    matchUrl: "https://www.pesistulokset.fi/ottelut/999001",
    matchup,
    venue: place,
    thumbnailHeadline: matchup,
    thumbnailDatetime: "29.7.2026 klo 8:30",
    thumbnailVenue: place,
  };
}

/** Luotu lähetyspari — jaettavassa viestissä oikeat linkit paikkamerkkien
 *  tilalla, aivan kuten oikealla palvelimella. */
export function createdPair(texts = broadcastTexts()) {
  const shareMessage = texts.shareMessage
    .replace("<youtube-linkki>", "https://www.youtube.com/watch?v=NORMAALI")
    .replace("<selostettu-youtube-linkki>", "https://www.youtube.com/watch?v=SELOSTETTU");
  return {
    normal: { watchUrl: "https://www.youtube.com/watch?v=NORMAALI", videoId: "NORMAALI", title: texts.title, rtmpUrl: null, backupUrl: null, streamKey: null },
    narrated: {
      watchUrl: "https://www.youtube.com/watch?v=SELOSTETTU",
      videoId: "SELOSTETTU",
      title: texts.narratedTitle,
      rtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
      backupUrl: "rtmp://b.rtmp.youtube.com/live2?backup=1",
      streamKey: "cccc-dddd-eeee-ffff",
    },
    shareMessage,
    broadcastSummary: `Normaali: https://www.youtube.com/watch?v=NORMAALI\nStream Key: cccc-dddd-eeee-ffff`,
    texts,
  };
}
