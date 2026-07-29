import { spawn, type ChildProcess } from "node:child_process";
import { logDebug, logError, logInfo, logWarn } from "./log.js";
import { NarrationFifo } from "./narrationFifo.js";
import { resolveSourceUrl, SourceNotLiveYetError } from "./ytdlpSource.js";
import type { NoSignalSlate, SlateLayout, SlateTextStyle } from "./noSignalSlate.js";
import {
  classifyFfmpegFailure,
  createStderrTail,
  describeFailureSide,
  hasWeakTargetSignal,
  redactStreamKey,
  type FfmpegFailureSide,
} from "./ffmpegDiagnostics.js";

/** Ohjaamon (apps/control) YouTube-API-havainto LÄHTEEN syötteestä, julkaistuna
 *  control-tiedoston `sourceIngest`-avaimeen (PR #112). Kentät ovat raakoja
 *  API-arvoja: päätös kuuluu relaylle, ei ohjaamolle. */
export interface SourceIngestObservation {
  /** Havaintohetki, ISO. */
  observedAt: string;
  videoId: string;
  /** liveBroadcasts.list: created|ready|testing|live|complete|revoked. */
  lifeCycleStatus: string | null;
  /** liveStreams.list: created|ready|active|inactive|error. VAIN "active"
   *  tarkoittaa että dataa virtaa sisään; null on "ei tietoa". */
  streamStatus: string | null;
  healthStatus: string | null;
  error: string | null;
}

/** Katvekuvan tekstisisältö sellaisena kuin selostussilmukka sen antaa:
 *  molemmat rivit VALMIIKSI muotoiltuina. Mikseri ei tunne pesäpallon
 *  sääntöjä — se vain näyttää nämä ja lisää tilanneriville sen teknisen
 *  puolen (miksi kuva puuttuu), jota selostussilmukka puolestaan ei voi
 *  tietää. Tyhjä merkkijono = riviä ei näytetä. */
export interface SlateSituation {
  /** Esim. "Pesä Ysit 12 - 1 Espoon Pesis". */
  score: string;
  /** Esim. "1. jakso, 2 paloa". */
  situation: string;
}

/** Kolme sanamuotoa tilannerivin tekniselle puolelle (issue #104:n kommentti).
 *  "selostus jatkuu" on koko kuvan tärkein teksti: se kertoo katsojalle ettei
 *  lähetystä kannata sulkea. Älä pudota sitä pois. */
export const SLATE_REASON_LOST = "kuvayhteys katkesi, selostus jatkuu";
export const SLATE_REASON_WAITING = "kuvayhteyttä odotetaan — selostus jatkuu";
export const SLATE_REASON_RECONNECTING = "yhdistetään uudelleen — selostus jatkuu";

/** Kuinka kauan lähteen on oltava poissa ennen kuin katvekuva menee päälle.
 *  Issuen vaatimus: "hetkellinen sekunnin blippi ei saa vilkuttaa katvekuvaa,
 *  vasta esimerkiksi 5-10 s katko laukaisee sen." */
const DEFAULT_SLATE_AFTER_MS = 8000;

/** Paljonko katvesession ffmpegille annetaan aikaa kuolla, ensin SIGTERMistä ja
 *  sitten SIGKILListä. Kumpikin odotus on pakko olla rajattu — mutta yhtä
 *  tärkeää on ettei purku palaa kuolemattoman prosessin päälle: seuraava
 *  lähdesessio työntää samaan RTMP-avaimeen. Ks. endSlateSession. */
const SLATE_KILL_GRACE_MS = 5000;

/** Kuinka vanha ohjaamon `sourceIngest`-havainto saa olla. Signaali saapuu jopa
 *  30 s myöhässä, joten raja on reilusti sen yli mutta silti niin tiukka ettei
 *  ottelun alussa nähty "live" jää selittämään ottelun loppua. */
const SOURCE_INGEST_MAX_AGE_MS = 120_000;

export interface FfmpegMixerOptions {
  youtubeUrl: string;
  rtmpUrl: string;
  streamKey: string;
  narrationGain: number;
  fifoPath: string;
  /** Force a respawn on this cadence even if ffmpeg looks healthy, so a
   *  rotated source URL gets picked up (default 15 min). */
  urlRefreshMs?: number;
  /** Give up and stop retrying after this many milliseconds of unbroken
   *  unproductive attempts — a start-up failure, or a session that died in
   *  under minProductiveRunMs — which protects against retrying forever once
   *  the source broadcast has genuinely ended (default 5 min). */
  maxFailureWindowMs?: number;
  /** Shorter give-up window used in place of maxFailureWindowMs while
   *  isMatchFinished() reports true — after "Ottelu päättyi" a dead source
   *  won't come back, so waiting the full generous window only delays
   *  cleanup (default 2 min). Applies to the same unproductive-attempt
   *  accounting. */
  finishedFailureWindowMs?: number;
  /** Shortest ffmpeg run that counts as the source actually producing
   *  broadcast (default 60 s). A session that ends sooner is counted as a
   *  failed attempt even when ffmpeg exited cleanly with code=0 — see
   *  minProductiveRunMs below / issue #45. */
  minProductiveRunMs?: number;
  /** Lets the supervisor know the match has ended (the commentary loop owns
   *  that state), for finishedFailureWindowMs. Absent → always false. */
  isMatchFinished?: () => boolean;
  /** Extra fragment appended to the heartbeat line — the commentary loop's
   *  poll statistics (HANDOFF.md 17.7.), since 304 skips and full-fetch
   *  fallbacks are otherwise invisible in the log. Absent → plain heartbeat. */
  heartbeatExtra?: () => string;
  /** Local-file test mode: write the mixed result to this path instead of
   *  pushing RTMP, so the mix can be reviewed before a second broadcast
   *  exists. Takes precedence over rtmpUrl/streamKey when set. Each spawn
   *  gets its own session-indexed filename (foo.mp4 -> foo.session0.mp4,
   *  foo.session1.mp4, …) since every respawn starts a fresh ffmpeg process
   *  that would otherwise overwrite (-y) the previous session's recording. */
  recordFile?: string;
  /** Test-only: when set, skips resolveSourceUrl/yt-dlp entirely and calls
   *  this instead to get the -i source for each spawn attempt (a function,
   *  not a static string, so a harness can vary the source per respawn —
   *  e.g. a longer fixture on one respawn to test amix's short-session
   *  behaviour). The source is read with -re (native rate) rather than the
   *  production reconnect/http-persistent flags, since those are HTTP/HLS-
   *  specific and meaningless (at best) against a local file. Never set in
   *  production — see apps/broadcast/docs/adr/0001-ffmpeg-mixer-test-source-seam.md. */
  resolveTestSource?: () => Promise<string> | string;
  /** Test-only: fired with the wall-clock epoch once a session's FIFO
   *  handshake completes, so a harness can align its own timers to actual
   *  session boundaries instead of parsing log text. */
  onSessionStart?: (epochMs: number) => void;
  /** Test-only: fired once a session's ffmpeg process has exited. */
  onSessionEnd?: (epochMs: number, ranMs: number) => void;
  /** Test-only: spawns the mixing process in place of ffmpeg, given the exact
   *  argv the real ffmpeg would have received. Lets a test drive the whole
   *  supervisor loop — FIFO handshake, session accounting, respawn, give-up —
   *  with a stand-in process whose lifetime and exit code it controls, without
   *  any ffmpeg binary or real broadcast. Never set in production; see
   *  apps/broadcast/docs/adr/0002-ffmpeg-mixer-process-seam.md. */
  spawnMixerProcess?: (args: string[]) => ChildProcess;
  /** Katvekuva ("EI SIGNAALIA", issue #104): kun lähdettä ei saada kiinni,
   *  RTMP-työntöä jatketaan still-kuvalla ja selostus jatkuu sen päällä.
   *  Absent/null — tai `available === false` — = katvetila pois, eli
   *  TÄSMÄLLEEN nykyinen käytös. Oletuksena pois (RELAY_NO_SIGNAL_SLATE):
   *  tämä on uusi ffmpeg-polku joka ajaa nimenomaan silloin kun lähetys on jo
   *  vaikeuksissa, eikä sitä ole koeteltu livenä. */
  slate?: NoSignalSlate | null;
  /** Kynnysaika ennen katvekuvan käynnistystä (oletus DEFAULT_SLATE_AFTER_MS). */
  slateAfterMs?: number;
  /** Ohjaamon havainto lähteen syötteestä (control-tiedoston `sourceIngest`).
   *  Vapaaehtoinen tulo: absent/null = ei tietoa = nykyinen käytös. Ks.
   *  freshSourceIngest siitä, miksi tämä ei koskaan laukaise katvetilaa. */
  sourceIngest?: () => SourceIngestObservation | null;
}

/** A finished ffmpeg session, as reported back to the supervisor loop. */
interface SessionResult {
  /** Monotonic milliseconds from spawn to process exit. */
  ranMs: number;
  /** Which side ffmpeg blamed, read off its stderr tail — null when the tail
   *  doesn't say. Only used for wording; never for the give-up decision, which
   *  stays purely about whether the run produced broadcast. */
  failureSide: FfmpegFailureSide;
  /** True when the tail held only ambiguous write-side noise. */
  weakTarget: boolean;
  /** True when *we* ended the session on purpose (scheduled URL refresh), so
   *  its length says nothing about the source's health. */
  refreshKill: boolean;
}

/** foo.mp4 -> foo.session3.mp4, so successive respawns never overwrite each
 *  other's recording. Exported so a test harness can compute the exact same
 *  filename FfmpegMixer wrote, without duplicating the naming rule. */
export function indexedRecordPath(recordFile: string, index: number): string {
  const m = recordFile.match(/^(.*?)(\.[^./]+)?$/);
  const base = m?.[1] ?? recordFile;
  const ext = m?.[2] ?? "";
  return `${base}.session${index}${ext}`;
}

/** Shared amix/limiter graph: original audio (input 0) + gained narration
 *  (input 1) -> [aout]. Used both by the live RTMP mixer and simulate.ts's
 *  offline replay, so the two stay acoustically identical.
 *
 *  alimiter needs `level=disabled`: with ffmpeg's default `level=enabled` the
 *  filter re-normalizes the limited signal back up, which measured +0.85 dBTP
 *  over the limit in field-audio tests (issue #56) — i.e. the limiter defeated
 *  its own purpose. */
export function buildMixFilterComplex(narrationGain: number): string {
  return (
    `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[orig];` +
    `[1:a]volume=${narrationGain}[narr];` +
    `[orig][narr]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=disabled[aout]`
  );
}

/** Katvetilan äänigraafi: pelkkä selostus, koska lähdeääntä (`[0:a]`) ei ole.
 *
 *  Sama gain ja sama `alimiter=limit=0.95:level=disabled` kuin
 *  buildMixFilterComplexissa, jotta äänenvoimakkuus ei hyppää siirtymässä
 *  lähteestä katteeseen ja takaisin. `level=disabled` samasta syystä kuin
 *  siellä (issue #56). */
export function buildSlateMixFilterComplex(narrationGain: number): string {
  return `[1:a]volume=${narrationGain},alimiter=limit=0.95:level=disabled[aout]`;
}

/** Escapeus filtterigraafin arvokenttään menevälle polulle (kuva, fontit,
 *  tekstitiedostot).
 *
 *  Merkeillä `: , ; [ ] \` ja `'` on merkitys -filter_complexin sisällä, ja
 *  merkkijono kulkee KAHDEN jäsentimen läpi (graafitaso ja filtterin
 *  optiotaso). Siitä syntyy epäintuitiivinen sääntö, joka on todennettu
 *  kokeellisesti tämän koneen ffmpeg 6.1:llä: kolme kenoviivaa erikoismerkin
 *  edessä kelpaa kaikille näistä, ja kenoviiva itse tarvitsee neljä. Yksi
 *  kenoviiva riittäisi vain graafitason merkeille (`, ; [ ]`) eikä kelpaisi
 *  kaksoispisteelle lainkaan. Shell-tasoa ei ole: argumentit menevät
 *  spawn()ille taulukkona, ei komentorivinä.
 *
 *  Tekstien sisältöä ei tarvitse escapeta: ne tulevat tiedostosta
 *  (`textfile` + `reload`), eivät filtterimerkkijonosta. */
export function escapeFilterPath(path: string): string {
  let out = path.replace(/\\/g, "\\\\\\\\");
  for (const ch of [":", ",", ";", "[", "]", "'"]) {
    out = out.split(ch).join("\\\\\\" + ch);
  }
  return out;
}

/** Ruutunopeus katvekuvalle. Still-kuva ei tarvitse enempää, ja matala arvo
 *  pitää enkoodauskuorman olemattomana juuri silloin kun kone hoitaa myös
 *  syntetisointia. */
const SLATE_FRAMERATE = 10;
/** Avainkuva ~2 s välein annetulla ruutunopeudella. */
const SLATE_GOP_FRAMES = SLATE_FRAMERATE * 2;

/** Kaksi drawtextiä (pisterivi, tilannerivi) tekstitiedostoista `reload`illa,
 *  jotta sisältö päivittyy ILMAN respawnia — `-loop 1 -i kuva.png` -syötteen
 *  vaihtaminen vaatisi ffmpegin uudelleenkäynnistyksen, eli näkyvän katkon
 *  jokaisesta pistemuutoksesta. */
export function buildSlateVideoFilter(
  layout: SlateLayout,
  scoreTextPath: string,
  statusTextPath: string
): string {
  const line = (fontFile: string, textFile: string, style: SlateTextStyle): string =>
    `drawtext=fontfile=${escapeFilterPath(fontFile)}:textfile=${escapeFilterPath(textFile)}:reload=1:` +
    // expansion=none: drawtextin oletus (`normal`) TULKITSEE tekstin, eikä
    // tulosta sitä. Joukkueen nimessä oleva `%` tuottaa silloin "Stray %"
    // -virheen JOKA KEHYKSELLÄ (~10 riviä/s journaldiin koko katkon ajan) ja
    // pudottaa loput rivistä pois. Nimet tulevat tulospalvelusta eikä niitä
    // validoi mikään, joten tämä ei ole teoreettinen.
    `expansion=none:` +
    // x ei saa mennä negatiiviseksi: ylileveä rivi leikkautuisi MOLEMMISTA
    // reunoista, eli molemmista joukkueiden nimistä katoaisi merkkejä.
    // NoSignalSlate katkaisee rivin mittaan, mutta tämä on halpa varmistus.
    `x=max(0\\,(w-text_w)/2):y=${style.y}:fontsize=${style.size}:fontcolor=${style.color}`;
  return (
    `[0:v]${line(layout.fontBold, scoreTextPath, layout.score)},` +
    `${line(layout.fontRegular, statusTextPath, layout.status)}[vout]`
  );
}

/** Paths + layout the slate arg builder needs. Otetaan erillisenä oliona
 *  eikä NoSignalSlate-instanssina, jotta argumenttien rakentaminen on
 *  testattavissa ilman generaattoria. */
export interface SlateInputs {
  imagePath: string;
  scoreTextPath: string;
  statusTextPath: string;
  layout: SlateLayout;
}

/** Katvetilan ffmpeg-argumentit. Sama RTMP-kohde / tallennustiedosto ja sama
 *  FIFO-syöte kuin lähdeversiolla; erot ovat still-kuvasyötteessä,
 *  äänigraafissa ja siinä että video on pakko ENKOODATA. */
export function buildSlateFfmpegArgs(
  slate: SlateInputs,
  opts: FfmpegMixerOptions,
  recordFilePath: string | undefined
): string[] {
  const args = [
    "-nostdin", "-y", "-loglevel", "warning", "-thread_queue_size", "4096",
    // -re on pakollinen: ilman sitä ffmpeg tuottaisi still-kuvasta kehyksiä
    // niin nopeasti kuin ehtii ja juoksisi FIFOn reaaliaikaisen
    // selostuskellon ohi sekunneissa.
    "-loop", "1", "-framerate", String(SLATE_FRAMERATE), "-re",
    "-i", slate.imagePath,
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-thread_queue_size", "4096",
    "-i", opts.fifoPath,
    "-filter_complex",
    `${buildSlateVideoFilter(slate.layout, slate.scoreTextPath, slate.statusTextPath)};` +
      buildSlateMixFilterComplex(opts.narrationGain),
    "-map", "[vout]", "-map", "[aout]",
    // `-c:v copy` EI toimi still-kuvalle — se on pakko enkoodata. stillimage-
    // tune ja veryfast pitävät kuorman pienenä, eikä liikkumattomaan kuvaan
    // kannata tuhlata bitrateä.
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
    "-pix_fmt", "yuv420p", "-g", String(SLATE_GOP_FRAMES),
    "-b:v", "1200k", "-maxrate", "1500k", "-bufsize", "2400k",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  ];
  if (recordFilePath) {
    args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", recordFilePath);
  } else {
    const rtmpDest = `${opts.rtmpUrl.replace(/\/$/, "")}/${opts.streamKey}`;
    args.push("-f", "flv", rtmpDest);
  }
  return args;
}

function buildFfmpegArgs(
  sourceUrl: string,
  opts: FfmpegMixerOptions,
  recordFilePath: string | undefined,
  realtimeSource: boolean
): string[] {
  const args = ["-nostdin", "-y", "-loglevel", "warning", "-thread_queue_size", "4096"];
  if (realtimeSource) {
    // Test-only local-file source (see resolveTestSource): without -re
    // ffmpeg reads the file as fast as disk/CPU allow instead of at its real
    // playback rate, which would collapse the "frozen DVR window" cadence
    // we're deliberately reproducing and desync it from the FIFO's
    // real-time narration clock.
    args.push("-re");
  } else {
    // SOURCE input only (options apply to the -i that follows). The source is a
    // YouTube HLS pull, and YouTube rotates the CDN host inside the playlist;
    // ffmpeg's default -http_persistent 1 then tries to reuse a keepalive
    // connection against a different host, fails, and floods the log with
    // "Cannot reuse HTTP connection for different host" + "keepalive request
    // failed … retrying" every ~5s segment. Disabling persistent HTTP silences
    // that with no functional downside (source stayed real-time in testing);
    // the reconnect flags harden the pull against brief source blips.
    args.push(
      "-http_persistent", "0",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"
    );
  }
  args.push(
    "-i", sourceUrl,
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-thread_queue_size", "4096",
    "-i", opts.fifoPath,
    "-filter_complex", buildMixFilterComplex(opts.narrationGain),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  );
  if (recordFilePath) {
    // Fragmented mp4 stays playable even if the process is killed mid-write
    // (no trailing moov atom to lose), unlike a plain -f mp4 output.
    args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", recordFilePath);
  } else {
    const rtmpDest = `${opts.rtmpUrl.replace(/\/$/, "")}/${opts.streamKey}`;
    args.push("-f", "flv", rtmpDest);
  }
  return args;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Monotonic milliseconds. Every *duration* the supervisor measures uses this
 *  rather than Date.now(): an NTP step backwards would otherwise make a
 *  healthy hour-long session look like a seconds-long failed one (→ false
 *  self-shutdown), and a step forwards could blow through the give-up window
 *  in one tick. Wall-clock time is kept only where an actual epoch is reported
 *  outward (firstAttachedAt, onSessionStart/onSessionEnd). */
function monoNow(): number {
  return performance.now();
}

/** How often to emit a liveness line during an otherwise quiet healthy run,
 *  so a long eventless stretch is distinguishable from a hang in the logs. */
const HEARTBEAT_MS = 2 * 60 * 1000;

/** Thrown once resolveSourceUrl/ffmpeg-start has failed continuously for too
 *  long — signals the original broadcast is gone for good (not a transient
 *  network blip), so the caller should stop retrying and shut the relay down
 *  instead of hammering yt-dlp every 30s forever. */
export class SourceExhaustedError extends Error {}

/** Total time a merely-*scheduled* source may keep not starting before the
 *  relay gives up anyway. Waiting is the right default — YouTube is telling us
 *  the broadcast exists — but an unbounded wait would leave a forgotten relay
 *  polling yt-dlp for days if the broadcaster silently cancels. */
const SCHEDULED_WAIT_MAX_MS = 3 * 60 * 60 * 1000;
/** Re-check cadence while waiting for a scheduled start: aim to land ~20 s
 *  before the announced time, but never sleep longer than this (YouTube's
 *  estimate moves, and a far-off start shouldn't mean hammering yt-dlp). */
const SCHEDULED_RECHECK_MAX_MS = 5 * 60 * 1000;
const SCHEDULED_RECHECK_MIN_MS = 5000;
/** Cadence once yt-dlp stops naming a time ("This live event will begin in a
 *  few moments"). That wording is not a far-off start — it is the last thing
 *  yt-dlp says before the stream actually goes live, so it must be the
 *  *tightest* poll we run, not the slackest.
 *
 *  This branch used to return SCHEDULED_RECHECK_MAX_MS, i.e. exactly backwards.
 *  Observed live in match 145889 on 29.7.2026: the countdown disappeared at
 *  08:28, the relay then slept the full 5 min, and ffmpeg attached only at
 *  08:33. The match start, IPV's first palo and both first-period runs were
 *  narrated into a FIFO nobody was reading — viewers joined at 0-2 having
 *  heard neither run. A wasted yt-dlp call every 20 s is far cheaper. */
const SCHEDULED_RECHECK_IMMINENT_MS = 20_000;
/** How long the imminent cadence may run before falling back to the slow cap.
 *  "A few moments" that outlasts this is a postponed broadcast rather than an
 *  imminent one, and polling hard for the remaining hours of
 *  SCHEDULED_WAIT_MAX_MS would only invite throttling. */
const IMMINENT_CADENCE_MAX_MS = 20 * 60 * 1000;

/** How long to wait before asking yt-dlp again about a scheduled source.
 *
 *  @param imminentForMs how long yt-dlp has been withholding a time already;
 *         0 whenever it is still naming one.
 */
export function scheduledRecheckDelayMs(startsInMs: number | null, imminentForMs = 0): number {
  if (startsInMs === null) {
    return imminentForMs >= IMMINENT_CADENCE_MAX_MS ? SCHEDULED_RECHECK_MAX_MS : SCHEDULED_RECHECK_IMMINENT_MS;
  }
  return Math.min(Math.max(startsInMs - 20_000, SCHEDULED_RECHECK_MIN_MS), SCHEDULED_RECHECK_MAX_MS);
}

function formatEta(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return mins >= 1 ? `${mins} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** Supervises the long-running ffmpeg pull+mix+republish process: resolves a
 *  fresh source URL and respawns with exponential backoff whenever ffmpeg
 *  exits (crash, source URL rotation, RTMP drop — ffmpeg has no automatic
 *  reconnect for the RTMP push side, so any exit means a full respawn). */
export class FfmpegMixer {
  private fifo: NarrationFifo;
  private child: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** When the current unbroken run of *unproductive* attempts began, or null
   *  if the source has since produced a real run. Used to give up after
   *  maxFailureWindowMs. An attempt is unproductive when it either never
   *  started (yt-dlp/ffmpeg start-up failure) or started and then ended in
   *  under minProductiveRunMs. A successful *start* on its own must never
   *  clear this: when the source device dies mid-match (issue #45) yt-dlp
   *  keeps handing out a valid URL, every spawn succeeds, and ffmpeg exits
   *  cleanly (code=0) seconds later — an endless respawn loop in which the
   *  old "reset on any successful spawn" rule meant the window never accrued
   *  and the relay never shut itself down. */
  private failingSince: number | null = null;
  private readonly maxFailureWindowMs: number;
  /** Shortest run that counts as the source actually producing broadcast.
   *  Chosen well above a respawn's start-up cost but well below any believable
   *  broadcast segment (the scheduled URL refresh runs every 15 min, and is
   *  exempt from this accounting anyway), because a false give-up mid-match is
   *  worse than a relay left standing. */
  private readonly minProductiveRunMs: number;
  /** Set while a kill we requested ourselves (URL refresh) is in flight, so
   *  the resulting short session isn't mistaken for a dying source. */
  private refreshKillRequested = false;
  /** Counts spawn attempts so recordFile can be indexed per session. */
  private sessionIndex = 0;
  /** True only while an ffmpeg session is attached as a FIFO reader (between a
   *  completed handshake and the process exiting). */
  private sessionActive = false;
  /** ffmpeg starts beyond the first one this run. A respawn is normal (URL
   *  rotation) but a climbing count is the clearest single number for "the
   *  picture is stuttering", which is otherwise only visible by reading the
   *  log. */
  private respawns = 0;
  private sourceStateValue: "live" | "scheduled" | "resolving" | "failed" | "unknown" = "unknown";
  private sourceDetailValue: string | null = null;
  /** True only while a katve (no-signal slate) ffmpeg session is pushing.
   *  Kept separate from sourceStateValue so telemetry can show the katve
   *  WITHOUT hiding why the source is missing — issuen rajaus "ei saa peittää
   *  ongelmaa operaattorilta". */
  private slateActive = false;
  /** Kertakytkin: katve on epäonnistunut kerran, eikä sitä yritetä enää tässä
   *  ajossa. Uusi ffmpeg-polku, joka ajaa nimenomaan silloin kun lähetys on jo
   *  vaikeuksissa, ei saa jäädä silmukkaan yrittämään itseään uudelleen. */
  private slateDisabled = false;
  /** Monotoninen hetki jolloin lähde viimeksi lakkasi olemasta kiinni; null
   *  kun ffmpeg on juuri nyt kiinni lähteessä. Katvetilan kynnys mitataan
   *  tästä — relayn OMASTA paikallisesta havainnosta, ei ohjaamon
   *  signaalista. */
  private sourceMissingSince: number | null = null;
  /** Onko lähde koskaan saatu kiinni tässä ajossa. Erottaa tilannerivin
   *  sanamuodot "kuvayhteys katkesi" ja "kuvayhteyttä odotetaan". */
  private hasHadSource = false;
  /** Tosi kun lähdeosoitetta juuri nyt selvitetään (yt-dlp käynnissä), eli
   *  katsojalle "yhdistetään uudelleen". */
  private probingSource = false;
  /** Selostussilmukan työntämät valmiit tekstirivit; tyhjät ennen kuin loop on
   *  antanut mitään (silloin kuvassa on pelkkä "EI SIGNAALIA" + alatunniste,
   *  mikä on kelvollinen lopputulos). */
  private slateSituation: SlateSituation = { score: "", situation: "" };
  /** Wall clock of the FIRST completed FIFO handshake ever, never reset —
   *  the commentary loop's first-speech grace period (RELAY_FIRST_SPEECH_DELAY_MS)
   *  is measured from this, so respawns don't restart the wait. */
  private firstAttachedAtMs: number | null = null;
  /** When the current unbroken run of "scheduled, not live yet" answers began,
   *  or null if the source has since responded some other way. Bounds the wait
   *  via SCHEDULED_WAIT_MAX_MS. */
  private scheduledSince: number | null = null;
  /** When yt-dlp last started withholding a start time, or null while it is
   *  still naming one. Bounds the imminent cadence via IMMINENT_CADENCE_MAX_MS.
   *  Separate from scheduledSince: a countdown that reappears is genuine new
   *  information from YouTube and earns a fresh imminent budget, without
   *  resetting the overall give-up window. */
  private imminentSince: number | null = null;

  constructor(private opts: FfmpegMixerOptions) {
    this.fifo = new NarrationFifo(opts.fifoPath);
    this.maxFailureWindowMs = opts.maxFailureWindowMs ?? 5 * 60 * 1000;
    this.minProductiveRunMs = opts.minProductiveRunMs ?? 60 * 1000;
  }

  enqueueNarration(pcm: Buffer): void {
    this.fifo.enqueue(pcm);
  }

  /** True while ffmpeg is attached and reading the FIFO, i.e. queued narration
   *  actually drains in real time. The commentary loop reads this to avoid
   *  synthesizing pre-game filler nobody would hear yet — otherwise those
   *  welcome clips pile up in the FIFO before ffmpeg attaches and all play
   *  back-to-back on connect (HANDOFF.md 7). */
  /** Telemetry accessors. Read-only views of state the supervisor already
   *  keeps — nothing here changes a decision. */
  get respawnCount(): number {
    return this.respawns;
  }

  /** `no_signal` = katvekuvaa työnnetään juuri nyt. Se on oma tilansa eikä
   *  korvaa sourceDetailia, joka kertoo yhä miksi lähde puuttuu. */
  get sourceState(): "live" | "scheduled" | "resolving" | "failed" | "unknown" | "no_signal" {
    return this.slateActive ? "no_signal" : this.sourceStateValue;
  }

  get sourceDetail(): string | null {
    return this.sourceDetailValue;
  }

  /** Selostussilmukka työntää valmiit tekstirivit tänne (index.ts, pollin
   *  tahdissa). Mikseri ei laske pisteitä eikä paloja itse. */
  setSlateSituation(situation: SlateSituation): void {
    this.slateSituation = situation;
    this.refreshSlateText();
  }

  get isReaderAttached(): boolean {
    return this.sessionActive;
  }

  /** Narration clips still waiting in the FIFO queue (not yet handed to the
   *  write stream). */
  get pendingClips(): number {
    return this.fifo.pendingClips;
  }

  /** Wall clock of the first time ffmpeg ever attached as a FIFO reader, or
   *  null before that. Never reset across respawns. */
  get firstAttachedAt(): number | null {
    return this.firstAttachedAtMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Lähde on "poissa" siihen asti kunnes se ensi kertaa saadaan kiinni, joten
    // ennen ottelua käynnistetty relay näyttää katsojalle "kuvayhteyttä
    // odotetaan" kynnysajan jälkeen sen sijaan että työntö olisi tauolla.
    if (this.sourceMissingSince === null) this.sourceMissingSince = monoNow();
    // Katvetilan aikana löytynyt lähdeosoite annetaan suoraan seuraavalle
    // spawnOnce-kutsulle, jottei yt-dlp:tä ajeta kahdesti peräkkäin.
    let preResolved: string | undefined;
    while (!this.stopped) {
      try {
        const session = await this.spawnOnce(preResolved);
        preResolved = undefined;
        this.scheduledSince = null;
        this.imminentSince = null;
        if (this.stopped) break;
        this.noteSessionEnd(session);
      } catch (err) {
        preResolved = undefined;
        // Our own give-up verdict (from noteSessionEnd above) passes straight
        // through: it is not a start-up failure, and letting it fall into the
        // handling below would log "ffmpeg-käynnistysvirhe" and replace the
        // real reason with the misleading "Lähde ei ole vastannut" wording,
        // even though ffmpeg started every single time.
        if (err instanceof SourceExhaustedError) throw err;
        // A broadcast scheduled to start later is not a failure: YouTube is
        // confirming the source exists. Counting those answers toward the
        // give-up window is what forced starting the relay in a narrow slot
        // just before kickoff (observed live 27.7.) — wait instead.
        if (err instanceof SourceNotLiveYetError) {
          const waitMs = this.noteScheduledAnswer(err);
          preResolved = await this.waitBeforeNextAttempt(waitMs);
          continue;
        }
        this.scheduledSince = null;
        this.imminentSince = null;
        this.sourceStateValue = "failed";
        this.sourceDetailValue = err instanceof Error ? err.message : String(err);
        logError("ffmpeg.start_failed", `ffmpeg-käynnistysvirhe: ${err instanceof Error ? err.message : err}`);
        this.noteUnproductiveAttempt((mins) => `Lähde ei ole vastannut ${mins} minuuttiin`);
      }
      if (this.stopped) break;
      logInfo("ffmpeg.respawn", `Uudelleenyritys ${this.backoffMs}ms kuluttua…`);
      preResolved = await this.waitBeforeNextAttempt(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    }
  }

  /** Kirjanpito ja lokitus "lähde alkaa myöhemmin" -vastaukselle; palauttaa
   *  kuinka kauan seuraavaan tarkistukseen. Heittää SourceExhaustedErrorin kun
   *  odotus on venynyt yli SCHEDULED_WAIT_MAX_MS:n.
   *
   *  Omana metodinaan siksi, että katvetilan oma koetin käyttää TÄSMÄLLEEN
   *  samaa kirjanpitoa kuin päälooppi: katvekuvan työntäminen ei saa muuttaa
   *  luovutusehtoja millään tavalla. */
  private noteScheduledAnswer(err: SourceNotLiveYetError): number {
    if (this.scheduledSince === null) this.scheduledSince = monoNow();
    if (monoNow() - this.scheduledSince > SCHEDULED_WAIT_MAX_MS) {
      this.stopped = true;
      throw new SourceExhaustedError(
        `Lähde on ollut "alkaa pian" -tilassa yli ${Math.round(SCHEDULED_WAIT_MAX_MS / 3600000)} h ` +
          "eikä ole alkanut — luovutetaan."
      );
    }
    this.failingSince = null;
    this.backoffMs = 1000; // fresh backoff for when it does go live
    if (err.startsInMs === null) {
      if (this.imminentSince === null) this.imminentSince = monoNow();
    } else {
      this.imminentSince = null;
    }
    const waitMs = scheduledRecheckDelayMs(
      err.startsInMs,
      this.imminentSince === null ? 0 : monoNow() - this.imminentSince
    );
    const eta = err.startsInMs === null ? "" : ` — alkaa noin ${formatEta(err.startsInMs)} kuluttua`;
    this.sourceStateValue = "scheduled";
    this.sourceDetailValue = err.startsInMs === null
      ? "alkaa hetkenä minä hyvänsä"
      : `alkaa noin ${formatEta(err.startsInMs)} kuluttua`;
    logInfo("source.not_live", `Lähde ei ole vielä livenä${eta}. Tarkistetaan uudelleen ${Math.round(waitMs / 1000)} s kuluttua.`);
    return waitMs;
  }

  /** Odottaa seuraavaan lähdeyritykseen. Kun katvetila on perusteltu, odotus
   *  vietetään katvekuvaa työntäen; muuten käytös on täsmälleen entinen eli
   *  pelkkä uni. Palauttaa katvetilan aikana löytyneen lähdeosoitteen, jotta
   *  seuraava spawnOnce ei aja yt-dlp:tä uudelleen. */
  private async waitBeforeNextAttempt(waitMs: number): Promise<string | undefined> {
    if (!this.slateWarranted()) {
      await this.interruptibleDelay(waitMs);
      return undefined;
    }
    try {
      return (await this.runSlateSession(waitMs)) ?? undefined;
    } catch (err) {
      // Luovutus on relayn oma tuomio ja menee läpi sellaisenaan. Kaikki MUU
      // katveketjun vika (FIFO, spawn, siivous) johtaa nykyiseen käytökseen:
      // katve pois, yksi varoitusrivi, respawn-silmukka jatkaa. Valvoja ei saa
      // kaatua siihen että katvekuva epäonnistui.
      if (err instanceof SourceExhaustedError) throw err;
      this.disableSlate(err instanceof Error ? err.message : String(err));
      await this.interruptibleDelay(waitMs);
      return undefined;
    }
  }

  /** Judges a finished ffmpeg session: a run long enough to be real broadcast
   *  clears the give-up window (and the backoff). A session that died right
   *  after starting counts as a failed attempt no matter how cleanly ffmpeg
   *  exited — that is exactly the shape of a source whose broadcast has ended
   *  abnormally while yt-dlp still resolves a URL (issue #45).
   *
   *  Order matters: the productive-run check comes FIRST, so a healthy session
   *  that happens to end in our own scheduled URL refresh still clears the
   *  window. In production every healthy session ends that way (urlRefreshMs
   *  15 min > maxFailureWindowMs 12 min), so treating a refresh kill as
   *  neutral up front would mean a once-set failingSince never cleared again
   *  and the next brief blip would shut a perfectly healthy relay down
   *  mid-match. refreshKill only excuses a SHORT session: there the kill, not
   *  the source, is why the run was short. */
  private noteSessionEnd(session: SessionResult): void {
    if (session.ranMs >= this.minProductiveRunMs) {
      this.failingSince = null;
      this.backoffMs = 1000; // fresh backoff after a healthy run
      return;
    }
    if (session.refreshKill) return;
    logWarn(
      "ffmpeg.unproductive",
      `ffmpeg kuoli alle ${Math.round(this.minProductiveRunMs / 1000)} s käynnistyksestä — ` +
        "lasketaan epäonnistuneeksi yritykseksi (ei tuota lähetystä)."
    );
    // Which end to go and look at. Before this, a target that refused our push
    // (wrong stream key, another encoder on the same key) produced exactly the
    // same short sessions as a dead phone — and since the give-up window now
    // counts those, the relay would shut down blaming the source. The verdict
    // itself is unchanged; only the wording learns to name the other suspect.
    const hint = describeFailureSide(session.failureSide, session.weakTarget);
    if (hint) logWarn("ffmpeg.failure_side", hint);
    const sideNote =
      session.failureSide === "target"
        ? " (ffmpegin virheet viittasivat KOHTEESEEN, ei lähteeseen — tarkista stream key)"
        : "";
    this.noteUnproductiveAttempt(
      (mins) =>
        `Yritykset ovat kuolleet alle ${Math.round(this.minProductiveRunMs / 1000)} sekunnissa ` +
        `${mins} minuutin ajan${sideNote}`
    );
  }

  /** Records an attempt that produced no broadcast and gives up (throws
   *  SourceExhaustedError, which the caller turns into a relay shutdown) once
   *  the unbroken run of such attempts outlasts the give-up window. A finished
   *  match's source won't come back, so it uses the much shorter window
   *  (HANDOFF.md 16.7. kohta 6.2). */
  private noteUnproductiveAttempt(describe: (windowMins: number) => string): void {
    if (this.failingSince === null) this.failingSince = monoNow();
    const finished = this.opts.isMatchFinished?.() ?? false;
    const windowMs = finished
      ? (this.opts.finishedFailureWindowMs ?? 2 * 60 * 1000)
      : this.maxFailureWindowMs;
    if (monoNow() - this.failingSince > windowMs) {
      this.stopped = true;
      throw new SourceExhaustedError(
        `${describe(Math.round(windowMs / 60000))}${finished ? " ja ottelu on päättynyt" : ""} — luovutetaan.`
      );
    }
  }

  /** Sleeps in short slices so a stop() during a multi-minute scheduled wait
   *  is still honoured within a second — the plain backoff delay is capped at
   *  30 s and can afford to block, this one can't. */
  private async interruptibleDelay(ms: number): Promise<void> {
    const until = monoNow() + ms;
    while (!this.stopped && monoNow() < until) {
      await delay(Math.min(1000, until - monoNow()));
    }
  }

  stop(): void {
    this.stopped = true;
    this.sessionActive = false;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.fifo.stop();
    this.child?.kill("SIGTERM");
  }

  /** Yksi lähdeosoitteen selvitys. Omana metodinaan, jotta katvetilan koetin
   *  käyttää samaa polkua ja voi antaa löytämänsä osoitteen suoraan
   *  spawnOnce:lle. Heittää samat virheet kuin ennenkin. */
  private async resolveSource(): Promise<string> {
    this.probingSource = true;
    this.refreshSlateText();
    try {
      if (this.opts.resolveTestSource) return await this.opts.resolveTestSource();
      logInfo("source.resolving", "Haetaan lähdeosoite yt-dlp:llä…");
      this.sourceStateValue = "resolving";
      return await resolveSourceUrl(this.opts.youtubeUrl);
    } finally {
      this.probingSource = false;
      this.refreshSlateText();
    }
  }

  private async spawnOnce(preResolved?: string): Promise<SessionResult> {
    this.refreshKillRequested = false;
    const sourceUrl = preResolved ?? (await this.resolveSource());

    // Must exist before ffmpeg is spawned, and before fifo.open() (which
    // blocks until ffmpeg attaches as a reader) — see narrationFifo.ts.
    await this.fifo.prepare();

    if (this.sessionIndex > 0 || this.respawns > 0 || this.sourceStateValue === "live") this.respawns++;
    this.sourceStateValue = "live";
    this.sourceDetailValue = "ffmpeg käynnissä";
    logInfo("ffmpeg.starting", "Käynnistetään ffmpeg…");
    const recordFilePath = this.opts.recordFile
      ? indexedRecordPath(this.opts.recordFile, this.sessionIndex++)
      : undefined;
    const args = buildFfmpegArgs(sourceUrl, this.opts, recordFilePath, !!this.opts.resolveTestSource);
    this.child = this.opts.spawnMixerProcess
      ? this.opts.spawnMixerProcess(args)
      : spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    // Kept for the post-mortem below, and redacted on the way to the journal:
    // ffmpeg prints the output URL — stream key included — in its own error
    // lines (issue #51).
    const stderrTail = createStderrTail();
    const redact = (s: string) => redactStreamKey(s, this.opts.streamKey);
    this.child.stdout?.on("data", (d: Buffer) => process.stdout.write(redact(d.toString())));
    this.child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderrTail.push(text);
      process.stderr.write(redact(text));
    });

    // Covers both a normal exit and a failed spawn (bad binary/args): if
    // spawn() itself fails, Node emits "error" but never "exit", so without
    // this the supervisor would hang forever awaiting an exit that never
    // comes — no backoff, no log, stuck silently.
    const startedAt = monoNow();
    const childDone = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      this.child!.once("error", (err) => resolve({ code: null, signal: null, error: err }));
      this.child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const raceResult = await Promise.race([
      this.fifo.open().then(() => "opened" as const),
      childDone.then(() => "died" as const),
    ]);

    if (raceResult === "died") {
      // ffmpeg died before the FIFO handshake even completed — the pending
      // open() call will never get a reader now; drop it rather than await it.
      this.fifo.closeIo();
      const result = await childDone;
      const detail = result.error ? result.error.message : `code=${result.code}, signal=${result.signal}`;
      throw new Error(`ffmpeg ei käynnistynyt: ${detail}`);
    }

    this.sessionActive = true;
    // Lähde on kiinni: katvetilan kynnys nollautuu ja seuraavan katkon
    // sanamuoto on "kuvayhteys katkesi" eikä "kuvayhteyttä odotetaan".
    // Huom: tämä EI kosketa luovutusikkunaa (failingSince) — sen ainoa
    // tuomari on yhä noteSessionEnd.
    this.sourceMissingSince = null;
    this.hasHadSource = true;
    if (this.firstAttachedAtMs === null) this.firstAttachedAtMs = Date.now();
    this.opts.onSessionStart?.(Date.now());

    const refreshMs = this.opts.urlRefreshMs ?? 15 * 60 * 1000;
    const childForRefresh = this.child;
    this.refreshTimer = setTimeout(() => {
      void this.killForRefresh(childForRefresh);
    }, refreshMs);

    // Liveness heartbeat: during a healthy run with no pesäpallo events for
    // minutes there is otherwise nothing in the log, so "still alive" and
    // "silently hung" look identical. Cleared on exit below.
    const heartbeat = setInterval(() => {
      const up = Math.round((monoNow() - startedAt) / 1000);
      const extra = this.opts.heartbeatExtra?.();
      logDebug("ffmpeg.heartbeat", `Sydänääni: relay käynnissä ${up}s, selostusjonossa ${this.fifo.pendingClips} klippiä${extra ? `, ${extra}` : ""}.`);
    }, HEARTBEAT_MS);

    const result = await childDone;
    this.sessionActive = false;
    // Lähde irtosi juuri nyt — katvetilan kynnys alkaa tästä. Yksittäinen
    // respawn (URL-päivitys) ehtii uudelleen kiinni reilusti alle kynnysajan,
    // joten se ei vilkuta katvekuvaa.
    if (this.sourceMissingSince === null) this.sourceMissingSince = monoNow();
    clearInterval(heartbeat);
    this.fifo.closeIo();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const ranMs = monoNow() - startedAt;
    const detail = result.error ? result.error.message : `code=${result.code}, signal=${result.signal}`;
    logInfo("ffmpeg.exit", `ffmpeg päättyi (${detail}), ajoaika ${Math.round(ranMs / 1000)}s`);
    this.opts.onSessionEnd?.(Date.now(), ranMs);
    const failureSide = classifyFfmpegFailure(stderrTail.text());
    const weakTarget = hasWeakTargetSignal(stderrTail.text());
    // The caller judges the run (noteSessionEnd): backoff and give-up window
    // both hang off whether this was real broadcast, not off the exit code.
    return { ranMs, refreshKill: this.refreshKillRequested, failureSide, weakTarget };
  }

  /** Waits for a natural gap in the narration before killing ffmpeg for a
   *  scheduled URL refresh, so a respawn doesn't cut off a clip mid-word.
   *  ffmpeg crashes/RTMP drops still die immediately (unavoidable) — this
   *  only guards the respawn we schedule ourselves. Bounded so a refresh
   *  can't be postponed forever by back-to-back announcements. */
  private async killForRefresh(childToKill: ChildProcess | null): Promise<void> {
    if (!childToKill || childToKill !== this.child) return;
    const drain = await this.waitForNarrationGap(childToKill);
    if (!drain) return;
    logInfo(
      "ffmpeg.respawn",
      `Määräaikainen URL-päivitys — käynnistetään ffmpeg uudelleen. ` +
        `Selostusjono ${drain.status}; odotettiin ${drain.waitedMs}ms, jonossa ${drain.pendingAtStart} klippiä respawnin alkaessa.`
    );
    this.refreshKillRequested = true;
    childToKill.kill("SIGTERM");
  }

  /** Odottaa luonnollista taukoa selostuksessa ennen kuin `childToKill`
   *  tapetaan, jottei respawn katkaise klippiä kesken sanan. Palauttaa null kun
   *  odotus ei enää koske tätä prosessia (stop(), tai lapsi vaihtui alta), eli
   *  kutsujan ei pidä tappaa mitään.
   *
   *  Jaettu määräaikaisen URL-päivityksen ja katvesession lopetuksen kesken:
   *  molemmat ovat respawneja jotka me itse ajoitamme, ja kummassakin kesken
   *  lausetta katkaiseminen kuulostaa rikkinäiseltä. */
  private async waitForNarrationGap(
    childToKill: ChildProcess
  ): Promise<{ waitedMs: number; pendingAtStart: number; status: string } | null> {
    const pendingAtStart = this.fifo.pendingClips;
    const waitStart = monoNow();
    const deadline = waitStart + 10000;
    while (this.fifo.pendingClips > 0 && monoNow() < deadline && !this.stopped && this.child === childToKill) {
      await delay(200);
    }
    if (this.stopped || this.child !== childToKill) return null;
    // Give ffmpeg a moment to actually drain what's already sitting in the
    // pipe buffer before we pull it out from under it.
    await delay(500);
    if (this.stopped || this.child !== childToKill) return null;
    const remaining = this.fifo.pendingClips;
    // Whether the queue actually drained is the evidence that the respawn
    // didn't sever a clip mid-word (apps/broadcast/HANDOFF.md fix #2): "tyhjeni" =
    // clean gap, "EI tyhjentynyt" = the 10s bound cut it off anyway.
    const status =
      remaining === 0 ? "tyhjeni" : `EI tyhjentynyt (${remaining} klippiä jäljellä, 10s katkaisu)`;
    return { waitedMs: monoNow() - waitStart, pendingAtStart, status };
  }

  /** Ohjaamon havainto lähteen syötteestä, tai null kun tietoa ei ole.
   *
   *  Puuttuva, vanhentunut (yli SOURCE_INGEST_MAX_AGE_MS) tai jäsentymätön
   *  havainto tarkoittaa nimenomaan "EI TIETOA", ei "lähde poikki". Signaali
   *  saapuu jopa 30 s myöhässä ja riippuu ohjaamosta ja Google-yhteydestä,
   *  eikä lähetyksen käytös saa riippua kummastakaan. Siksi katvetilan
   *  LAUKAISIN on aina relayn oma paikallinen havainto (sourceMissingSince),
   *  ja tätä käytetään vain kahteen asiaan:
   *    (a) `lifeCycleStatus === "complete"` ⇒ lähde on päättynyt hallitusti,
   *        joten katvetilaan ei mennä lainkaan (lähetys päätetään),
   *    (b) tilannerivin sanamuodon tarkennus.
   *  Tulevaisuuteen jäänyt leima on yhtä epäluotettava kuin vanhentunut. */
  private freshSourceIngest(): SourceIngestObservation | null {
    let raw: SourceIngestObservation | null;
    try {
      raw = this.opts.sourceIngest?.() ?? null;
    } catch {
      return null; // lukijan virhe ei ole tieto lähteestä
    }
    if (!raw || typeof raw.observedAt !== "string") return null;
    const observedAt = Date.parse(raw.observedAt);
    if (!Number.isFinite(observedAt)) return null;
    const ageMs = Date.now() - observedAt;
    if (ageMs > SOURCE_INGEST_MAX_AGE_MS || ageMs < -SOURCE_INGEST_MAX_AGE_MS) return null;
    return raw;
  }

  /** Saako katvekuvan käynnistää juuri nyt. Estot ovat tärkeämpiä kuin
   *  ominaisuus itse — järjestys on käynnissä oleva lähetys > katvekuva:
   *
   *  1. **Ottelu on päättynyt** tai ohjaamon tuore havainto sanoo lähetyksen
   *     olevan `complete`: lähde on loppunut hallitusti, joten lähetys
   *     päätetään eikä jäädä työntämään väripalkkeja tyhjään lähetykseen
   *     (issuen oma rajaus).
   *  2. **Katve on jo kerran epäonnistunut** → ei yritetä uudelleen.
   *  3. **Kynnysaika**: hetkellinen respawn ei saa vilkuttaa katvekuvaa. */
  private slateWarranted(): boolean {
    const slate = this.opts.slate;
    if (!slate || this.slateDisabled || this.stopped) return false;
    if (!slate.available || !slate.layout) return false;
    if (this.opts.isMatchFinished?.() ?? false) return false;
    if (this.freshSourceIngest()?.lifeCycleStatus === "complete") return false;
    if (this.sourceMissingSince === null) return false;
    return monoNow() - this.sourceMissingSince >= (this.opts.slateAfterMs ?? DEFAULT_SLATE_AFTER_MS);
  }

  /** Tilannerivin tekninen puolisko — mitä katsojalle kerrotaan siitä, miksi
   *  kuvaa ei ole. Taso on tarkoituksella KATSOJALLE, ei operaattorille:
   *  respawnit ja poistumiskoodit kuuluvat lokiin ja ohjaamoon. */
  private slateReason(): string {
    if (this.probingSource) return SLATE_REASON_RECONNECTING;
    const ingest = this.freshSourceIngest();
    // created/ready/testing = lähetystä ei ole vielä aloitettu, vaikka relay
    // olisi jo kerran nähnyt kuvaa (esim. testilähetys ennen ottelua).
    if (ingest && ingest.lifeCycleStatus !== null && ingest.lifeCycleStatus !== "live") {
      return SLATE_REASON_WAITING;
    }
    return this.hasHadSource ? SLATE_REASON_LOST : SLATE_REASON_WAITING;
  }

  /** Kirjoittaa kuvan tekstirivit nykytilan mukaan. Halpa kutsua usein:
   *  NoSignalSlate kirjoittaa vain muuttuneen rivin. */
  private refreshSlateText(): void {
    const slate = this.opts.slate;
    if (!slate?.available) return;
    const reason = this.slateReason();
    const situation = this.slateSituation.situation.trim();
    slate.update({
      score: this.slateSituation.score.trim(),
      status: situation === "" ? reason : `${situation} — ${reason}`,
    });
  }

  /** Sammuttaa katvetilan lopullisesti tältä ajolta, yhdellä varoitusrivillä.
   *  Turvallisuusvaatimus: jos mikään katveketjun osa epäonnistuu, käytös on
   *  nykyinen — ei kaatumista, ei uudelleenyrityssilmukkaa. */
  private disableSlate(why: string): void {
    if (this.slateDisabled) return;
    this.slateDisabled = true;
    logWarn(
      "ffmpeg.slate_end",
      `Katvekuva pois käytöstä tältä ajolta (${why}) — jatketaan lähteen uudelleenyrityksillä kuten ennenkin.`
    );
  }

  /** Työntää katvekuvaa RTMP:hen (tai tallennustiedostoon) ja koettaa
   *  lähdettä samalla. Palauttaa lähdeosoitteen heti kun lähde ratkeaa, tai
   *  null kun katve päättyi ilman lähdettä.
   *
   *  Luovutusikkuna kulkee tämän läpi muuttumattomana: jokainen epäonnistunut
   *  koetin menee saman noteUnproductiveAttempt/noteScheduledAnswer
   *  -kirjanpidon läpi kuin päälooppi, joten SourceExhaustedError syntyy
   *  katvetilassa täsmälleen samalla hetkellä kuin ilman sitä. Katvekuvan
   *  työntäminen ei nollaa mitään eikä kelpaa "tuottavaksi ajoksi". */
  private async runSlateSession(initialWaitMs: number): Promise<string | null> {
    const slate = this.opts.slate;
    const layout = slate?.layout;
    if (!slate || !layout) {
      // Ei pitäisi tapahtua (slateWarranted tarkisti tämän), mutta paluu ilman
      // odotusta tekisi respawn-silmukasta tiukan CPU-silmukan.
      await this.interruptibleDelay(initialWaitMs);
      return null;
    }

    this.refreshSlateText();
    const recordFilePath = this.opts.recordFile
      ? indexedRecordPath(this.opts.recordFile, this.sessionIndex++)
      : undefined;
    const args = buildSlateFfmpegArgs(
      {
        imagePath: slate.imagePath,
        scoreTextPath: slate.scoreTextPath,
        statusTextPath: slate.statusTextPath,
        layout,
      },
      this.opts,
      recordFilePath
    );

    let child: ChildProcess;
    try {
      // Sama järjestys kuin lähdesessiossa: FIFO on oltava olemassa ennen
      // spawnia ja avattava vasta sen jälkeen (narrationFifo.ts).
      await this.fifo.prepare();
      child = this.opts.spawnMixerProcess
        ? this.opts.spawnMixerProcess(args)
        : spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.disableSlate(err instanceof Error ? err.message : String(err));
      await this.interruptibleDelay(initialWaitMs);
      return null;
    }
    this.child = child;
    const redact = (s: string): string => redactStreamKey(s, this.opts.streamKey);
    child.stdout?.on("data", (d: Buffer) => process.stdout.write(redact(d.toString())));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(redact(d.toString())));
    const childDone = new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
    let childAlive = true;
    void childDone.then(() => {
      childAlive = false;
    });

    const opened = await Promise.race([
      this.fifo.open().then(() => true),
      childDone.then(() => false),
    ]);
    if (!opened) {
      this.fifo.closeIo();
      this.child = null;
      this.disableSlate("ffmpeg ei käynnistynyt katvetilassa");
      await this.interruptibleDelay(initialWaitMs);
      return null;
    }

    this.slateActive = true;
    this.sessionActive = true;
    if (this.firstAttachedAtMs === null) this.firstAttachedAtMs = Date.now();
    logInfo(
      "ffmpeg.slate_start",
      "Katvekuva päälle: lähdettä ei ole saatu kiinni kynnysaikaan mennessä. " +
        "RTMP-työntö jatkuu ja selostus kuuluu kuvan päällä."
    );

    let waitMs = initialWaitMs;
    let resolvedUrl: string | null = null;
    let endReason = "pysäytettiin";
    try {
      while (!this.stopped && childAlive) {
        await this.sleepWhileSlateAlive(waitMs, () => childAlive);
        if (this.stopped) break;
        if (!childAlive) {
          // Katvetilan ffmpeg kuoli itsestään. Kertakytkin pois, jottei tästä
          // tule kaatumissilmukkaa juuri kun lähetys on jo vaikeuksissa.
          this.disableSlate("katvetilan ffmpeg kuoli kesken session");
          endReason = "ffmpeg kuoli katvetilassa";
          break;
        }
        // Katvetilan ehdot voivat muuttua kesken session: ottelu päättyy tai
        // ohjaamo kertoo lähetyksen olevan `complete`. Silloin katve puretaan
        // heti, jotta luovutus/sammutus etenee normaalisti.
        if (!this.slateStillAllowed()) {
          endReason = "lähde on päättynyt hallitusti";
          break;
        }
        try {
          resolvedUrl = await this.resolveSource();
          endReason = "lähde palasi";
          break;
        } catch (err) {
          if (err instanceof SourceNotLiveYetError) {
            waitMs = this.noteScheduledAnswer(err);
            continue;
          }
          this.scheduledSince = null;
          this.imminentSince = null;
          this.sourceStateValue = "failed";
          this.sourceDetailValue = err instanceof Error ? err.message : String(err);
          logError(
            "ffmpeg.start_failed",
            `Lähde ei vastannut katvetilassa: ${err instanceof Error ? err.message : err}`
          );
          // Tässä luovutusikkuna umpeutuu, jos on umpeutuakseen — heitetty
          // SourceExhaustedError kulkee finallyn kautta ulos ja lopettaa
          // sekä katveen että koko relayn.
          this.noteUnproductiveAttempt((mins) => `Lähde ei ole vastannut ${mins} minuuttiin`);
          waitMs = Math.min(Math.max(waitMs * 2, 1000), 30000);
        }
      }
    } finally {
      await this.endSlateSession(child, childAlive, childDone, endReason);
    }
    return resolvedUrl;
  }

  /** Katvetila pysäytetään heti kun sen ehdot lakkaavat pätemästä. Erillään
   *  slateWarranted():sta, koska kynnysaika koskee vain käynnistystä — kesken
   *  session sitä ei enää mitata. */
  private slateStillAllowed(): boolean {
    if (this.stopped) return false;
    if (this.opts.isMatchFinished?.() ?? false) return false;
    return this.freshSourceIngest()?.lifeCycleStatus !== "complete";
  }

  /** Purkaa katvesession: odottaa selostusjonon tyhjenemistä samalla kuviolla
   *  kuin killForRefresh (kesken lausetta katkaiseminen kuulostaa
   *  rikkinäiseltä), tappaa prosessin ja sulkee FIFOn niin että seuraava
   *  lähdesessio voi valmistella sen uudelleen. */
  private async endSlateSession(
    child: ChildProcess,
    childAlive: boolean,
    childDone: Promise<void>,
    reason: string
  ): Promise<void> {
    if (childAlive && this.child === child) {
      const drain = await this.waitForNarrationGap(child);
      if (drain) {
        logDebug(
          "ffmpeg.slate_end",
          `Katvekuva puretaan (${reason}); selostusjono ${drain.status}, odotettiin ${drain.waitedMs}ms.`
        );
      }
      child.kill("SIGTERM");
      // Katvesession on oltava VARMASTI kuollut ennen kuin tästä palataan:
      // seuraava vaihe spawnaa lähdesession samaan RTMP-avaimeen, ja kaksi
      // työntäjää yhtä aikaa katkaisee lähetyksen YouTuben päässä. Lähdepolku
      // ei tarvitse tätä, koska spawnOnce odottaa childDonea ennen paluuta —
      // katvepolku on ainoa joka lopettaa session itse valitsemallaan
      // hetkellä, joten eskalointi kuuluu tähän.
      const diedOnTerm = await Promise.race([
        childDone.then(() => true),
        delay(SLATE_KILL_GRACE_MS).then(() => false),
      ]);
      if (!diedOnTerm) {
        logWarn(
          "ffmpeg.slate_end",
          `Katvetilan ffmpeg ei kuollut ${SLATE_KILL_GRACE_MS} ms:ssa SIGTERMistä — SIGKILL, jottei kaksi työntäjää päädy samaan RTMP-avaimeen.`
        );
        child.kill("SIGKILL");
        const diedOnKill = await Promise.race([
          childDone.then(() => true),
          delay(SLATE_KILL_GRACE_MS).then(() => false),
        ]);
        if (!diedOnKill) {
          // SIGKILLin selvinnyt prosessi on ytimen tason poikkeama
          // (keskeytymätön uni). Katve pois lopullisesti: emme voi taata
          // ettei se yhä työnnä, joten sitä ei ainakaan yritetä uudelleen.
          this.disableSlate("katvetilan ffmpeg ei kuollut edes SIGKILListä");
        }
      }
    }
    this.slateActive = false;
    this.sessionActive = false;
    this.fifo.closeIo();
    if (this.child === child) this.child = null;
    logInfo("ffmpeg.slate_end", `Katvekuva pois: ${reason}.`);
  }

  /** Kuten interruptibleDelay, mutta herää heti myös jos katvesession ffmpeg
   *  kuolee alta — muuten hiljainen prosessi jäisi odottamaan koko
   *  koetinvälin ennen kuin katkosta huomattaisiin. */
  private async sleepWhileSlateAlive(ms: number, alive: () => boolean): Promise<void> {
    const until = monoNow() + ms;
    while (!this.stopped && alive() && monoNow() < until) {
      await delay(Math.min(200, until - monoNow()));
    }
  }
}
