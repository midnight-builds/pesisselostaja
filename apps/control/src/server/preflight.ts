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

/** Preflightin oma sanasto → operaattorin kieli (#176).
 *
 *  Rivit syntyvät relayn omassa preflightissa, joka puhuu komentoriville: se
 *  nimeää env-avaimia ja tiedostoja, ja niin sen kuuluukin. Ohjaamon
 *  käyttöliittymä ei mainitse niitä missään — ei edes huoltopinnassa nostettuna
 *  esiin normaalipolulle — joten käännös tehdään tässä, wire-muodon rajalla, ja
 *  raaka teksti kulkee mukana `technical`-kentässä huoltoa varten.
 *
 *  Sääntö on nimen ja tilan pari, ei tekstin osuma silloin kun sitä ei tarvita:
 *  jos relayn preflight muotoilee saman rivin uusiksi, käännös seuraa mukana.
 *  `contains` on mukana vain siellä, missä sama nimi ja tila tarkoittavat kahta
 *  eri asiaa. */
interface Rewrite {
  name: string;
  status: Check["status"];
  /** Erottaa saman nimen ja tilan eri tapaukset toisistaan. */
  contains?: string;
  text: string;
}

const REWRITES: Rewrite[] = [
  {
    name: "Työn sidonta",
    status: "ok",
    text: "Ohjaamo on sidottu valittuun otteluun.",
  },
  {
    name: "Työn sidonta",
    status: "fail",
    contains: "useammin kuin kerran",
    // Ristiriitaa ei voi korjata itse eikä operaattori korjaa sitä puhelimella:
    // SSH ei ole käytettävissä, joten rivi sanoo rehellisesti mitä voi tehdä.
    text: "Ohjaamon sidonta on ristiriitainen eikä korjaudu itsestään — ilmoita ylläpitoon.",
  },
  {
    name: "Työn sidonta",
    status: "fail",
    text: "Ohjaamo on yhä sidottu toiseen otteluun — valitse ottelu uudelleen.",
  },
  { name: "Kohde", status: "fail", text: "Selostetulla lähetyksellä ei ole kohdetta — luo lähetyspari." },
  { name: "Kohde", status: "warn", text: "Kohteen osoitetta ei ole erikseen asetettu — käytetään oletusta." },
  { name: "Kohde", status: "ok", text: "Selostettu lähetys on valmis ottamaan kuvaa vastaan." },
  { name: "Ottelu", status: "fail", contains: "RELAY_MATCH_ID", text: "Ottelua ei ole sidottu — valitse ottelu uudelleen." },
  { name: "Lähde", status: "fail", contains: "RELAY_YOUTUBE_URL", text: "Raakalähetystä ei ole sidottu — luo lähetyspari." },
];

/** Viimeinen suoja: rivi jolle ei ole omaa käännöstä ei silti saa vuotaa
 *  env-avainta ruudulle. Tuntematon `RELAY_*` korvataan yleisellä sanalla, jotta
 *  uusi tarkistus relayn puolella ei vuoda tänne huomaamatta. */
const ENV_WORD: Record<string, string> = {
  RELAY_MATCH_ID: "ottelu",
  RELAY_YOUTUBE_URL: "raakalähetys",
  RELAY_STREAM_KEY: "selostetun lähetyksen kohde",
  RELAY_RTMP_URL: "kohteen osoite",
};

export function redactEnvKeys(detail: string): string {
  return detail.replace(/RELAY_[A-Z0-9_]+/g, (key) => ENV_WORD[key] ?? "ohjaamon sidonta");
}

function operatorDetail(check: Check): string {
  const rule = REWRITES.find(
    (r) => r.name === check.name && r.status === check.status && (!r.contains || check.detail.includes(r.contains))
  );
  return rule ? rule.text : redactEnvKeys(check.detail);
}

/** Check → PreflightCheck: operaattorin lause päälle, raaka rivi talteen.
 *  `technical` jätetään pois kun käännös ei muuttanut mitään — kaksi kertaa
 *  samaa tekstiä ei ole vianetsintätietoa. */
export function toOperatorCheck(check: Check): PreflightCheck {
  const detail = operatorDetail(check);
  return {
    name: check.name,
    status: check.status,
    detail,
    ...(detail === check.detail ? {} : { technical: check.detail }),
  };
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
 *  Read ONLY from the file, deliberately: runPreflight() lets `process.env` win,
 *  because that is what systemd hands the RELAY. This runs in the CONTROL app,
 *  whose environment is a different process's and says nothing about the relay's
 *  — honouring it here would let a `RELAY_MATCH_ID` exported in the control
 *  app's shell produce a permanent fail that no "Kirjoita .env.relay" can clear.
 *
 *  A value the job has not got yet (`null` — no broadcast created) is not a
 *  mismatch; it is simply not bound yet, and the existing rows already say what
 *  is missing. `duplicateKeys` names keys the file defines more than once: the
 *  writer replaces the FIRST occurrence and both this parser and systemd take
 *  the LAST, so a hand-edited duplicate makes "Kirjoita .env.relay" a no-op —
 *  a blocker the documented remedy can never clear unless the row says so. */
export function checkJobBinding(
  job: Job,
  fileEnv: Record<string, string>,
  duplicateKeys: readonly string[] = []
): Check {
  const expected = expectedBinding(job);
  const wrong: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    if (want == null) continue;
    const actual = fileEnv[key] ?? "";
    // A missing RTMP address is not a binding fault: the relay defaults it, and
    // checkTarget already warns. Escalating it to a blocker would stop a start
    // over a value that does not change where the broadcast goes.
    if (!actual && key === "RELAY_RTMP_URL") continue;
    if (actual !== want) {
      wrong.push(
        actual
          ? `${BINDING_LABEL[key]} on ${key === "RELAY_STREAM_KEY" ? "eri" : actual}, pitäisi olla ${key === "RELAY_STREAM_KEY" ? "työn oma" : want}`
          : `${BINDING_LABEL[key]} puuttuu`
      );
    }
  }
  const dupes = duplicateKeys.filter((k) => k in expected);
  if (dupes.length > 0) {
    wrong.push(
      `${dupes.join(", ")} on .env.relay:ssä useammin kuin kerran — poista ylimääräiset rivit käsin, "Kirjoita .env.relay" ei korjaa tätä`
    );
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

/** Keys an env file defines more than once, in file order. Uncommented lines
 *  only — the same shape parseEnvFile accepts. See checkJobBinding for why a
 *  duplicate matters more than it looks. */
export function duplicateEnvKeys(text: string): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes];
}

/** Itsekorjaus: sitoo ohjaamon annettuun työhön. Injektoitu eikä tuotu suoraan,
 *  koska kutsuja on se joka tietää saako korjata — vain operaattorin valitsemaan
 *  otteluun, ei koskaan itse pääteltyyn (#171/3). Ilman tätä argumenttia
 *  preflight on entisellään: se katsoo eikä koske.
 *
 *  Korjaus EI lähetä pushia (`notifyAutoFix`): itsekorjautuva este on #174:n
 *  kolmiluokkaisessa säännössä se luokka, josta ei ilmoiteta lainkaan. Se näkyy
 *  rivinä siellä missä operaattori muutenkin katsoo. */
export interface PreflightRepair {
  bindJob(job: Job): Promise<void>;
}

/** Saako `.env.relay`:n sidonnan korjata juuri nyt? Kolme ehtoa, joista
 *  jokainen on oma vikansa jos se puuttuu — siksi tämä on nimetty sääntö eikä
 *  kolme ehtoa HTTP-reitin sisällä.
 *
 *  - **Työ on operaattorin valitsema** (`getActiveJob`, ei clientin id):
 *    vanhentunut id ei saa kirjoittaa sidontaa toiseen otteluun (#171/3).
 *  - **Relay ei ole ajossa:** ajossa oleva lähetys ei saa saada uutta sidontaa
 *    jalkojensa alle.
 *  - **Ajastin ei ole käynnistämässä mitään** (#209): käynnistysikkunassa
 *    `.env.relay` on juuri kirjoitettu ajastimen valitsemalle työlle, relay ei
 *    ole vielä ajossa — eli edellinen ehto täyttyy — ja ajastimen oma
 *    sidontatarkistus on jo ajettu. Korjaus menisi läpi tasan siinä ikkunassa,
 *    jossa #155:n suoja ei enää laukea. */
export function mayRepairBinding(input: {
  /** Onko tarkistettava työ sama kuin operaattorin valitsema. */
  isSelectedJob: boolean;
  relayActive: boolean;
  schedulerStarting: boolean;
}): boolean {
  return input.isSelectedJob && !input.relayActive && !input.schedulerStarting;
}

async function readEnvText(): Promise<string> {
  try {
    return await readFile(CONFIG.relayEnvPath, "utf8");
  } catch {
    // No file at all: every bound key reads as missing, which is exactly the
    // blocker the operator needs to see.
    return "";
  }
}

/** @param job the job the operator has open, when there is one. Omitted by
 *  callers that have no job to compare against (the CLI is deliberately
 *  path-based); given one, the binding check goes first, because every row
 *  below it is only meaningful if it holds.
 *  @param repair kun annettu, väärä sidonta korjataan ennen muita tarkistuksia
 *  ja korjaus näkyy rivinä ("Korjattiin: …") — hiljaista itsekorjausta ei tehdä,
 *  koska sidonta on #155:n viimeinen suoja ja sen teot jäävät näkyviin (#176). */
export async function runControlPreflight(job?: Job | null, repair?: PreflightRepair): Promise<PreflightResult> {
  let binding: Check | null = null;
  /** Operaattorin lause korjatulle sidonnalle. Se ei kulje käännöstaulun kautta:
   *  taulussa "Työn sidonta"/ok on tavallinen kunnossa-rivi, ja se söisi juuri
   *  sen tiedon, joka tässä on tärkein — että ohjaamo teki jotain. */
  let repairedDetail: string | null = null;
  if (job) {
    const text = await readEnvText();
    binding = checkJobBinding(job, parseEnvFile(text), duplicateEnvKeys(text));
    // Korjaus ENNEN muita tarkistuksia: ne lukevat saman tiedoston, ja korjauksen
    // jälkeen ajettuina ne kertovat sen todellisuuden, jossa lähetys alkaisi.
    // Toisin päin rivit kuvaisivat tilaa, jota ei enää ole.
    if (binding.status === "fail" && repair) {
      try {
        await repair.bindJob(job);
        const after = await readEnvText();
        const recheck = checkJobBinding(job, parseEnvFile(after), duplicateEnvKeys(after));
        if (recheck.status === "ok") {
          binding = recheck;
          repairedDetail = `Korjattiin: ohjaamo osoitti toiseen otteluun, nyt valittuun (${job.home} – ${job.away}).`;
        } else {
          // Korjaus ei purrut (esim. sama avain kahdesti tiedostossa): jäljelle
          // jää este, ja rivi kertoo sen jälkimmäisen totuuden — ei sitä mitä
          // yritettiin.
          binding = recheck;
        }
      } catch (err) {
        binding = {
          name: binding.name,
          status: "fail",
          detail: `${binding.detail} Automaattinen korjaus epäonnistui: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  // The same env file systemd hands the unit — see the runbook: preflight has
  // to check what the service would actually run, not what the UI thinks.
  const checks = await runPreflight(CONFIG.relayEnvPath);
  if (binding) {
    checks.unshift(binding);
  }
  const wire = checks.map(toOperatorCheck);
  // Sidonta on aina ensimmäinen rivi kun se on mukana, joten korjauksen lause
  // menee siihen — ja raaka rivi säilyy huoltoa varten.
  if (repairedDetail) {
    wire[0] = { ...wire[0], detail: repairedDetail, fixed: true, technical: checks[0].detail };
  }
  const result: PreflightResult = {
    ranAt: new Date().toISOString(),
    checks: wire,
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
