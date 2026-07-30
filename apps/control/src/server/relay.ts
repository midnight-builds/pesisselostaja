/** Relay lifecycle seen from the OUTSIDE: systemd unit state, the `.env.relay`
 *  the unit reads at start, and the live control file the running loop re-reads
 *  every poll.
 *
 *  Nothing here imports apps/broadcast for behaviour, and nothing here may
 *  assume the relay is running our code: the service runs from the pinned
 *  deploy at ~/relay-deploy, which can sit on an older commit than this file
 *  (issue #59). So we only touch the two contact surfaces that are part of the
 *  relay's stable operator contract — the env file and the control file — and
 *  otherwise just observe.
 *
 *  `run/` and `.env.relay` are symlinked from this checkout into the deploy, so
 *  the paths below point at the working copy and still hit the exact files the
 *  live relay uses. */

import { execFile } from "node:child_process";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_NARRATION_DELAY_MS } from "../../../broadcast/src/config.js";
import type { ControlKnobs, Job, RelayProcess, SourceIngest } from "../shared/types.js";
import { CONFIG } from "./config.js";

// execFile, never exec: every argument below is fixed, but matchIds and paths
// flow in from HTTP requests and a shell would turn one bad string into command
// injection on the box that runs the broadcast.
const run = promisify(execFile);

/** Env keys that belong to ONE match and are rewritten per job.
 *  Everything else in `.env.relay` — notably ELEVENLABS_API_KEY and
 *  RELAY_URL_REFRESH_MS — is operator configuration that outlives the match and
 *  must survive untouched (relay-ottelu runbook, kohta 3). */
const MATCH_SCOPED_ENV_KEYS = [
  "RELAY_MATCH_ID",
  "RELAY_YOUTUBE_URL",
  "RELAY_STREAM_KEY",
  "RELAY_RTMP_URL",
] as const;

/** Mirrors apps/broadcast/src/config.ts. These are what the relay uses when
 *  nothing overrides them — but only until the relay starts: on startup it
 *  writes the control file from its OWN resolved config (env/CLI beat these),
 *  so before a run these are a prediction and during a run the file is truth. */
const KNOB_DEFAULTS: ControlKnobs = {
  announceBatterChanges: true, // config.ts: on unless RELAY_ANNOUNCE_BATTER_CHANGES=false
  narrationDelayMs: DEFAULT_NARRATION_DELAY_MS, // imported, so it can't drift from the relay's default
  deltaFetch: true, // config.ts: on unless RELAY_DELTA_FETCH=false
  pollIntervalMs: 3000, // config.ts default poll interval
};

/** Same floor commentaryLoop.ts applies (MIN_POLL_INTERVAL_MS). Clamping here
 *  too means the UI shows the value the relay will actually use instead of the
 *  one we asked for. */
const MIN_POLL_INTERVAL_MS = 2000;
/** Not a relay limit — a control-app policy, so a stuck slider or a fat finger
 *  can't push narration minutes behind the picture. */
const MAX_POLL_INTERVAL_MS = 60_000;
const MIN_NARRATION_DELAY_MS = 0;
const MAX_NARRATION_DELAY_MS = 15_000;

// ---------------------------------------------------------------- unit state

async function showUnitProperties(): Promise<Map<string, string>> {
  // One `show` call for all three properties: is-active + a timestamp + the
  // restart count in three separate calls would race each other on a flapping
  // unit and render an inconsistent row.
  const { stdout } = await run("systemctl", [
    "--user",
    "show",
    CONFIG.relayUnit,
    "-p",
    "ActiveState,ActiveEnterTimestamp,NRestarts",
  ]);
  const props = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return props;
}

/** systemd prints e.g. "Tue 2026-07-28 07:06:47 UTC", and an empty string when
 *  the unit has never been active. Anything unparseable becomes null rather
 *  than NaN, so the UI shows "—" instead of "NaN min". */
function uptimeSecFrom(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const enteredMs = Date.parse(timestamp);
  if (!Number.isFinite(enteredMs)) return null;
  return Math.max(0, Math.round((Date.now() - enteredMs) / 1000));
}

/** Which commit the pinned deploy (~/relay-deploy) is on. Read-only: we only
 *  ask git, because that hash is the one thing that tells a post-match report
 *  what code the broadcast actually ran. */
async function deployedCommit(): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", CONFIG.deployDir, "log", "-1", "--format=%h"]);
    return stdout.trim() || null;
  } catch {
    // Deploy missing or not a git checkout: a nuisance for the report, never a
    // reason to fail the whole live view.
    return null;
  }
}

export async function getRelayProcess(): Promise<RelayProcess> {
  const [props, commit] = await Promise.all([showUnitProperties(), deployedCommit()]);
  const activeState = props.get("ActiveState") ?? "unknown";
  const restarts = Number(props.get("NRestarts"));
  return {
    activeState,
    // "activating" counts as up: the unit is mid-start, and calling that "down"
    // would fire the "relay is dead mid-broadcast" alarm every single start.
    active: activeState === "active" || activeState === "activating",
    uptimeSec: uptimeSecFrom(props.get("ActiveEnterTimestamp")),
    deployedCommit: commit,
    nRestarts: Number.isFinite(restarts) ? restarts : null,
  };
}

/** Kuinka tuore `status-<id>.json` on vielä todiste siitä mitä relay ajaa.
 *  Telemetria kirjoitetaan suunnilleen pollivälin tahdissa (3 s oletuksena),
 *  joten minuutti on kymmeniä kirjoituksia — mutta silti niin lyhyt, että
 *  sammuneen relayn jälki ei jää elämään. */
const STATUS_FRESH_MS = 60_000;

const STATUS_FILE = /^status-(\d+)\.json$/;

/** Mitä ottelua relay OIKEASTI ajaa juuri nyt, tai `null` kun siitä ei ole
 *  tuoretta näyttöä.
 *
 *  Lähteenä relayn oma telemetria, koska relay on ainoa joka tietää tämän
 *  (CLAUDE.md, "yksi totuuslähde"): systemd kertoo vain että jokin ajaa, ja
 *  `.env.relay` kertoo mitä ottelua relaylle on TARKOITUS antaa — se
 *  kirjoitetaan jo aktivoinnissa, ennen relayn uudelleenkäynnistystä, joten se
 *  on ennuste eikä havainto. Aktivoinnin ja restartin välissä ne osoittavat eri
 *  otteluun.
 *
 *  Tuoreus mtimestä eikä tiedoston sisällöstä: sisältö on relayn sopimusta,
 *  mtime on käyttöjärjestelmän, ja tässä riittää tietää että kirjoituksia yhä
 *  tulee. */
export async function readRunningMatchId(nowMs: number = Date.now()): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir(CONFIG.relayRunDir);
  } catch {
    // Hakemistoa ei ole (tuore kone) tai sitä ei saa luettua: ei näyttöä.
    return null;
  }

  let newest: { matchId: number; mtimeMs: number } | null = null;
  for (const name of names) {
    const m = name.match(STATUS_FILE);
    if (!m) continue;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(CONFIG.relayRunDir, name))).mtimeMs;
    } catch {
      continue; // poistettiin altamme
    }
    // Negatiivinen ikä = kello on siirtynyt taaksepäin (NTP-korjaus,
    // suspendista herääminen). Tuoreena pitäminen on turvallisempi tulkinta
    // kuin "relay ei aja mitään": väärä hylkäys sokeuttaisi pollerin.
    if (nowMs - mtimeMs > STATUS_FRESH_MS) continue;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { matchId: Number(m[1]), mtimeMs };
  }
  return newest?.matchId ?? null;
}

async function systemctlVerb(verb: "start" | "stop" | "restart"): Promise<RelayProcess> {
  await run("systemctl", ["--user", verb, CONFIG.relayUnit]);
  return getRelayProcess();
}

export async function startRelay(): Promise<RelayProcess> {
  return systemctlVerb("start");
}

/** Stopping mid-match kills a live broadcast — uptime is the top priority, so
 *  the confirmation for this lives in the UI, not here. */
export async function stopRelay(): Promise<RelayProcess> {
  return systemctlVerb("stop");
}

export async function restartRelay(): Promise<RelayProcess> {
  return systemctlVerb("restart");
}

// ------------------------------------------------------------------ env file

/** Kasvava juokseva numero tmp-tiedostojen nimiin. Pelkkä pid ei riitä: saman
 *  prosessin kaksi rinnakkaista kirjoitusta (operaattorin klikkaus ja lähteen
 *  tilan polleri) osuisivat samaan tmp-nimeen, jolloin toinen kirjoittaisi
 *  toisen puskurin päälle ennen renamea. */
let tmpCounter = 0;

/** Writes a file by rename, so a reader (systemd's EnvironmentFile=, the
 *  relay's own control-file read) never sees a half-written file. The temp file
 *  is created next to the target so the rename stays on one filesystem. */
async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${++tmpCounter}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

/** Rewrites one key in place, preserving position, and understands the runbook's
 *  convention of leaving a key commented out (`#RELAY_MATCH_ID=`) after a match
 *  is cleaned up. Without the `#?` a fresh job would append a duplicate line and
 *  leave the commented placeholder above it as a permanent booby trap. */
function setEnvKey(lines: string[], key: string, value: string | null): string[] {
  const pattern = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const replacement = value ? `${key}=${value}` : `#${key}=`;
  let replaced = false;
  const out = lines.map((line) => {
    if (replaced || !pattern.test(line)) return line;
    replaced = true;
    return replacement;
  });
  if (!replaced) out.push(replacement);
  return out;
}

/** Points `.env.relay` at one job. Only the four match-scoped keys move; every
 *  other line — comments included — is carried over verbatim, because this file
 *  also holds the ElevenLabs key and the operator's URL-refresh choice, and
 *  regenerating it from a template has already been the way those got lost. */
export async function writeRelayEnv(job: Job): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(CONFIG.relayEnvPath, "utf8");
  } catch {
    // No file yet (fresh box): start from empty and let the keys append.
  }
  const values: Record<(typeof MATCH_SCOPED_ENV_KEYS)[number], string | null> = {
    RELAY_MATCH_ID: String(job.matchId),
    RELAY_YOUTUBE_URL: job.sourceUrl,
    RELAY_STREAM_KEY: job.targetStreamKey,
    RELAY_RTMP_URL: job.targetRtmpUrl,
  };

  let lines = existing.split("\n");
  // A trailing newline leaves an empty last element; drop it so appended keys
  // don't land after a blank line, then restore it at the end.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const key of MATCH_SCOPED_ENV_KEYS) lines = setEnvKey(lines, key, values[key]);

  // 0600: this file holds a YouTube stream key and the ElevenLabs API key.
  await writeFileAtomic(CONFIG.relayEnvPath, `${lines.join("\n")}\n`, 0o600);
}

// -------------------------------------------------------------- control file

/** `run/.control-<matchId>.json` — the relay re-reads it every poll, so a write
 *  here takes effect within one poll interval without a restart. */
export function controlFilePath(matchId: number): string {
  return join(CONFIG.relayRunDir, `.control-${matchId}.json`);
}

/** Kolme eri asiaa, jotka aiemmin olivat kaikki `{}`: tiedostoa ei ole,
 *  tiedosto on mutta ei jäsenny, tiedosto on ja jäsentyy.
 *
 *  Ero on merkityksellinen vain kirjoittajille. Relayn käynnistyskirjoitus ei
 *  ole atominen (commentaryLoop.ts kirjoittaa suoraan kohteeseen), joten
 *  "ei jäsenny" on käytännössä aina kesken oleva kirjoitus — ja siitä
 *  tilanteesta merge tyhjästä pyyhkisi juuri kirjoitetut säätöavaimet. */
type ControlRead =
  | { state: "ok"; raw: Record<string, unknown> }
  | { state: "missing" }
  | { state: "corrupt"; message: string };

async function readControlFileState(matchId: number): Promise<ControlRead> {
  let text: string;
  try {
    text = await readFile(controlFilePath(matchId), "utf8");
  } catch {
    // Ei tiedostoa = relay ei ole vielä käynnistynyt tälle ottelulle.
    return { state: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "corrupt", message: "sisältö ei ole objekti" };
    }
    return { state: "ok", raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { state: "corrupt", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Lukupää niille joille rikkinäinen tiedosto tarkoittaa samaa kuin puuttuva:
 *  oletusarvot, ei koskaan poikkeusta — tilanäkymän on jatkettava piirtämistä. */
async function readControlFile(matchId: number): Promise<Record<string, unknown>> {
  const current = await readControlFileState(matchId);
  return current.state === "ok" ? current.raw : {};
}

/** Sarjallistaa KAIKKI control-tiedoston lue-muokkaa-kirjoita-operaatiot yhden
 *  ketjun läpi, samalla kuviolla kuin store.ts:n update().
 *
 *  Mitä tämä estää: kaksi rinnakkaista kirjoitusta lukevat molemmat saman
 *  vanhan tiedoston, kumpikin liittää siihen oman avaimensa ja kirjoittaa koko
 *  objektin — jälkimmäinen rename pyyhkii ensimmäisen muutoksen. Ennen tätä
 *  vaihetta kirjoittajia oli käytännössä vain yksi (operaattorin klikkaus),
 *  mutta 30 s välein kirjoittava lähteen tilan polleri tekee törmäyksestä
 *  rutiinin: hukattu päivitys olisi joko kadonnut säätö tai kadonnut
 *  sourceIngest.
 *
 *  Globaali eikä per matchId: kirjoituksia on muutama minuutissa, joten
 *  ottelukohtainen ketju olisi pelkkää kirjanpitoa ilman mitattavaa hyötyä. */
let controlChain: Promise<unknown> = Promise.resolve();

function serializeControlWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = controlChain.then(fn);
  // Ketju itse ei saa koskaan jäädä hylätyksi, tai jokainen sen jälkeen
  // jonoon tullut kirjoitus perisi saman virheen ikuisesti. Kutsuja näkee
  // oman virheensä palautetusta promisesta.
  controlChain = next.catch(() => undefined);
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function knobsFromRaw(raw: Record<string, unknown>): ControlKnobs {
  return {
    announceBatterChanges:
      typeof raw.announceBatterChanges === "boolean"
        ? raw.announceBatterChanges
        : KNOB_DEFAULTS.announceBatterChanges,
    narrationDelayMs:
      typeof raw.narrationDelayMs === "number" && Number.isFinite(raw.narrationDelayMs)
        ? clamp(raw.narrationDelayMs, MIN_NARRATION_DELAY_MS, MAX_NARRATION_DELAY_MS)
        : KNOB_DEFAULTS.narrationDelayMs,
    deltaFetch: typeof raw.deltaFetch === "boolean" ? raw.deltaFetch : KNOB_DEFAULTS.deltaFetch,
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number" && Number.isFinite(raw.pollIntervalMs)
        ? clamp(raw.pollIntervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS)
        : KNOB_DEFAULTS.pollIntervalMs,
  };
}

export async function readKnobs(matchId: number): Promise<ControlKnobs> {
  return knobsFromRaw(await readControlFile(matchId));
}

/** Partial write: the file is merged, not replaced. Two reasons — the relay
 *  ignores absent keys and keeps its current value for them (so a full rewrite
 *  from stale UI state would silently revert someone's other change), and phase
 *  B adds keys (mute, volume) that this build knows nothing about and must not
 *  drop.
 *
 *  Rikkinäinen tiedosto EI estä tätä kirjoitusta, toisin kuin
 *  writeSourceIngestiä: tämä on operaattorin tahallinen komento kesken
 *  lähetyksen ("selostus pois"), ja sen on mentävä läpi vaikka tiedoston
 *  entinen sisältö olisi lukukelvoton. Havainnon julkaisu taas voi odottaa
 *  seuraavan kierroksen. */
export function writeKnobs(matchId: number, patch: Partial<ControlKnobs>): Promise<ControlKnobs> {
  return serializeControlWrite(() => writeKnobsUnlocked(matchId, patch));
}

/** Itse lue-muokkaa-kirjoita, ILMAN lukitusta. Erillään siksi, että
 *  nudgeDelay tarvitsee luvun ja kirjoituksen saman lukituksen sisällä — jos se
 *  kutsuisi lukitsevaa writeKnobsia, se jäisi odottamaan omaa ketjuvuoroaan. */
async function writeKnobsUnlocked(
  matchId: number,
  patch: Partial<ControlKnobs>
): Promise<ControlKnobs> {
  const raw = await readControlFile(matchId);
  const merged: Record<string, unknown> = { ...raw };
  if (patch.announceBatterChanges !== undefined) {
    merged.announceBatterChanges = patch.announceBatterChanges;
  }
  if (patch.narrationDelayMs !== undefined) {
    merged.narrationDelayMs = clamp(
      patch.narrationDelayMs,
      MIN_NARRATION_DELAY_MS,
      MAX_NARRATION_DELAY_MS
    );
  }
  if (patch.deltaFetch !== undefined) merged.deltaFetch = patch.deltaFetch;
  if (patch.pollIntervalMs !== undefined) {
    merged.pollIntervalMs = clamp(patch.pollIntervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  }

  await writeFileAtomic(
    controlFilePath(matchId),
    `${JSON.stringify(merged, null, 2)}\n`,
    // 0644 like the relay's own writeControlFile — no secrets here, and the
    // file is meant to be readable from a shell while debugging.
    0o644
  );
  return knobsFromRaw(merged);
}

/** The ±500 ms buttons. Relative, not absolute, because calibration happens by
 *  ear mid-broadcast ("speech is ahead of the picture → nudge up") and the
 *  operator should never have to know the current number to make it better. */
export function nudgeDelay(matchId: number, deltaMs: number): Promise<ControlKnobs> {
  // Luku ja kirjoitus saman lukituksen sisällä: muuten kaksi peräkkäistä
  // +500-painallusta voisivat lukea saman lähtöarvon ja tuottaa yhden askeleen
  // kahden sijaan.
  return serializeControlWrite(async () => {
    const current = knobsFromRaw(await readControlFile(matchId));
    const next = clamp(
      current.narrationDelayMs + deltaMs,
      MIN_NARRATION_DELAY_MS,
      MAX_NARRATION_DELAY_MS
    );
    return writeKnobsUnlocked(matchId, { narrationDelayMs: next });
  });
}

// ------------------------------------------------------- lähteen tila (#104)

/** Julkaisee ohjaamon YouTube-havainnon lähteestä samaan control-tiedostoon
 *  kuin säädöt. Merge-kirjoitus kuten writeKnobs: tiedosto on relayn oma, ja
 *  koko objektin korvaaminen pudottaisi säätöavaimet.
 *
 *  Vaiheessa 1 tällä ei ole kuluttajaa — relay ohittaa tuntemattoman avaimen
 *  sellaisenaan, joten julkaisu on turvallista ottaa käyttöön ennen kuin
 *  mikseri osaa lukea sen. */
export function writeSourceIngest(matchId: number, ingest: SourceIngest): Promise<void> {
  return serializeControlWrite(async () => {
    const current = await readControlFileState(matchId);
    if (current.state === "corrupt") {
      // Emme korvaa tiedostoa jota emme ymmärrä. Relayn käynnistyskirjoitus ei
      // ole atominen, joten jäsentymätön sisältö on lähes aina kesken oleva
      // kirjoitus — merge tyhjästä jättäisi tiedostoon PELKÄN sourceIngestin,
      // jolloin readKnobs palauttaisi oletukset, UI näyttäisi väärät säätöarvot
      // ja nudgeDelay laskisi väärästä perustasosta. Havainto ei ole sen
      // arvoinen: polleri yrittää uudelleen 30 s päästä.
      throw new Error(`control-tiedosto ei jäsenny (${current.message}) — havaintoa ei kirjoitettu`);
    }
    const raw = current.state === "ok" ? current.raw : {};
    const merged: Record<string, unknown> = { ...raw, sourceIngest: ingest };
    await writeFileAtomic(controlFilePath(matchId), `${JSON.stringify(merged, null, 2)}\n`, 0o644);
  });
}

/** Sopimuksen lukupää. Ohjaamon oma tilarivi ei tarvitse tätä (polleri pitää
 *  havainnon muistissa), mutta testit ja levyltä debuggaus tarvitsevat — ja
 *  kirjoitettu jäsennin dokumentoi mitä vaiheen 2 relayn on kestettävä:
 *  puuttuva avain, väärä tyyppi ja rikkinäinen JSON ovat kaikki `null`, eivät
 *  virheitä. */
export async function readSourceIngest(matchId: number): Promise<SourceIngest | null> {
  const raw = (await readControlFile(matchId)).sourceIngest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.observedAt !== "string" || typeof value.videoId !== "string") return null;
  // Aikaleima jota ei voi jäsentää ei ole havainto: tuoreutta ei voi arvioida,
  // ja jäsentymätön arvo läpäisisi kaikki vertailut "ei vanha" -tulkinnalla.
  if (!Number.isFinite(Date.parse(value.observedAt))) return null;
  const optional = (key: string): string | null =>
    typeof value[key] === "string" ? (value[key] as string) : null;
  return {
    observedAt: value.observedAt,
    videoId: value.videoId,
    lifeCycleStatus: optional("lifeCycleStatus"),
    streamStatus: optional("streamStatus"),
    healthStatus: optional("healthStatus"),
    error: optional("error"),
  };
}
