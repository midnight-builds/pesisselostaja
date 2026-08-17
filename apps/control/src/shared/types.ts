/** Contract between the control server and its client. Kept in one file on
 *  purpose: both sides import it, so a shape change breaks the typecheck
 *  instead of the phone at 8:30. */

import type { SourceEndReason } from "@pesisselostaja/core";

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

/** One narration clip as the RELAY reported it, read from
 *  `run/timeline-<matchId>.ndjson`. Never reconstructed here: the control app
 *  cannot know which speech variant was picked, which roster the relay had, or
 *  what the score was at the moment the line was decided (issue #97). */
export interface NarrationLine {
  /** Unique within one match. The relay's own clip id restarts at `c1` on every
   *  relay restart, so the timeline record's running number is prefixed. */
  id: string;
  /** The relay's clock when it decided to say this. */
  detectedAt: string;
  /** When the clip reached the mixer. Null while it is still queued. */
  spokenAt: string | null;
  /** True when the clip was produced while ffmpeg was not attached: the relay's
   *  bookkeeping ran, but NOBODY HEARD IT. This is the five silent minutes of
   *  match 145889 made visible. */
  muted: boolean;
  text: string;
}

/** The relay's own snapshot of itself, read from `run/status-<matchId>.json`.
 *  A faithful mirror of apps/broadcast's RelayStatus — deliberately re-declared
 *  rather than imported, because this is the client contract and the relay
 *  writing it may be an older deploy (~/relay-deploy moves only on
 *  `npm run relay:deploy`). Everything is parsed defensively on the way in. */
/** Kuinka vanha relayn tilannekuva saa olla ennen kuin se on tietämättömyyttä.
 *
 *  Sopimuksen osa eikä palvelimen sisäinen luku: `RelayTelemetry.at` lähetetään
 *  asiakkaalle sellaisenaan, ja BOTH sides have to apply the same rule — muuten
 *  toinen puoli näyttää vihreää tilannekuvasta, jonka toinen on jo hylännyt
 *  vanhentuneena. Relay kirjoittaa tilannekuvansa joka pollilla (sekunteja),
 *  joten puolitoista minuuttia hiljaisuutta on jo relay joka lakkasi
 *  raportoimasta. */
export const TELEMETRY_STALE_MS = 90_000;

export interface RelayTelemetry {
  /** When the relay wrote this snapshot. The client compares it against
   *  LiveState.now: a stale snapshot is a relay that stopped reporting. */
  at: string;
  matchId: number;
  startedAt: string;
  uptimeSec: number;
  /** ffmpeg is attached and draining the narration FIFO — i.e. narration is
   *  actually reaching viewers. */
  readerAttached: boolean;
  pendingClips: number;
  respawns: number;
  source: {
    /** Peilaa relayn omaa `RelayStatus.source.state`-unionia
     *  (`apps/broadcast/src/telemetry.ts`). Kun relay saa uuden tilan, se on
     *  lisättävä myös tänne — muuten arvo putoaa ohjaamon defaulttiin ja
     *  tilarivi sanoo "relay ei kerro raakalähetyksen tilaa" juuri silloin kun relay
     *  kertoo sen tarkasti. Niin kävi `ended`ille (#103) ja `no_signal`ille
     *  (#104), jotka lisättiin relaylle tämän tyypin jo olemassa ollessa. */
    state:
      | "live"
      | "scheduled"
      | "resolving"
      | "failed"
      | "ended"
      | "unknown"
      | "no_signal"
      | "reconnecting";
    detail: string | null;
  };
  match: {
    finished: boolean;
    eventCount: number;
    lastEventAt: string | null;
  };
  narration: {
    detected: number;
    spoken: number;
    muted: number;
    queued: number;
  };
  tts: {
    engine: string;
    elevenLabsCharsUsed: number;
  };
  lastProblem: { at: string; level: LogLine["level"]; code: string | null; msg: string } | null;
  /** Miksi relay lopetti. Toisin kuin `source.state`, tämä EI ole käsin
   *  peilattu unioni vaan sama `SourceEndReason` jota relay itse käyttää,
   *  luettuna coresta — jolloin relayn uusi lopetussyy kaataa ohjaamon
   *  käännöksen (`END_REASON_SET` telemetry.ts:ssä) sen sijaan että putoaisi
   *  hiljaa pois. Käsin peilaaminen tuotti täsmälleen sen vian `ended`ille
   *  (#103) ja `no_signal`ille (#104), ks. #117.
   *
   *  `undefined`/puuttuva = relay ei kertonut (vanha deploy, tai ajossa yhä).
   *
   *  Kaksi arvoa oikeuttaa lähetykseen koskemisen, eri laajuudella:
   *  - `"hard_stop"` on ainoa arvo, joka oikeuttaa hard stopin siivouksen
   *    (#123) — ja siis ainoa, jolla RAAKALÄHETYKSEEN saa koskea (lipun
   *    `CONTROL_HARD_STOP_SOURCE` takana).
   *  - `"ended"` YHDESSÄ `match.finished`in kanssa oikeuttaa hallitun
   *    lopetuksen (#153): SELOSTETTU lähetys transitoidaan `complete`ksi.
   *    Pelkkä `"ended"` ei riitä — se tulee myös kesken ottelun kuolleesta
   *    raakalähetyksestä, ja lopetus silloin katkaisisi elävän lähetyksen.
   *
   *  Muissa tapauksissa kohteen sulkee YouTuben `enableAutoStop`. */
  endReason?: SourceEndReason | null;
}

/** Ohjaamon pysyväisasetukset (#133).
 *
 *  Vain sellaista, mikä säilyy ottelusta toiseen: jakoviestin sanamuoto ja
 *  kenttänimen siivous. Relayn ottelunaikaiset säätimet (selostus päälle/pois,
 *  viive, pollausväli) EIVÄT ole täällä — ne ovat Live-näkymässä ja menevät
 *  relayn control-tiedostoon, koska ne ovat ohjausta eivätkä asetuksia.
 *
 *  Jokainen kenttä vastaa yhtä `run/`-hakemiston JSON-tiedostoa, joita
 *  operaattori voi hätätilassa yhä korjata tiedostoselaimella. */
export interface ControlSettings {
  /** run/share-template.json (#95). */
  shareTemplate: { opening: string; lines: string[] };
  /** run/venue-cleanup.json (#132). */
  venueCleanup: { stripFieldNumber: boolean; stripQualifier: boolean };
}

/** GET /api/jobs/:id/share — katsojille jaettava viesti (#131).
 *
 *  Muodostetaan pyynnöstä työn linkeistä eikä talleteta luontihetkellä:
 *  luontivastaus näkyi vain kerran, joten viesti katosi jos sitä ei kopioinut
 *  heti tai sivu latautui uudelleen. Katsojia tulee kanaville kesken
 *  ottelunkin ja viesti jaetaan useaan ryhmään eri aikoina. */
export interface JobShareMessage {
  shareMessage: string;
  /** False ennen lähetysten luontia: viestissä on silloin paikkamerkit
   *  oikeiden linkkien sijaan. Kelvollinen vastaus, mutta käyttöliittymän on
   *  sanottava se — muuten ryhmään jaetaan "<youtube-linkki>". */
  linksReady: boolean;
}

/** Miten thumbnailin asetus yhdelle videolle päättyi (#130).
 *
 *  Oma tyyppinsä eikä pelkkä `boolean`, koska epäonnistuminen on tässä
 *  *odotettu* lopputulos jonka operaattorin on nähtävä: lähetykset ovat jo
 *  olemassa siinä vaiheessa kun thumbnailia yritetään, eikä niitä voi luoda
 *  uudelleen. Hiljainen `false` olisi täsmälleen se vika josta #130 kirjoitti
 *  ("hiljainen epäonnistuminen olisi pahempi, koska luonti raportoi
 *  onnistuneensa"). */
export type ThumbnailOutcome = { ok: true } | { ok: false; error: string };

export interface ThumbnailOutcomes {
  normal: ThumbnailOutcome;
  narrated: ThumbnailOutcome;
}

/** Kumpi prosessi rivin kirjoitti (#232). Loki on kahden unitin lomitus, ja
 *  ilman tätä "ohjaamo ei tehnyt mitään" ja "relay ei kertonut mitään" näyttävät
 *  lokinäkymässä samalta — juuri se ero jota 5.8.2026 jälkikäteen etsittiin. */
export type LogUnit = "relay" | "control";

export interface LogLine {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  /** Stable event code once phase B lands; null while parsing journald prose. */
  code: string | null;
  msg: string;
  /** Valinnainen: vanhempi palvelin ei lähetä tätä, eikä puuttuva kenttä saa
   *  jättää lokinäkymää tyhjäksi. */
  unit?: LogUnit;
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

/** Ohjaamon YouTube-API-havainto LÄHTEEN sisääntulosta. Ohjaamo on ainoa jolla
 *  on Google-tunnukset, joten se katsoo ja relay lukee — relay ei koskaan kysy
 *  Googlelta itse (yksi refresh_tokenin omistaja, eikä lähetyksen jatkuminen
 *  saa riippua Google-yhteydestä). Vaihe 1 vain julkaisee; kuluttajaa ei vielä
 *  ole. */
export interface SourceIngest {
  /** Havaintohetki, ISO. Kuluttajan ON kohdeltava vanhentunutta tietoa
   *  tietämättömyytenä — ei "syöte poikki" -päätöksenä. */
  observedAt: string;
  /** Mitä videota katsottiin. Kuluttaja voi ristiintarkistaa tämän omaa
   *  RELAY_YOUTUBE_URLiaan vasten; ilman sitä lähde ja kohde voivat sekaantua. */
  videoId: string;
  /** liveBroadcasts.list, raaka arvo: created|ready|testing|live|complete|revoked. */
  lifeCycleStatus: string | null;
  /** liveStreams.list, raaka arvo: created|ready|active|inactive|error.
   *  VAIN "active" tarkoittaa että dataa virtaa sisään — kaikki muu on
   *  "ei virtaa", ja null on "ei tietoa". */
  streamStatus: string | null;
  /** healthStatus.status: good|ok|bad|noData. */
  healthStatus: string | null;
  /** Lyhyt suomenkielinen syy kun havaintoa ei saatu; muuten null. Tila-kentät
   *  ovat silloin null — vanhaa arvoa ei jätetä paikoilleen, koska vanhentunut
   *  "active" on vaarallisempi kuin tietämättömyys. */
  error: string | null;
}

/** Onko YouTube vastannut tyhjää kysyttäessä selostettua lähetystä (#252).
 *
 *  Oma tilansa nimenomaan siksi, ettei se ole `error`: virhe on "emme
 *  saaneet vastausta", tyhjä lista on vastaus — ja auktoritatiivinen sellainen,
 *  koska ohjaamo loi lähetyksen omalle kanavalleen ja kysyy sitä sen omalla
 *  id:llä.
 *
 *  - `"no"` — lähetys löytyi kanavalta.
 *  - `"unconfirmed"` — yksi tyhjä vastaus. Juuri luotu lähetys voi puuttua
 *    listauksesta hetken (eventual consistency), joten tämä on armonaikaa eikä
 *    näyttöä; kohdellaan tietämättömyytenä eikä hälytetä.
 *  - `"confirmed"` — kaksi peräkkäistä tyhjää vastausta. Lähetys on poissa
 *    (käsin poistettu Studiossa, kanavamoderointi), ja katsojan kannalta
 *    lopputulos on sama kuin `complete`: jaettu linkki ei näytä mitään. */
export type TargetNotFound = "no" | "unconfirmed" | "confirmed";

/** Ohjaamon YouTube-API-havainto KOHTEESTA eli selostetusta lähetyksestä
 *  (#250). Sama muoto kuin lähteen havainnolla: observedAt/videoId/tilat/error
 *  tarkoittavat samaa, vain katsottava lähetys on eri. Toisin kuin lähteessä,
 *  YouTube on kohteen tilan AINOA totuudenlähde — relayn RTMP-työntö onnistuu
 *  myös kuolleeseen lähetykseen (16.8.2026, ottelu 136771), joten relayn oma
 *  kirjanpito ei voi kertoa tästä mitään.
 *
 *  Oma tyyppinsä eikä enää `SourceIngest`in alias (#252): kohteella on yksi
 *  kenttä jota lähteellä ei ole. Suunta on tarkoituksella tämä — `TargetIngest`
 *  levenee, `SourceIngest` ei muutu millään tavalla, jottei kohteen takia
 *  lisätty tieto voi saada raakalähetyksen riviä hälyttämään väärin. */
export interface TargetIngest extends SourceIngest {
  /** Vastasiko YouTube tyhjää, ja onko se jo varmistettu. Ks. `TargetNotFound`.
   *  Kun tämä on `"confirmed"`, `error` on null ja tila-kentät ovat null: kyse
   *  ei ole epäonnistuneesta hausta vaan onnistuneesta havainnosta siitä,
   *  ettei lähetystä ole. */
  notFound: TargetNotFound;
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
  /** Ohjaamon viimeisin YouTube-havainto lähteestä, tai null kun sitä ei
   *  juuri nyt pollata. Valinnainen tarkoituksella: kenttä lisättiin
   *  olemassa olevaan sopimukseen, eivätkä testien fixtuurit (test-ui/support/
   *  state.ts) saa rikkoutua siitä että ohjaamo alkoi julkaista sen. */
  sourceIngest?: SourceIngest | null;
  /** Ohjaamon viimeisin YouTube-havainto kohteesta eli selostetusta
   *  lähetyksestä (#250), tai null kun sitä ei juuri nyt pollata. Valinnainen
   *  samasta syystä kuin `sourceIngest`: kenttä lisättiin olemassa olevaan
   *  sopimukseen. */
  targetIngest?: TargetIngest | null;
  job: Job | null;
  /** Ohjaamon työ ja ajossa oleva relay ovat eri otteluista (#118), tai null
   *  kun ristiriitaa ei ole.
   *
   *  Oma kenttänsä eikä datasta pääteltävä (#202): palvelin nollaa
   *  `telemetry`n ja `narration`in juuri ristiriidassa, koska ne on luettu
   *  työn ottelulla eli väärän. Selain päätteli ristiriidan siitä samasta
   *  telemetriasta, joten hälytysrivi ei voinut koskaan näkyä — kummassakaan
   *  haarassa. Ristiriita on tieto, ei sivutuote, ja se on kannettava
   *  sellaisena.
   *
   *  Valinnainen kuten `sourceIngest`: kenttä lisättiin olemassa olevaan
   *  sopimukseen. */
  conflict?: { job: number; running: number } | null;
  /** What the relay says about itself, or null when it has published nothing
   *  for this match (not started, or a deploy older than PR #93). */
  telemetry: RelayTelemetry | null;
  /** Read from the relay's timeline, oldest first. */
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

/** Yksi teko, jonka ohjaamo teki ajon päätyttyä (#187).
 *
 *  Teot ovat operaattorin kieltä ja mennyttä aikamuotoa — ne kertovat mitä
 *  KONE teki, ei mitä ihmisen pitäisi tehdä (#171: "teot näkyviin UI:hin").
 *  Epäonnistunut teko on ainoa, joka kääntyy käskyksi: silloin lähetys jäi
 *  päälle, ja sen sulkeminen jää operaattorille. */
export interface JobCleanupAction {
  /** Teko sellaisena kuin se tapahtui: "Selostettu lähetys suljettiin." */
  what: string;
  ok: boolean;
  /** Käskymuotoinen jatko kun teko ei mennyt läpi; null kun meni. Ei koskaan
   *  YouTuben raakaa virhettä — se kuuluu lokiin ja huoltoarkkiin (#176). */
  detail: string | null;
}

/** Mitä ajon päättyessä havaittiin ja tehtiin (#187).
 *
 *  Kirjoitetaan työhön silloin kun ajo suljetaan, ja se on nimenomaan tieto
 *  siitä että **siivous on tehty** — sitä ei voi päätellä työn tilasta, koska
 *  `finished` syntyy jo ennen kuin YouTubelle on puhuttu. Päättymispush (#174)
 *  odottaa tätä kenttää, ja tilakortti näyttää sen sisällön sellaisenaan.
 *
 *  Tyhjä `actions` EI ole puuttuva siivous vaan tavallisin lopputulos:
 *  normaalissa lopetuksessa ohjaamo ei kosketa lähetyksiin lainkaan. */
export interface JobCleanup {
  at: string;
  /** Riippumattomat päättymisindikaattorit (#171): relayn oma lopetussyy,
   *  raakalähetyksen tila ja tulospalvelun kirjaus ovat eri lähteitä, ja
   *  operaattorin on nähtävä MISTÄ lopetus pääteltiin — yksi indikaattori on
   *  arvaus, kolme on havainto. */
  indicators: string[];
  actions: JobCleanupAction[];
}

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
  /** Set when the job took the broadcast slot ("arming"). Distinct from
   *  createdAt because a job is routinely created hours before it is armed, and
   *  the reconciler has to tell "armed a minute ago, relay about to start" from
   *  "armed yesterday, nobody ever started it" (#118). */
  armedAt: string | null;
  /** Set when the relay ran, for the post-run report. */
  startedAt: string | null;
  endedAt: string | null;
  /** Ajon päätyttyä: mitä havaittiin ja mitä tehtiin (#187). `null` = ajo on
   *  yhä kesken, TAI se päättyi ohjaamon ollessa alhaalla eikä kukaan ollut
   *  katsomassa. Jälkimmäinen on rehellinen tyhjä, ei virhe — mutta silloin
   *  päättymispushiakaan ei lähetetä, koska siivouksesta ei ole näyttöä. */
  cleanup: JobCleanup | null;
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
  /** Operaattori kytki vahdin nimenomaan POIS (#208).
   *
   *  Ero on olennainen: "ei vielä päällä" on tila, jonka ohjaamo saa korjata
   *  itse (käynnistysvahti tekee sen, #185), mutta "kytkettiin pois" on
   *  päätös, ja sen ohittaminen tarkoittaisi ettei käsiajoa voi suojata
   *  automatiikalta lainkaan — juuri sen säännön, jonka takia ajastin on
   *  oletuksena pois päältä. */
  disabledByOperator: boolean;
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
  /** Operaattorin kieltä: ei env-avainten nimiä, ei tiedostopolkuja, ei stream
   *  keytä (#176). Korjattu este kerrotaan tekona ("Korjattiin: …"), operaattoria
   *  vaativa käskymuodossa. */
  detail: string;
  /** Tosi kun ohjaamo korjasi tämän itse tällä ajolla. Rakenteinen tieto eikä
   *  vain "Korjattiin:"-alkuinen lause, koska käyttöliittymä nostaa korjatut
   *  rivit esiin siinä missä esteetkin: kunnossa oleva rivi katoaisi muuten
   *  muiden kunnossa olevien joukkoon, eikä teko jäisi näkyviin (#171, #176). */
  fixed?: boolean;
  /** Sama havainto sellaisena kuin preflight sen tuotti — raaka virhe, env-avain,
   *  polku. Vianetsintää varten, ja se kuuluu VAIN huoltopintaan (#176/9): ihmiset
   *  eivät käytä SSH:ta, joten tekninen totuus on oltava jossain UI:ssa, mutta ei
   *  ottelupäivän polulla. Puuttuu kun operaattorin lause on jo sama teksti. */
  technical?: string;
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
