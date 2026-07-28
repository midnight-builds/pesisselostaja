import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/** The very file systemd hands the service in the unit's `EnvironmentFile=`
 *  line — preflightCli.ts resolves the same path the same way. Resolved from
 *  the module's own directory, so it does not matter which cwd the operator
 *  started a manual run from. */
export const RELAY_ENV_FILE = resolve(import.meta.dirname, "../.env.relay");

/** Loads the relay's settings the way the live service gets them, so a manual
 *  dry-run runs with the exact config systemd would use (issue #55: dry-run
 *  used to read only the repo-root `.env` and reported e.g. batter-change
 *  announcements ON while `.env.relay` had them off).
 *
 *  Order matters and mirrors systemd: `.env.relay` first, repo-root `.env`
 *  second, because under systemd the `.env.relay` values arrive as REAL
 *  environment variables and therefore already beat anything in `.env`.
 *  dotenv never overwrites an already-set variable, so a genuinely exported
 *  value (systemd, or `RELAY_MATCH_ID=1234 npm run …`) still wins over both. */
export function loadRelayEnv(paths: string[] = [RELAY_ENV_FILE, resolve(process.cwd(), ".env")]): void {
  for (const path of paths) loadDotenv({ path });
}
