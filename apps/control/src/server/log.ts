/** Ohjaamon oma tapahtumaloki (#232).
 *
 *  Ottelupäivä 5.8.2026 ajettiin läpi, käynnistysvahti käynnisti lähetyksen
 *  ensi kertaa itse — ja koko ottelun ajalta ohjaamon unitin journalissa oli
 *  kymmenen riviä, kaikki systemdin omia. Relaylta samalta ajalta 933. Ohjaamo
 *  teki siis kaiken hiljaa: käynnistyspäätöstä, valmiustarkistusta, sidonnan
 *  korjausta tai työn tilasiirtymää ei jäänyt kertomaan mikään. Seuraus ei ollut
 *  kosmeettinen: #118:n sidonnan sovittelua ei voinut todeta koetelluksi EIKÄ
 *  koettelemattomaksi, koska rivejä ei ollut olemassa kumpaankaan suuntaan.
 *
 *  Loki on ohjaamon ainoa tekninen taso (SSH:ta ei käytetä), joten mitta on:
 *  **ottelupäivän kulun on rekonstruoiduttava näistä riveistä jälkikäteen.**
 *
 *  Muoto on sama kuin relayn (`apps/broadcast/src/log.ts`), koska rivit luetaan
 *  samaan näkymään samalla jäsentimellä (`journal.ts`):
 *
 *    `<6>[16.40.44] scheduler.start: Pesä Ysit – IPV: raakalähetys livenä…`
 *
 *  Toteutus on oma eikä relaystä tuotu, ja se on tarkoituksellista: relayn
 *  `EventCode` on relayn alijärjestelmien luettelo, ja ohjaamon koodien
 *  tunkeminen siihen sitoisi kaksi erikseen deployattavaa prosessia toisiinsa
 *  (relay ajetaan pinnatusta ~/relay-deploy:sta, joka voi olla vanhempi).
 *  Yhteistä on RIVIN MUOTO, ei koodiluettelo.
 *
 *  **Koodit eivät saa törmätä relayn koodeihin**, koska molemmat unitit luetaan
 *  samaan lokinäkymään: relay omistaa `relay.` `source.` `ffmpeg.` `slate.`
 *  `api.` `match.` `speech.` `tts.` `control.` `fifo.`, ohjaamo alla luetellut.
 *  Kumpi unit rivin kirjoitti, luetaan journalista (`LogLine.unit`), ei
 *  koodista. */

import { fstatSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Ohjaamon vakaat tapahtumatunnisteet. Lisääminen on harkittu teko samalla
 *  tavalla kuin HTTP-reitin lisääminen: nämä ovat se sanasto, jolla ottelupäivä
 *  luetaan jälkikäteen. Ryhmitelty sen mukaan mikä osa ohjaamoa rivin omistaa. */
export type ControlEventCode =
  // Käynnistysvahti (scheduler.ts)
  | "scheduler.decision"
  | "scheduler.start"
  | "scheduler.blocked"
  | "scheduler.start_failed"
  | "scheduler.enabled"
  // Valmiustarkistus (preflight.ts)
  | "preflight.ok"
  | "preflight.blocked"
  | "preflight.repaired"
  | "preflight.repair_failed"
  // Työjono (jobs.ts)
  | "job.created"
  | "job.status"
  | "job.reconciled"
  // Relayn kosketuspinnat (relay.ts)
  | "relay.env"
  | "relay.unit"
  // Ajon päätös ja siivous (live.ts)
  | "cleanup.start"
  | "cleanup.action"
  | "cleanup.failed"
  | "cleanup.skipped"
  // Palvelin itse (index.ts)
  | "server.start"
  | "server.error";

const PRIORITY: Record<LogLevel, number> = { debug: 7, info: 6, warn: 4, error: 3 };

/** Onko OMA stdout journaldin virta. Sama tarkistus kuin relaylla, ja samasta
 *  syystä: pelkkä JOURNAL_STREAMin olemassaolo ei riitä, koska muuttuja periytyy
 *  lapsiprosesseille — systemd-unitista käsin ajettu `npm run dev` tulostaisi
 *  `<6>` jokaisen rivin eteen. systemd dokumentoi arvon muodossa `device:inode`
 *  juuri identiteetin tarkistamista varten. */
function detectJournald(): boolean {
  const raw = process.env.JOURNAL_STREAM;
  if (!raw) return false;
  const [dev, ino] = raw.split(":");
  try {
    const st = fstatSync(1);
    return String(st.dev) === dev && String(st.ino) === ino;
  } catch {
    return false;
  }
}

let journaldCache: boolean | null = null;

function underJournald(): boolean {
  if (journaldCache === null) journaldCache = detectJournald();
  return journaldCache;
}

/** Vain testeille: unohda välimuistiin jäänyt stdout-tarkistus. */
export function resetJournaldDetection(): void {
  journaldCache = null;
}

/** Vietynä testejä varten: rakentaa täsmälleen sen rivin joka stdoutiin menee,
 *  kirjoittamatta sitä. */
export function formatLine(level: LogLevel, code: ControlEventCode, msg: string, ts: string): string {
  const prefix = underJournald() ? `<${PRIORITY[level]}>` : "";
  return `${prefix}[${ts}] ${code}: ${msg}`;
}

function emit(level: LogLevel, code: ControlEventCode, msg: string): void {
  // Yksi rivi, aina yhdellä kutsulla: rivinvaihdot viestin sisällä hajottaisivat
  // journaldin tietueen kahdeksi, joista jälkimmäinen olisi koodittomana
  // arvausten varassa.
  const line = formatLine(level, code, msg.replace(/\s*\n\s*/g, " "), new Date().toLocaleTimeString("fi-FI"));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (code: ControlEventCode, msg: string): void => emit("info", code, msg);
export const logWarn = (code: ControlEventCode, msg: string): void => emit("warn", code, msg);
export const logError = (code: ControlEventCode, msg: string): void => emit("error", code, msg);

/** Virheen sanoma lokiriville. Poikkeuksen `message` riittää: stack menee
 *  omalle rivilleen ilman koodia, ja rikkoisi juuri sen jäsennyksen jonka takia
 *  koodit ovat olemassa. */
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
