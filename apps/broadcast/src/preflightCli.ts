import { resolve } from "node:path";
import { runPreflight, summarize } from "./preflight.js";

/** Reads the same .env.relay systemd would, so what preflight checks is what
 *  the service will actually run. Values already in the environment win, which
 *  makes `RELAY_MATCH_ID=1234 npm run broadcast:preflight` work for a one-off. */
const envFile = process.argv[2] ?? resolve(import.meta.dirname, "../.env.relay");

const { text, exitCode } = summarize(await runPreflight(envFile));
console.log(`Esitarkistus (${envFile})\n`);
console.log(text);
process.exit(exitCode);
