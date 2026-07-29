/** Contract between the control server and its client. Kept in one file on
 *  purpose: both sides import it, so a shape change breaks the typecheck
 *  instead of the phone at 8:30. */

export type Health = "ok" | "warn" | "fail" | "idle";

/** One line of the ffmpeg/relay chain, rendered as a dot in the status grid. */
export interface ChainStatus {
  key: "source" | "relay" | "queue" | "target" | "api" | "system";
  label: string;
  health: Health;
  /** One short sentence — this is what the operator actually reads. */
  detail: string;
}

export interface RelayProcess {
  /** systemctl --user is-active output, verbatim. */
  activeState: string;
  active: boolean;
  /** Seconds since the unit entered its current state, null if unknown. */
  uptimeSec: number | null;
  /** Commit the pinned deploy at ~/relay-deploy is running. */
  deployedCommit: string | null;
  /** Restart count reported by systemd — a climbing number means flapping. */
  nRestarts: number | null;
}

export interface MatchState {
  matchId: number | null;
  home: string | null;
  away: string | null;
  /** Runs per period, index 0 = 1. jakso. */
  periodScores: Array<{ home: number; away: number }>;
  totalHome: number;
  totalAway: number;
  periodsWonHome: number;
  periodsWonAway: number;
  /** 0 = 1. jakso, 1 = 2. jakso, 2 = supervuoro, 3 = kotiutuslyöntikilpailu. */
  currentPeriod: number | null;
  /** Palot belong to the batting team and reset every turn. */
  palot: number | null;
  battingTeam: string | null;
  finished: boolean;
  /** Events seen in the feed, for "is the source alive" purposes. */
  eventCount: number;
  lastEventAt: string | null;
}

export interface NarrationLine {
  id: string;
  /** Wall clock when the event was detected in the feed. */
  detectedAt: string;
  /** Set once the relay actually spoke it — phase B telemetry. Until then the
   *  line renders as "queued". */
  spokenAt: string | null;
  text: string;
}

export interface LogLine {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  /** Stable event code once phase B lands; null while parsing journald prose. */
  code: string | null;
  msg: string;
}

export interface SystemState {
  diskFreeBytes: number;
  diskTotalBytes: number;
  /** True when below the global 2 GB / 10 % floor — a hard stop for writes. */
  diskCritical: boolean;
  memFreeBytes: number;
  memTotalBytes: number;
  load1: number;
  cpuCount: number;
}

export interface ControlKnobs {
  announceBatterChanges: boolean;
  narrationDelayMs: number;
  deltaFetch: boolean;
  pollIntervalMs: number;
}

/** Everything the live view needs, in one payload, pushed over SSE. */
export interface LiveState {
  /** Server time, so the client can render "N s sitten" without trusting the
   *  phone's clock. */
  now: string;
  health: Health;
  /** The one sentence under the big status. */
  headline: string;
  chain: ChainStatus[];
  relay: RelayProcess;
  match: MatchState;
  system: SystemState;
  knobs: ControlKnobs | null;
  job: Job | null;
  narration: NarrationLine[];
  log: LogLine[];
}

/** Which of the four push triggers the operator wants to be woken by.
 *
 *  Server-side state on purpose: the notifications are decided and sent by the
 *  server, so a preference kept in one phone's localStorage could not silence
 *  anything. One operator, one set of preferences. */
export interface NotificationPrefs {
  /** Lähetys rikki eikä korjaantunut — kriittinen. */
  broken: boolean;
  /** Automaattinen korjaus tehtiin (vaiheen B automatiikka). */
  autoFix: boolean;
  /** Valmistelu ja käynnistys: relay siirtyi ajoon, tai preflightissa esteitä. */
  startup: boolean;
  /** Lähetys päättyi. */
  ended: boolean;
}

/** What one push actually achieved. Reported by the test route so the operator
 *  learns "0 lähetetty, 1 vanhentunut tilaus poistettu" instead of a silent OK
 *  from a chain that is in fact broken. */
export interface PushSendResult {
  sent: number;
  failed: number;
  /** Subscriptions the push service reported as gone (404/410) and we dropped. */
  removed: number;
}

export type JobStatus =
  | "draft"
  | "scheduled"
  | "arming"
  | "live"
  | "finished"
  | "failed"
  | "cancelled";

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  /** pesistulokset match id — the thing the relay narrates. */
  matchId: number;
  home: string;
  away: string;
  seriesName: string | null;
  stadium: string | null;
  /** Scheduled kickoff, ISO. Finnish local time is derived for display. */
  startsAt: string | null;
  /** SOURCE: the phone's own live, read by yt-dlp. Never written to. */
  sourceUrl: string | null;
  /** TARGET: the narrated broadcast we push to. */
  targetStreamKey: string | null;
  targetRtmpUrl: string;
  targetVideoId: string | null;
  /** Set when the relay ran, for the post-run report. */
  startedAt: string | null;
  endedAt: string | null;
  note: string | null;
}

/** What the scheduler decided on its last look. One value per branch of
 *  scheduler.ts's plan, because the UI has to be able to say *why* nothing
 *  started — "ei mitään tapahtunut" is exactly the report that sends an
 *  operator to read journald in the middle of a match. */
export type SchedulerDecision =
  /** Ei odottavaa työtä — ajastin ei edes kysele lähdettä. */
  | "idle"
  /** Työ olemassa, lähde ei ole vielä livenä. Normaali tila ennen ottelua. */
  | "waiting"
  /** Lähde livenä, este poissa: käynnistys (tai kuiva-ajossa "olisi käynnistänyt"). */
  | "start"
  /** Preflight löysi esteitä — relayta EI käynnistetty. */
  | "blocked-preflight"
  /** Levytila kriittinen — globaali sääntö estää kaiken. */
  | "blocked-disk"
  /** Toinen työ on jo ajossa. Ajossa olevaa ei katkaista koskaan. */
  | "blocked-busy"
  /** yt-dlp ei osannut sanoa lähteestä mitään järkevää. */
  | "source-error"
  /** Käynnistys yritettiin mutta se kaatui (systemd, env-kirjoitus). */
  | "start-failed";

export interface SchedulerAction {
  at: string;
  decision: SchedulerDecision;
  jobId: string | null;
  /** Yksi suomenkielinen lause, sama teksti jonka käyttöliittymä näyttää. */
  reason: string;
  /** true = tämä tehtiin oikeasti. false = pelkkä laskelma (ajastin pois
   *  päältä), eikä yhtään sivuvaikutusta ajettu. */
  applied: boolean;
}

/** The job the scheduler is currently watching, plus what it last saw of its
 *  source. Flattened out of Job on purpose: the scheduler view needs five
 *  fields, not the whole job. */
export interface SchedulerNextJob {
  id: string;
  home: string;
  away: string;
  startsAt: string | null;
  sourceUrl: string | null;
  sourceState: "live" | "scheduled" | "error" | "unknown";
  /** yt-dlp:n oma sanamuoto ("livenä, HLS-manifesti (täysi laatu)"). */
  sourceDetail: string | null;
}

export interface SchedulerState {
  /** OFF by default and only ever turned on from the UI: an automatic start
   *  must never surprise an operator who is running a broadcast by hand. */
  enabled: boolean;
  lastCheckAt: string | null;
  nextJob: SchedulerNextJob | null;
  /** Viimeisin päätös ajastimen ollessa PÄÄLLÄ. */
  lastAction: SchedulerAction | null;
  /** Viimeisin päätös ajastimen ollessa POIS PÄÄLTÄ — mitä se olisi tehnyt.
   *  Tämän varassa käyttäjä uskaltaa kytkeä ajastimen päälle. */
  wouldHaveDone: SchedulerAction | null;
  /** Kuinka pian seuraava tarkistus ajetaan; tihenee alkuajan lähestyessä. */
  nextCheckInMs: number;
}

export interface PreflightCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface PreflightResult {
  ranAt: string;
  checks: PreflightCheck[];
  blockers: number;
  warnings: number;
  summary: string;
}

/** A match as offered by the picker. */
export interface MatchOption {
  id: number;
  home: string;
  away: string;
  homeShort: string;
  awayShort: string;
  startsAt: string | null;
  seriesName: string | null;
  stadium: string | null;
  live: boolean;
  status: "upcoming" | "live" | "finished";
  resultString: string | null;
}

export interface DayMatches {
  date: string;
  stadiums: string[];
  seriesNames: string[];
  matches: MatchOption[];
}
