/** HTTP contract. The server implements these paths; the client calls them.
 *  Every route is JSON in / JSON out except the SSE stream and static assets.
 *
 *  GET  /api/live                 -> LiveState                (one-shot snapshot)
 *  GET  /api/live/stream          -> text/event-stream        (LiveState pushes, event: "live")
 *  GET  /api/matches?date=YYYY-MM-DD        -> DayMatches
 *  GET  /api/matches/:id                    -> MatchOption
 *  POST /api/jobs                 {CreateJobRequest}  -> Job
 *  GET  /api/jobs                 -> Job[]
 *  PATCH /api/jobs/:id            {Partial<Job>}      -> Job
 *  POST /api/jobs/:id/activate    -> Job              (writes .env.relay for this job)
 *  GET  /api/jobs/:id/share       -> JobShareMessage  (jakoviesti, muodostetaan aina uudelleen)
 *  POST /api/preflight            -> PreflightResult
 *  POST /api/relay/start|stop|restart  -> RelayProcess
 *  GET  /api/settings             -> ControlSettings   (pysyväisasetukset, #133)
 *  PATCH /api/settings            {Partial<ControlSettings>} -> ControlSettings
 *  GET  /api/scheduler            -> SchedulerState
 *  POST /api/scheduler/enable     {enabled: boolean} -> SchedulerState
 *                                  (ajastin on oletuksena POIS PÄÄLTÄ)
 *  POST /api/knobs                {Partial<ControlKnobs>} -> ControlKnobs
 *  POST /api/knobs/delay-nudge    {deltaMs: number}   -> ControlKnobs
 *  GET  /api/log?limit=&level=    -> LogLine[]
 *  GET  /api/push/key             -> {publicKey}      (VAPID, generated on first boot)
 *  POST /api/push/subscribe       {PushSubscription}  -> 204
 *  POST /api/push/test            -> PushSendResult   (409 jos ei tilauksia)
 *  GET  /api/push/prefs           -> NotificationPrefs
 *  POST /api/push/prefs           {Partial<NotificationPrefs>} -> NotificationPrefs
 *
 *  Vaihe B — YouTube-ketju. Kirjoittavat reitit vaativat Google-yhteyden
 *  (409 GoogleAuthError ilman sitä), tuhoavat lisäksi {confirm: true}.
 *  GET  /api/youtube/health       -> valtuutettu kanava, scopet, tokenin ikä, kiintiö
 *  POST /api/youtube/auth/start   {clientId?, clientSecret?} -> laitekoodi + osoite
 *  POST /api/youtube/auth/poll    -> {status: "pending" | "connected"}
 *  GET  /api/youtube/broadcasts   -> menneet ja tulevat lähetykset
 *  POST /api/youtube/broadcasts   {jobId|matchId, overrides?, privacy?, playlistId?}
 *                                  -> luo normaalin JA "Selostettu"-version
 *                                  (tuntematon overrides-avain -> 400, ks.
 *                                   TITLE_OVERRIDE_KEYS alla)
 *  PATCH  /api/youtube/videos/:id {confirm} -> metatietojen muokkaus
 *  DELETE /api/youtube/videos/:id {confirm} -> poisto (tuhoava)
 *  GET  /api/youtube/playlists    -> soittolistat
 *  POST /api/youtube/templates/preview -> otsikot, kuvaus ja jaettava viesti
 *                                         luomatta mitään
 *  POST /api/thumbnail/preview    {headline, datetime, venue, narrated} -> image/png
 *  POST /api/thumbnail/render     sama, mutta tallentaa -> {id, path}
 */

import type { ControlKnobs, Job } from "./types.js";

export interface CreateJobRequest {
  matchId: number;
  sourceUrl?: string;
  targetStreamKey?: string;
  targetRtmpUrl?: string;
  targetVideoId?: string;
  startsAt?: string;
  note?: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

export type PatchJobRequest = Partial<
  Pick<
    Job,
    "sourceUrl" | "targetStreamKey" | "targetRtmpUrl" | "targetVideoId" | "note" | "status" | "startsAt"
  >
>;

export type PatchKnobsRequest = Partial<ControlKnobs>;

/** The RTMP ingest that has worked for every broadcast so far; the UI offers
 *  it as the default so the operator only ever pastes a stream key. */
export const DEFAULT_RTMP_URL = "rtmp://a.rtmp.youtube.com/live2";

/** Otsikon ohitukset: **yksi luettelo, jota molemmat puolet käyttävät** (#231).
 *
 *  Palvelin otti ohitukset muodossa `Partial<MatchTemplateInput>` ja levitti ne
 *  sellaisenaan, joten tuntematon avain meni hiljaa läpi — ja clientin oma
 *  `TitleOverrides` oli käsin tehty osajoukko, jota ei sitonut mikään yhteinen
 *  sopimus. Se oli lähellä purra: #223 nimesi `teamLabel`/`opponent` →
 *  `homeTeam`/`awayTeam`, ja jos vain toinen puoli olisi nimetty, mikään ei
 *  olisi huutanut — kenttä olisi jäänyt huomiotta ja otsikko syntynyt
 *  tulospalvelun raakanimillä. Yksikään testi ei olisi huomannut:
 *  `test-ui/support/state.ts` fake-toteuttaa palvelimen, joten selaintesti
 *  näkisi väärän avaimen läpimenneenä.
 *
 *  Luettelossa on kahdenlaisia avaimia, ja molemmat kuuluvat tänne:
 *
 *  - **`homeTeam`, `awayTeam`, `shortVenue`** — ne, joita käyttöliittymän
 *    "Muokkaa otsikkoa" lähettää. Nimet ovat PAIKKOJA otsikossa (koti ensin,
 *    vieras toisena, #223), eivät omistajuutta.
 *  - **`localDate`, `localTime`** — dokumentoitu varatie sille ottelulle, joka
 *    on listalla ilman kellonaikaa: ilman niitä tekstien muodostus kaatuu
 *    "alkuaika puuttuu" -virheeseen eikä sitä voi mistään korjata. Ei
 *    käyttöliittymässä, mutta ei myöskään poistettavissa hiljaa. */
export const TITLE_OVERRIDE_KEYS = [
  "homeTeam",
  "awayTeam",
  "shortVenue",
  "localDate",
  "localTime",
] as const;

export type TitleOverrideKey = (typeof TITLE_OVERRIDE_KEYS)[number];

export type TitleOverrides = Partial<Record<TitleOverrideKey, string>>;

/** Kelpaako runko-osan `overrides` sellaisenaan malleille.
 *
 *  Torjuu tuntemattoman avaimen 400:lla sen sijaan että ohittaisi sen: hiljaa
 *  huomiotta jäävä ohitus näkyy vasta valmiissa YouTube-otsikossa, ja siihen
 *  mennessä lähetys on jo olemassa ja linkki jaettu. Virheilmoitus nimeää
 *  avaimen, koska sen kirjoittaja on joko toinen kehittäjä tai curl. */
export function validateTitleOverrides(
  raw: unknown
): { ok: true; value: TitleOverrides } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "overrides on oltava objekti." };
  }
  const value: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
    // Puuttuva arvo on sama kuin puuttuva avain: JSON.stringify pudottaa
    // `undefined`in, joten tähän päätyy vain nimenomaisesti kirjoitettu.
    if (item === undefined) continue;
    if (!(TITLE_OVERRIDE_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        error: `Tuntematon otsikon ohitus "${key}". Sallitut: ${TITLE_OVERRIDE_KEYS.join(", ")}.`,
      };
    }
    if (typeof item !== "string") {
      return { ok: false, error: `Otsikon ohituksen "${key}" on oltava merkkijono.` };
    }
    // Tyhjä merkkijono ei ole ohitus vaan tyhjä kenttä: se tuottaisi otsikon,
    // jossa joukkueen nimen paikalla ei lue mitään.
    if (item.trim() === "") continue;
    value[key] = item.trim();
  }
  return { ok: true, value: value as TitleOverrides };
}
