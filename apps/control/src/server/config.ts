/** Central config for the control server. Every path is derived from this
 *  file's own location (import.meta.url) rather than process.cwd(), so it
 *  resolves the same whether the server is launched via `npm run dev` from
 *  the repo root, `tsx src/server/index.ts` from apps/control, or a systemd
 *  unit with some other WorkingDirectory. The one exception is deployDir,
 *  which lives outside the repo entirely (see the comment below) — that is
 *  the single spot a home-directory default is allowed to appear, and even
 *  there os.homedir() is used instead of a literal path. */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";

// apps/control/src/server/config.ts -> repo root is four directories up,
// the apps/control workspace root two directories up.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CONTROL_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface ControlConfig {
  port: number;
  host: string;
  repoRoot: string;
  /** The relay's own env file — writing this is how a job's source/target
   *  reach the relay process (see writeRelayEnv in relay.ts). */
  relayEnvPath: string;
  /** Symlinked into ~/relay-deploy, so the control server reads the exact
   *  status/log/control files the running relay writes (DESIGN.md). */
  relayRunDir: string;
  relayUnit: string;
  /** Pinned, detached worktree the relay actually runs from (issue #59) —
   *  never this checkout. See CLAUDE.md "Running". */
  deployDir: string;
  stateDir: string;
  clientDist: string;
  assetsDir: string;
}

/** Every path/unit that a run of this server WRITES to or ACTS on can be
 *  redirected by an env var. Defaults are the production ones — the overrides
 *  exist so a test run (or a second instance on another port) can be pointed at
 *  a scratch directory and a unit that does not exist, and thereby cannot touch
 *  the live broadcast's `.env.relay`, control files or systemd service. */
export const CONFIG: ControlConfig = {
  // 3002, sama kuin ops/pesisselostaja-control.service asettaa: oletuksen ja
  // ajossa olevan portin ero on jo kahdesti johtanut siihen että ohjaamoa on
  // haettu väärästä portista. 3001 EI kelpaa — sen omistaa tällä palvelimella
  // toinen projekti (finance-app-api.service), joka vastaa omilla 404:llaan
  // sen sijaan että yhteys kieltäytyisi, joten virhe näyttää ohjaamon viasta.
  port: Number(process.env.CONTROL_PORT ?? 3002),
  host: process.env.CONTROL_HOST ?? "0.0.0.0",
  repoRoot: REPO_ROOT,
  relayEnvPath: process.env.CONTROL_RELAY_ENV ?? join(REPO_ROOT, "apps/broadcast/.env.relay"),
  relayRunDir: process.env.CONTROL_RELAY_RUN_DIR ?? join(REPO_ROOT, "apps/broadcast/run/"),
  relayUnit: process.env.CONTROL_RELAY_UNIT ?? "pesisselostaja-relay.service",
  deployDir: process.env.CONTROL_DEPLOY_DIR ?? join(homedir(), "relay-deploy"),
  stateDir: process.env.CONTROL_STATE_DIR ?? join(CONTROL_ROOT, "run/"),
  clientDist: join(CONTROL_ROOT, "dist/client"),
  assetsDir: join(CONTROL_ROOT, "assets"),
};
