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

import { runPreflight, summarize, type Check } from "../../../broadcast/src/preflight.js";
import type { PreflightCheck, PreflightResult } from "../shared/types.js";
import { CONFIG } from "./config.js";

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

export async function runControlPreflight(): Promise<PreflightResult> {
  // The same env file systemd hands the unit — see the runbook: preflight has
  // to check what the service would actually run, not what the UI thinks.
  const checks = await runPreflight(CONFIG.relayEnvPath);
  return {
    ranAt: new Date().toISOString(),
    checks: checks.map(toWireCheck),
    blockers: checks.filter((c) => c.status === "fail").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    summary: summaryLine(checks),
  };
}
