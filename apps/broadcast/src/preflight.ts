import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { fetchMatchMetadata, fetchLiveEvents } from "@pesisselostaja/core";
import {
  isHlsManifestUrl,
  parseScheduledStart,
  parseSourceThrottled,
  ytdlpSourceArgs,
} from "./ytdlpSource.js";

const run = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

/** Free-space floor from the global operating rule: below this, stop rather
 *  than start anything that writes. */
const DISK_MIN_BYTES = 2 * 1024 * 1024 * 1024;
const DISK_MIN_FRACTION = 0.1;
/** One full match cost 4780 ElevenLabs characters (measured 27.7.). Warn below
 *  roughly one-and-a-half of those, so a run can't run dry mid-broadcast
 *  without notice — Piper still covers it, but the voice changes audibly. */
const ELEVENLABS_MIN_CHARS = 7000;

/** systemd applies EnvironmentFile= for the service; a hand-run preflight gets
 *  nothing. Without this, preflight would happily report "Piper" while the
 *  actual service run uses ElevenLabs — i.e. check one thing, run another. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const value = line.slice(eq + 1).trim();
    out[line.slice(0, eq).trim()] = value.replace(/^["'](.*)["']$/, "$1");
  }
  return out;
}

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

async function checkDisk(): Promise<Check> {
  const s = await statfs("/");
  const free = s.bavail * s.bsize;
  const total = s.blocks * s.bsize;
  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} Gt`;
  const detail = `${gb(free)} vapaana / ${gb(total)}`;
  if (free < DISK_MIN_BYTES || free / total < DISK_MIN_FRACTION) {
    return { name: "Levytila", status: "fail", detail: `${detail} — alle rajan, älä käynnistä` };
  }
  return { name: "Levytila", status: "ok", detail };
}

async function checkStrayProcesses(): Promise<Check> {
  try {
    const { stdout } = await run("pgrep", ["-af", "ffmpeg|apps/broadcast/src/index"]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.length
      ? { name: "Roikkuvat prosessit", status: "warn", detail: `${lines.length} kpl — tapa ennen käynnistystä` }
      : { name: "Roikkuvat prosessit", status: "ok", detail: "ei roikkuvia ajoja" };
  } catch {
    // pgrep exits 1 when nothing matches — that is the good case.
    return { name: "Roikkuvat prosessit", status: "ok", detail: "ei roikkuvia ajoja" };
  }
}

async function checkService(): Promise<Check> {
  try {
    const { stdout } = await run("systemctl", ["--user", "is-active", "pesisselostaja-relay.service"]);
    return {
      name: "Relay-palvelu",
      status: "warn",
      detail: `${stdout.trim()} — käynnissä oleva lähetys katkeaisi uudelleenkäynnistyksestä`,
    };
  } catch {
    return { name: "Relay-palvelu", status: "ok", detail: "inactive (odotettu)" };
  }
}

async function checkTool(name: string, bin: string, args: string[]): Promise<Check> {
  try {
    const { stdout, stderr } = await run(bin, args);
    const first = (stdout || stderr).trim().split("\n")[0].slice(0, 60);
    return { name, status: "ok", detail: first };
  } catch {
    return { name, status: "fail", detail: `${bin} ei vastaa — asenna tai korjaa PATH` };
  }
}

async function checkMatch(matchId: number, apiKey?: string, apiBase?: string): Promise<Check[]> {
  const opts = { apiKey, apiBase, timeoutMs: 8000 };
  const checks: Check[] = [];
  try {
    const meta = await fetchMatchMetadata(matchId, opts);
    checks.push({ name: "Ottelu", status: "ok", detail: `${meta.home.name} vs ${meta.away.name}` });
  } catch (err) {
    checks.push({
      name: "Ottelu",
      status: "fail",
      detail: `ID ${matchId} ei vastaa: ${err instanceof Error ? err.message : err}`,
    });
    return checks;
  }
  try {
    const events = await fetchLiveEvents(matchId, { ...opts, skipDelay: true });
    checks.push({
      name: "Tapahtumat",
      status: "ok",
      detail: events.events.length
        ? `${events.events.length} tapahtumaa jo kirjattu`
        : "0 tapahtumaa — ottelua ei ole vielä avattu (normaali ennen alkua)",
    });
  } catch (err) {
    checks.push({
      name: "Tapahtumat",
      status: "fail",
      detail: `events-haku kaatui: ${err instanceof Error ? err.message : err}`,
    });
  }
  return checks;
}

/** Resolves the source the same way the relay will, and classifies the three
 *  outcomes that actually matter before a broadcast: live and full quality,
 *  live but degraded, or scheduled for later. */
export async function checkSource(
  youtubeUrl: string,
  /** Test seam: runs yt-dlp with the given argv. Exists so a test can assert
   *  WHICH flags preflight passes without a network call — the drift this
   *  guards against (preflight resolving differently than the relay) is
   *  invisible to every other kind of test, and is what issue #249 was. */
  opts: { runYtdlp?: (args: string[]) => Promise<{ stdout: string }> } = {}
): Promise<Check> {
  const runYtdlp =
    opts.runYtdlp ?? ((args: string[]) => run("yt-dlp", args, { maxBuffer: 4 * 1024 * 1024 }));
  try {
    // Exactly the relay's own flags (ytdlpSourceArgs) — a preflight that asks a
    // different question than the relay will ask is worth nothing.
    const { stdout } = await runYtdlp(["-g", ...ytdlpSourceArgs(), youtubeUrl]);
    const url = stdout.trim().split("\n")[0];
    if (!url) return { name: "Lähde", status: "fail", detail: "yt-dlp ei palauttanut URLia" };
    return isHlsManifestUrl(url)
      ? { name: "Lähde", status: "ok", detail: "livenä, HLS-manifesti (täysi laatu)" }
      : {
          name: "Lähde",
          status: "warn",
          detail: "livenä, mutta EI HLS-manifestia — kuva menisi heikkolaatuisena",
        };
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "");
    const scheduled = parseScheduledStart(stderr);
    if (scheduled) {
      const eta = scheduled.startsInMs === null ? "" : ` (~${Math.round(scheduled.startsInMs / 60000)} min)`;
      return { name: "Lähde", status: "ok", detail: `ei vielä livenä, ajastettu alkavaksi${eta} — relay odottaa` };
    }
    const lastLine = stderr.trim().split("\n").at(-1) ?? String(err);
    // Says which END is in trouble. "Lähde ei vastaa" sends the operator after
    // the phone in the field; the truth here is that YouTube declined to answer
    // the relay, and the raakalähetys itself may be perfectly fine (#249).
    if (parseSourceThrottled(stderr)) {
      return {
        name: "Lähde",
        status: "fail",
        detail:
          "YouTube torjuu haun (bottitarkistus / 429) — raakalähetyksen omasta tilasta " +
          `ei tietoa. Kokeile toista player_clientiä RELAY_YTDLP_EXTRACTOR_ARGS:lla. ${lastLine}`,
      };
    }
    return { name: "Lähde", status: "fail", detail: lastLine };
  }
}

async function checkElevenLabs(apiKey?: string): Promise<Check> {
  if (!apiKey) return { name: "ElevenLabs", status: "warn", detail: "avainta ei ole — käytetään Piperiä" };
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { name: "ElevenLabs", status: "fail", detail: `avain ei kelpaa (HTTP ${res.status})` };
    const body = (await res.json()) as { character_count?: number; character_limit?: number };
    const left = (body.character_limit ?? 0) - (body.character_count ?? 0);
    const detail = `${left} merkkiä jäljellä (ottelu kuluttaa ~5000)`;
    return { name: "ElevenLabs", status: left < ELEVENLABS_MIN_CHARS ? "warn" : "ok", detail };
  } catch (err) {
    return { name: "ElevenLabs", status: "warn", detail: `kiintiötä ei saatu: ${err instanceof Error ? err.message : err}` };
  }
}

function checkTarget(env: Record<string, string>): Check {
  const key = process.env.RELAY_STREAM_KEY || env.RELAY_STREAM_KEY;
  const url = process.env.RELAY_RTMP_URL || env.RELAY_RTMP_URL;
  if (!key) return { name: "Kohde", status: "fail", detail: "RELAY_STREAM_KEY puuttuu — ei mihin pushata" };
  if (!url) return { name: "Kohde", status: "warn", detail: "RELAY_RTMP_URL puuttuu, käytetään oletusta" };
  return { name: "Kohde", status: "ok", detail: `${url} + stream key asetettu` };
}

export function summarize(checks: Check[]): { text: string; exitCode: number } {
  const lines = checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(20)} ${c.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    failed
      ? `${failed} este${failed === 1 ? "" : "ttä"} — älä käynnistä ennen kuin nämä on korjattu.`
      : warned
        ? `Ei esteitä, ${warned} huomautus${warned === 1 ? "" : "ta"} — lue yllä ja käynnistä harkiten.`
        : "Kaikki kunnossa — relay voidaan käynnistää."
  );
  return { text: lines.join("\n"), exitCode: failed ? 1 : 0 };
}

export async function runPreflight(envFilePath: string): Promise<Check[]> {
  const env = await loadEnvFile(envFilePath);
  const matchIdRaw = process.env.RELAY_MATCH_ID || env.RELAY_MATCH_ID;
  const youtubeUrl = process.env.RELAY_YOUTUBE_URL || env.RELAY_YOUTUBE_URL;
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;
  const apiKey = process.env.RELAY_API_KEY || env.RELAY_API_KEY;
  const apiBase = process.env.RELAY_API_BASE || env.RELAY_API_BASE;

  const checks: Check[] = [await checkDisk(), await checkStrayProcesses(), await checkService()];
  checks.push(await checkTool("yt-dlp", "yt-dlp", ["--version"]));
  checks.push(await checkTool("ffmpeg", "ffmpeg", ["-version"]));

  if (matchIdRaw) {
    checks.push(...(await checkMatch(Number(matchIdRaw), apiKey, apiBase)));
  } else {
    checks.push({ name: "Ottelu", status: "fail", detail: "RELAY_MATCH_ID puuttuu" });
  }
  checks.push(
    youtubeUrl
      ? await checkSource(youtubeUrl)
      : { name: "Lähde", status: "fail", detail: "RELAY_YOUTUBE_URL puuttuu" }
  );
  checks.push(checkTarget(env));
  checks.push(await checkElevenLabs(elevenLabsKey));
  return checks;
}
