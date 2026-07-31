/** Preflight for the control UI.
 *
 *  This module deliberately contains NO checks of its own. It calls
 *  apps/broadcast/src/preflight.ts as-is and only reshapes the result for the
 *  wire. A copied checklist would drift the moment someone adds a check to the
 *  relay's own preflight — and a drifted checklist is worse than none, because
 *  the phone would show green while the relay refuses to start.
 *
 *  Imported by relative path: @pesisselostaja/broadcast declares no entry
 *  points (no `main`/`exports` in its package.json), so it isn't importable by
 *  package name. tsx and tsc both resolve the `.js` specifier to the `.ts`
 *  source, and preflight.ts's own dependency (@pesisselostaja/core) is already a
 *  dependency of this app — so no package.json change is needed. */

import { readFile } from "node:fs/promises";

import { parseEnvFile, runPreflight, summarize, type Check } from "../../../broadcast/src/preflight.js";
import type { Job, PreflightCheck, PreflightResult } from "../shared/types.js";
import { CONFIG } from "./config.js";
import { notifyPreflightBlockers } from "./notifications.js";

/** Check and PreflightCheck have the same shape today; the mapping is explicit
 *  so a future field on either side breaks the typecheck instead of leaking. */
function toWireCheck(check: Check): PreflightCheck {
  return { name: check.name, status: check.status, detail: check.detail };
}

/** The one summary sentence, taken from the broadcast module's own summarize()
 *  rather than re-written here. summarize() returns the whole CLI report; its
 *  last non-empty line is the verdict ("Kaikki kunnossa — relay voidaan
 *  käynnistää." / "Ei esteitä, N huomautusta…" / "N estettä — älä käynnistä…").
 *  Reusing it means the phone and the terminal can never disagree about the
 *  wording, and pluralization stays in one place. */
function summaryLine(checks: Check[]): string {
  const lines = summarize(checks)
    .text.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** The keys `.env.relay` binds to one job (mirrors MATCH_SCOPED_ENV_KEYS in
 *  relay.ts) and what the job says each of them should be. */
function expectedBinding(job: Job): Record<string, string | null> {
  return {
    RELAY_MATCH_ID: String(job.matchId),
    RELAY_YOUTUBE_URL: job.sourceUrl,
    RELAY_STREAM_KEY: job.targetStreamKey,
    RELAY_RTMP_URL: job.targetRtmpUrl,
  };
}

/** Human name for each bound key, for the one line the operator reads. */
const BINDING_LABEL: Record<string, string> = {
  RELAY_MATCH_ID: "ottelu",
  RELAY_YOUTUBE_URL: "raakalähetys",
  RELAY_STREAM_KEY: "kohteen stream key",
  RELAY_RTMP_URL: "kohteen RTMP-osoite",
};

/** Does `.env.relay` point at the job the operator is looking at? (#155)
 *
 *  Every other check reads the env file and reports what it finds there —
 *  truthfully, and about whatever match the file happens to name. On 31.7.2026
 *  that produced four green rows describing YESTERDAY's match, minutes before
 *  a new one, because "Kirjoita .env.relay" had not been run. A green preflight
 *  about the wrong match is worse than no preflight: it confirms a wrong
 *  assumption at the exact moment the operator is looking for confirmation.
 *
 *  Exported pure so the comparison can be tested without a filesystem, an API
 *  or systemd — the rest of runPreflight() is untestable for exactly those
 *  reasons.
 *
 *  Precedence mirrors runPreflight(): `process.env` wins over the file, because
 *  that is what the relay itself would see. A value the job has not got yet
 *  (`null` — no broadcast created) is not a mismatch; it is simply not bound
 *  yet, and the existing rows already say what is missing. */
export function checkJobBinding(
  job: Job,
  fileEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env
): Check {
  const expected = expectedBinding(job);
  const wrong: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    if (want == null) continue;
    const actual = processEnv[key] || fileEnv[key] || "";
    if (actual !== want) {
      wrong.push(
        actual
          ? `${BINDING_LABEL[key]} on ${key === "RELAY_STREAM_KEY" ? "eri" : actual}, pitäisi olla ${key === "RELAY_STREAM_KEY" ? "työn oma" : want}`
          : `${BINDING_LABEL[key]} puuttuu`
      );
    }
  }
  if (wrong.length === 0) {
    return { name: "Työn sidonta", status: "ok", detail: `.env.relay osoittaa valittuun työhön (ottelu ${job.matchId})` };
  }
  return {
    name: "Työn sidonta",
    status: "fail",
    detail: `.env.relay ei vastaa valittua työtä: ${wrong.join("; ")} — aja "Kirjoita .env.relay" ensin.`,
  };
}

/** @param job the job the operator has open, when there is one. Omitted by
 *  callers that have no job to compare against (the CLI is deliberately
 *  path-based); given one, the binding check goes first, because every row
 *  below it is only meaningful if it holds. */
export async function runControlPreflight(job?: Job | null): Promise<PreflightResult> {
  // The same env file systemd hands the unit — see the runbook: preflight has
  // to check what the service would actually run, not what the UI thinks.
  const checks = await runPreflight(CONFIG.relayEnvPath);
  if (job) {
    let fileEnv: Record<string, string> = {};
    try {
      fileEnv = parseEnvFile(await readFile(CONFIG.relayEnvPath, "utf8"));
    } catch {
      // No file at all: every bound key reads as missing, which is exactly the
      // blocker the operator needs to see.
    }
    checks.unshift(checkJobBinding(job, fileEnv));
  }
  const result: PreflightResult = {
    ranAt: new Date().toISOString(),
    checks: checks.map(toWireCheck),
    blockers: checks.filter((c) => c.status === "fail").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    summary: summaryLine(checks),
  };
  // The push lives here rather than in the route so that EVERY preflight run
  // is covered — including phase B's automatic arming, where a blocker is
  // found with nobody looking at the screen. Fire-and-forget: a push service
  // outage must not turn a successful preflight into an HTTP 500.
  void notifyPreflightBlockers(result).catch(() => undefined);
  return result;
}
