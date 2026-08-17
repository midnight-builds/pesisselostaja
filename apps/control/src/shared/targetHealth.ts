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

/** Onko selostettu lähetys todistetusti kuollut kesken ottelun.
 *
 *  "Todistetusti" on tässä koko sääntö: `complete` ja `revoked` ovat YouTuben
 *  omia, lopullisia tiloja (päättynyttä lähetystä ei voi palauttaa liveksi),
 *  joten tuore havainto niistä ei voi olla ohimenevä häiriö. Kaikki muu —
 *  vanhentunut havainto, virhe, väärä video — on tietämättömyyttä, ja
 *  tietämättömyydestä ei hälytetä.
 *
 *  Rajaus kesken ottelun ja ajossa olevaan työhön on yhtä tärkeä kuin itse
 *  tarkistus: ottelun jälkeen `complete` on normaali, terve lopputila
 *  (enableAutoStop tai hard stopin siivous sulkee lähetyksen), eikä siitä saa
 *  syntyä hälytystä. */
export function isTargetDeadMidMatch(input: {
  job: Job | null;
  relayActive: boolean;
  matchFinished: boolean;
  ingest: TargetIngest | null | undefined;
  nowMs: number;
}): boolean {
  const { job, relayActive, matchFinished, ingest, nowMs } = input;
  if (!job || job.status !== "live" || !job.targetVideoId) return false;
  // Ilman ajossa olevaa relayta kuollut kohde on eri vika, ja siitä huutaa jo
  // "relay ei ole käynnissä" -sääntö; ottelun päätyttyä se on normaali loppu.
  if (!relayActive || matchFinished) return false;
  if (!ingest || ingest.error !== null) return false;
  // Havainnon on koskettava TÄMÄN työn kohdetta: työn vaihtuessa edellisen
  // ottelun (aivan oikein päättynyt) kohde ei saa hälyttää uuden ottelun
  // nimissä.
  if (ingest.videoId !== job.targetVideoId) return false;
  const ageMs = nowMs - Date.parse(ingest.observedAt);
  // Sama ikäsääntö kuin lähteen havainnolla: negatiivinen ikä (kello siirtynyt,
  // käsin muokattu tiedosto) olisi ikuisesti "tuore" ilman alarajaa.
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TARGET_INGEST_STALE_MS) return false;
  return ingest.lifeCycleStatus === "complete" || ingest.lifeCycleStatus === "revoked";
}
