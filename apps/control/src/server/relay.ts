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
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_NARRATION_DELAY_MS } from "../../../broadcast/src/config.js";
import type { ControlKnobs, Job, RelayProcess } from "../shared/types.js";
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

/** Writes a file by rename, so a reader (systemd's EnvironmentFile=, the
 *  relay's own control-file read) never sees a half-written file. The temp file
 *  is created next to the target so the rename stays on one filesystem. */
async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
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

async function readControlFile(matchId: number): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(controlFilePath(matchId), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Missing file = the relay hasn't started for this match yet; a half-written
    // one = we caught someone else's edit. Both mean "fall back to defaults",
    // never "throw" — the live view must keep rendering.
    return {};
  }
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
 *  drop. */
export async function writeKnobs(
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
export async function nudgeDelay(matchId: number, deltaMs: number): Promise<ControlKnobs> {
  const current = await readKnobs(matchId);
  const next = clamp(
    current.narrationDelayMs + deltaMs,
    MIN_NARRATION_DELAY_MS,
    MAX_NARRATION_DELAY_MS
  );
  return writeKnobs(matchId, { narrationDelayMs: next });
}
