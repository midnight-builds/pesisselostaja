/** Kohteen eli selostetun lähetyksen kuolemantarkistus (#250).
 *
 *  Jaettu sääntö samasta syystä kuin `TELEMETRY_STALE_MS`: palvelin päättää
 *  sillä otsikon ja push-ilmoituksen, selain tilakortin hälytysrivin, ja kaksi
 *  eri toteutusta tarkoittaisi että toinen puoli hälyttää tilanteesta jonka
 *  toinen on jo hylännyt. */

import type { Job, TargetIngest } from "./types.js";

/** Kuinka vanha kohdehavainto vielä kelpaa päätöksen pohjaksi. Sama 4×
 *  perusväli kuin lähteen havainnolla (`SOURCE_INGEST_STALE_MS`): kolme
 *  peräkkäistä epäonnistunutta kierrosta ennen kuin havaintoon lakataan
 *  uskomasta. Jaetussa moduulissa, koska selain tarvitsee saman rajan. */
export const TARGET_INGEST_STALE_MS = 120_000;

/** Miten selostettu lähetys on kuollut, kun se on kuollut.
 *
 *  - `"ended"` — YouTube on päättänyt lähetyksen (`complete`/`revoked`).
 *  - `"missing"` — lähetystä ei enää ole kanavalla (#252): poistettu käsin
 *    Studiossa tai kanavamoderoinnin toimesta.
 *
 *  Katsojalle nämä ovat sama asia (jaettu linkki ei näytä mitään), mutta
 *  operaattorille eivät: toisessa lähetys on olemassa ja päättynyt, toisessa
 *  sitä ei ole. Siksi sääntö palauttaa syyn eikä pelkkää totuusarvoa — jotta
 *  otsikko, ketjurivi, tilakortti ja push voivat sanoa saman asian oikein
 *  eivätkä silti voi erota toisistaan. */
export type TargetDeathReason = "ended" | "missing";

/** Onko selostettu lähetys todistetusti kuollut kesken ottelun, ja miten.
 *  Palauttaa null kun näyttöä ei ole.
 *
 *  "Todistetusti" on tässä koko sääntö. Kaksi asiaa kelpaa näytöksi:
 *
 *  1. `complete` ja `revoked` ovat YouTuben omia, lopullisia tiloja
 *     (päättynyttä lähetystä ei voi palauttaa liveksi), joten tuore havainto
 *     niistä ei voi olla ohimenevä häiriö.
 *  2. Varmistettu tyhjä vastaus (#252). Ohjaamo loi lähetyksen omalle
 *     kanavalleen ja kysyy sitä sen omalla id:llä, joten tyhjä lista on
 *     auktoritatiivinen vastaus "tätä lähetystä ei ole" — ei epäonnistunut
 *     haku. Varmistuksen (kaksi peräkkäistä tyhjää) tekee polleri, koska
 *     armonaika on sen kierroksissa mitattava; tänne asti pääsee vain
 *     `"confirmed"`.
 *
 *  Kaikki muu — vanhentunut havainto, virhe, väärä video, yksi tyhjä vastaus —
 *  on tietämättömyyttä, ja tietämättömyydestä ei hälytetä.
 *
 *  Rajaus kesken ottelun ja ajossa olevaan työhön on yhtä tärkeä kuin itse
 *  tarkistus: ottelun jälkeen `complete` on normaali, terve lopputila
 *  (enableAutoStop tai hard stopin siivous sulkee lähetyksen), eikä siitä saa
 *  syntyä hälytystä. */
export function targetDeathReason(input: {
  job: Job | null;
  relayActive: boolean;
  matchFinished: boolean;
  ingest: TargetIngest | null | undefined;
  nowMs: number;
}): TargetDeathReason | null {
  const { job, relayActive, matchFinished, ingest, nowMs } = input;
  if (!job || job.status !== "live" || !job.targetVideoId) return null;
  // Ilman ajossa olevaa relayta kuollut kohde on eri vika, ja siitä huutaa jo
  // "relay ei ole käynnissä" -sääntö; ottelun päätyttyä se on normaali loppu.
  if (!relayActive || matchFinished) return null;
  // Varmistettu tyhjä vastaus kulkee `error === null` -portista, koska polleri
  // ei merkitse sitä virheeksi — juuri se merkintä piti not-foundin vihreänä
  // ennen #252:ta.
  if (!ingest || ingest.error !== null) return null;
  // Havainnon on koskettava TÄMÄN työn kohdetta: työn vaihtuessa edellisen
  // ottelun (aivan oikein päättynyt) kohde ei saa hälyttää uuden ottelun
  // nimissä.
  if (ingest.videoId !== job.targetVideoId) return null;
  const ageMs = nowMs - Date.parse(ingest.observedAt);
  // Sama ikäsääntö kuin lähteen havainnolla: negatiivinen ikä (kello siirtynyt,
  // käsin muokattu tiedosto) olisi ikuisesti "tuore" ilman alarajaa.
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TARGET_INGEST_STALE_MS) return null;
  if (ingest.notFound === "confirmed") return "missing";
  if (ingest.lifeCycleStatus === "complete" || ingest.lifeCycleStatus === "revoked") return "ended";
  return null;
}

/** Totuusarvomuoto samasta säännöstä, kutsupaikoille joita kuoleman syy ei
 *  kiinnosta. */
export function isTargetDeadMidMatch(input: {
  job: Job | null;
  relayActive: boolean;
  matchFinished: boolean;
  ingest: TargetIngest | null | undefined;
  nowMs: number;
}): boolean {
  return targetDeathReason(input) !== null;
}
