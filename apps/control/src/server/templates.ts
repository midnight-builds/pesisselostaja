/** Otsikko-, kuvaus- ja jaettava-viesti-mallit YouTube-lähetyksille.
 *
 *  Kanoninen lähde on `apps/control/docs/youtube-runbook.md`; leirimallin
 *  SKILL (`pesis-ai-youtube-leirimalli-SKILL.md`) ohittaa sen siellä missä ne
 *  ovat ristiriidassa. Tämä tiedosto on tarkoituksella puhdas: ei verkkoa, ei
 *  levyä, ei tokeneita — pelkkää tekstinmuodostusta, jotta kaavat voi testata
 *  runbookin esimerkkejä vasten ilman yhtään Google-kutsua.
 *
 *  Kaksi asiaa joita ei saa "siistiä" pois:
 *  1. **Lopputulos ei tule otsikkoon.** Tallenteen katsoja ei halua spoileria
 *     (DESIGN.md "Metatiedot") — siksi mikään tässä ei lue `resultString`ia.
 *  2. **Jaettava viesti alkaa aina tarkalleen `Seuraava live on `.** Se on
 *     leirimallin SKILLin nimenomainen vaatimus, ei tyyliseikka. Muotoilu on
 *     nyt konfiguroitava (#95), mutta oletus on juuri tämä — ja oletus on se
 *     mitä ilman omaa `run/share-template.json`ia käytetään. */

import { venueDisplayName, type VenueNameOptions } from "@pesisselostaja/core";
import { watchUrlForVideo } from "./youtubeUrl.js";
import type { JobShareMessage } from "../shared/types.js";

/** Kaikki käyttäjän näkemät ajat ovat Suomen paikallisaikaa (runbook
 *  "Aikakasittely"). API antaa UTC:tä; muunnos tehdään vain täällä. */
export const HELSINKI = "Europe/Helsinki";

/** Soittolistat 2026 (runbook "Soittolistat 2026"). Kaikki vuoden 2026 videot
 *  kuuluvat oman ikäluokkansa 2026-soittolistaan. */
export const PLAYLISTS_2026: Record<AgeGroup, { id: string; name: string }> = {
  G: { id: "PLRxzlzu4-aUMrFdCP3Z98zaPKfRfSS2FQ", name: "Pesä Ysit G 2026" },
  E: { id: "PLRxzlzu4-aUMy_J6dnRTQmjAmEYNNtpad", name: "Pesä Ysit E 2026" },
  F: { id: "PLRxzlzu4-aUMN4kmuRM5fQ8Zrotzv_uNK", name: "Pesä Ysit F 2026" },
  D: { id: "PLRxzlzu4-aUNSLP3iNS8bGiY_dL0jnXnl", name: "Pesä Ysit D 2026" },
};

export type AgeGroup = "G" | "E" | "F" | "D";

/** Tunnistaa oman seuran joukkueen. **Ei vaikuta otsikon järjestykseen** —
 *  siinä koti on aina ensin (#223). Käytetään enää siihen, että ikäluokka (ja
 *  sitä kautta soittolista) luetaan ensisijaisesti omasta joukkueesta:
 *  vastustajan nimessä voi olla oma kirjaimensa ("SuPo G mustat"). */
export const OWN_TEAM_PATTERN = /pes[äa]\s*ysit/i;

export const NARRATED_PREFIX = "Selostettu ";

/** Leirimallin SKILL: viesti aloitetaan aina tällä fraasilla, merkilleen. */
export const SHARE_MESSAGE_OPENING = "Seuraava live on ";

/** Monikko. Molemmat muodot vastaavat 200, mutta tulospalvelu itse käyttää
 *  monikkoa, ja jaettava linkki kuuluu olla samassa muodossa kuin se joka
 *  vastaanottajalla jo on (vahvistettu 29.7.2026, #95). */
/** Jaettavan viestin muoto datana. Puhdas tyyppi ja puhdas renderöijä ovat
 *  täällä; tiedoston luku on shareTemplate.ts:ssä, jotta tämä moduuli pysyy
 *  levyä koskemattomana. */
export interface ShareTemplate {
  /** Ensimmäinen rivi. Paikkamerkit: {time}, {matchup}. */
  opening: string;
  /** Linkkirivit. Paikkamerkit: {watchUrl}, {narratedWatchUrl}, {matchUrl}. */
  lines: string[];
}

/** 29.7.2026 käytössä vahvistettu muoto (#95). */
export const DEFAULT_SHARE_TEMPLATE: ShareTemplate = {
  opening: "Seuraava live on klo {time}: {matchup}. Alla linkit:",
  lines: [
    "YouTube: {watchUrl}",
    "YouTube selostettu: {narratedWatchUrl}",
    "Tulospalvelu: {matchUrl}",
  ],
};

/** Kenttä kerrallaan, koska tiedostoa muokataan käsin: jos joku kirjoittaa
 *  `opening`in uusiksi ja poistaa `lines`in, hän saa oman aloituksensa ja
 *  oletuslinkit — ei kaatumista eikä tyhjää viestiä. */
export function normalizeShareTemplate(raw: unknown): ShareTemplate {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const opening =
    typeof obj.opening === "string" && obj.opening.trim() !== ""
      ? obj.opening
      : DEFAULT_SHARE_TEMPLATE.opening;
  const lines =
    Array.isArray(obj.lines) && obj.lines.length > 0 && obj.lines.every((l) => typeof l === "string")
      ? (obj.lines as string[])
      : DEFAULT_SHARE_TEMPLATE.lines;
  return { opening, lines };
}

/** Korvaa {nimi}-paikkamerkit. Tuntematon paikkamerkki jätetään näkyviin
 *  tarkoituksella: se paljastuu esikatselussa, joka on oikea paikka huomata
 *  kirjoitusvirhe — hiljaa katoava kohta huomattaisiin vasta lähetetystä
 *  viestistä. */
export function renderShareTemplate(template: ShareTemplate, values: Record<string, string>): string {
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
  return [template.opening, ...template.lines].map(fill).join("\n");
}

export const MATCH_URL_BASE = "https://www.pesistulokset.fi/ottelut/";

export const DEFAULT_HASHTAGS = ["#pesäpallo", "#pesäysit", "#live", "#livestream"];

/** YouTuben oma raja on 100 merkkiä; pidemmät katkeavat myös mobiilinäkymässä.
 *  Runbook sallii pitkien seuranimien lyhentämisen nimenomaan otsikossa. */
export const TITLE_MAX_LENGTH = 100;

/** Thumbnailin otsikkorivin budjetti merkkeinä.
 *
 *  Renderöijä (tools/pesaysit-thumbnail-compose.py) piirtää otsikon 86 px
 *  lihavoituna, korkeintaan kahdelle riville 1100 px leveään alueeseen, ja
 *  **katkaisee ylimenevän kolmella pisteellä pudottaen loppuosan kokonaan**.
 *  Livetestissä 74-merkkinen ottelupari näkyi muodossa
 *  "Jyväskylän Kiri & / Kirittäret Juniorit Ra…" — vastustajan nimi katosi
 *  kuvasta täysin. Kyse ei ole renderöijän viasta vaan liian pitkästä
 *  syötteestä, joten lyhennys kuuluu tänne. ~21 merkkiä mahtuu riville,
 *  kaksi riviä ≈ 42, josta on varattu marginaali rivityksen hukalle. */
export const THUMBNAIL_HEADLINE_MAX_LENGTH = 38;

/** Runbookin esimerkit yleisesti tunnetuista lyhennyksistä. Varatie niille
 *  nimille, joille tulospalvelu ei anna shorthandia — käytetään vasta kun
 *  täysi nimi ei mahdu. */
export const TEAM_ABBREVIATIONS: Record<string, string> = {
  "Seinäjoen Maila-Jussit": "SMJ",
  "Hyvinkään Tahko": "Tahko",
  "Kiteen Pallo -90": "KiPa-90",
  "Joensuun Maila": "JoMa",
};

// --- Aika -------------------------------------------------------------------

interface ZonedParts {
  date: string;
  time: string;
}

/** Suomalainen paikallisaika (d.m.yyyy + HH:MM) → API:n vaatima ISO/UTC.
 *  Portattu sellaisenaan `youtube-create-broadcast-with-stream.js`:stä: vyöhyke
 *  ratkaistaan Intl:llä eikä kiinteällä +2/+3-siirrolla, jotta kesä-/talviaika
 *  ja mahdollinen vyöhykemuutos hoituvat itsestään. */
export function localTimeToIso(dateStr: string, timeStr: string, timeZone: string = HELSINKI): string {
  const m = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) throw new Error(`Virheellinen päivämäärä (odotettiin d.m.yyyy): ${dateStr}`);
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);

  const t = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!t) throw new Error(`Virheellinen kellonaika (odotettiin HH:MM): ${timeStr}`);
  const hh = Number(t[1]);
  const mm = Number(t[2]);

  const dtUtcGuess = new Date(Date.UTC(year, month - 1, day, hh, mm, 0));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(dtUtcGuess)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const localAsIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = localAsIfUtc - dtUtcGuess.getTime();
  const utcMs = Date.UTC(year, month - 1, day, hh, mm, 0) - offsetMs;
  return new Date(utcMs).toISOString();
}

/** ISO-hetki → paikallinen d.m.yyyy + HH:MM annetulla vyöhykkeellä. */
export function formatIsoInZone(isoString: string, timeZone: string = HELSINKI): ZonedParts {
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) throw new Error(`Virheellinen aikaleima: ${isoString}`);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(dt)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${Number(parts.day)}.${Number(parts.month)}.${parts.year}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** Muuntaa paikallisajan ISO:ksi ja tarkistaa muunnoksen kääntämällä sen
 *  takaisin. Tämä on esikuvaskriptien turvaverkko, eikä sitä saa poistaa: väärä
 *  vyöhykepäättely siirtäisi lähetyksen kokonaisen tunnin väärään kohtaan, ja
 *  virhe huomattaisiin vasta kentällä. */
export function scheduledStartTimeFromLocal(
  dateStr: string,
  timeStr: string,
  timeZone: string = HELSINKI
): string {
  const iso = localTimeToIso(dateStr, timeStr, timeZone);
  const roundTrip = formatIsoInZone(iso, timeZone);
  if (roundTrip.date !== dateStr || roundTrip.time !== timeStr) {
    throw new Error(
      `Aikavyöhykkeen edestakaisin-tarkistus epäonnistui (${timeZone}): syöte ${dateStr} ${timeStr}, laskettu ${iso}, takaisin ${roundTrip.date} ${roundTrip.time}`
    );
  }
  return iso;
}

/** "15.7.2026 klo 13:30" — runbookin vakiomuoto käyttäjälle näytettäville
 *  ajoille (otsikko, kuvaus, thumbnail, jaettava viesti). */
export function formatScheduledLocal(dateStr: string, timeStr: string): string {
  return `${dateStr} klo ${timeStr}`;
}

// --- Syöte ------------------------------------------------------------------

/** Se osa pesistulokset-API:n ottelusta jota mallit tarvitsevat. Tarkoituksella
 *  oma tyyppi eikä `MatchOption`: kaava ei saa alkaa lukea `resultString`ia. */
export interface MatchLike {
  id: number;
  home: string;
  away: string;
  /** API:n `shorthand`, esim. "Joma Punainen". */
  homeShort?: string | null;
  awayShort?: string | null;
  /** API:n `three_letters`, esim. "JOM". */
  homeCode?: string | null;
  awayCode?: string | null;
  /** ISO/UTC sellaisena kuin API sen antaa. */
  startsAt: string | null;
  seriesName: string | null;
  stadium: string | null;
}

/** Yhden joukkueen nimi kolmella tarkkuudella. Lyhennys tehdään aina
 *  tulospalvelun omilla muodoilla ennen kuin turvaudutaan
 *  TEAM_ABBREVIATIONS-taulukkoon — API tuntee joukkueiden vakiintuneet
 *  lyhenteet paremmin kuin käsin ylläpidetty lista. */
export interface TeamNames {
  full: string;
  short?: string | null;
  code?: string | null;
}

/** Lyhennystasot: 0 = täysi nimi, 1 = shorthand, 2 = three_letters.
 *  Otsikkoon pudotaan asteittain, kuvaukseen jäävät aina täydet nimet
 *  (runbook: "Lyhennys tehdään ensisijaisesti otsikkoon"). */
export type ShorteningLevel = 0 | 1 | 2;

export function nameAtLevel(team: TeamNames, level: ShorteningLevel): string {
  const alias = TEAM_ABBREVIATIONS[team.full] ?? null;
  if (level === 0) return team.full;
  if (level === 1) return team.short ?? alias ?? team.full;
  return team.code ?? alias ?? team.short ?? team.full;
}

export interface MatchTemplateInput {
  matchId: number;
  home: string;
  away: string;
  /** Tulospalvelun lyhyemmät muodot; käytetään vain jos täysi nimi ei mahdu. */
  homeShort?: string | null;
  awayShort?: string | null;
  homeCode?: string | null;
  awayCode?: string | null;
  /** Otsikon ensimmäinen paikka = kotijoukkueen esitysnimi, esim.
   *  "Pesä Ysit E-tytöt kilpa". Oletuksena tulospalvelun kotijoukkue. */
  homeTeam?: string | null;
  /** Otsikon toinen paikka = vierasjoukkueen esitysnimi. Oletuksena
   *  tulospalvelun vierasjoukkue. */
  awayTeam?: string | null;
  /** Suomen paikallisaika. Annetaan joko nämä tai `startsAt`. */
  localDate?: string | null;
  localTime?: string | null;
  startsAt?: string | null;
  /** Tarkka pelipaikka kuvaukseen (runbook: kuvauksessa pidetään tarkka kenttä). */
  venue?: string | null;
  city?: string | null;
  /** Lyhyt paikkamuoto otsikkoon, esim. "Tenavaleiri Kempele". */
  shortVenue?: string | null;
  event?: string | null;
  stage?: string | null;
  seriesName?: string | null;
  ageGroup?: AgeGroup | null;
  playlistId?: string | null;
  hashtags?: string[];
}

export interface BroadcastTexts {
  title: string;
  narratedTitle: string;
  description: string;
  /** Jaettava viesti ilman linkkejä — paikkamerkit `<youtube-linkki>` jne.
   *  Esikatselu näyttää tämän; luonnin jälkeen kutsutaan buildShareMessage
   *  oikeilla osoitteilla. */
  shareMessage: string;
  playlistId: string | null;
  playlistName: string | null;
  ageGroup: AgeGroup | null;
  localDate: string;
  localTime: string;
  scheduledLocal: string;
  matchUrl: string;
  /** Ottelupari otsikon nimillä ("Pesä Ysit F-pojat - IPV"), jaettavaa viestiä
   *  varten — sama pari jonka otsikkokin saa. */
  matchup: string;
  /** Ottelupari erikseen, samalla päättelyllä kuin `matchup` (`teamPair`):
   *  koti ensin, vieras toisena. Käyttöliittymän "Muokkaa otsikkoa" -kentät
   *  tarvitsevat puolikkaat erikseen placeholdereiksi — pariviivan
   *  irrottaminen `matchup`ista clientissä olisi sama päättely toiseen kertaan
   *  ja rikkoutuisi heti kun joukkueen nimessä on väliviiva (#221). */
  homeTeam: string;
  awayTeam: string;
  /** videos.recordingDetails.locationDescription -kenttään. */
  venue: string;
  /** Valmiit syötteet renderThumbnail({ headline, datetime, venue, narrated }):lle. */
  thumbnailHeadline: string;
  thumbnailDatetime: string;
  thumbnailVenue: string;
}

// --- Apurit -----------------------------------------------------------------

/** Ikäluokka joukkueen tai sarjan nimestä: "Pesä Ysit E-tytöt kilpa" → E,
 *  "Pesä Ysit G 2026" → G. Jaetaan sanoiksi myös yhdysmerkistä, jolloin
 *  "E-tytöt" antaa erillisen "E"-sanan — tarkka sanavertailu estää sen että
 *  esim. "Kempele" osuisi E:hen. */
export function resolveAgeGroup(...candidates: Array<string | null | undefined>): AgeGroup | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const word of candidate.split(/[\s\-–—/]+/)) {
      const upper = word.toUpperCase();
      if (upper === "G" || upper === "E" || upper === "F" || upper === "D") return upper;
    }
  }
  return null;
}

export function playlistForAgeGroup(group: AgeGroup | null): { id: string; name: string } | null {
  if (!group) return null;
  return PLAYLISTS_2026[group];
}

export function matchUrlFor(matchId: number): string {
  return `${MATCH_URL_BASE}${matchId}`;
}

/** Otsikon lyhennys vasta kun se on pakko (runbook: "Jos otsikko uhkaa venya
 *  liian pitkaksi"). Täysi seuranimi on aina ensisijainen. */
export function shortenTitle(title: string, maxLength: number = TITLE_MAX_LENGTH): string {
  if (title.length <= maxLength) return title;
  let shortened = title;
  // Pisin nimi ensin, jottei osittainen osuma syö pidemmän nimen alkua.
  const entries = Object.entries(TEAM_ABBREVIATIONS).sort((a, b) => b[0].length - a[0].length);
  for (const [full, short] of entries) {
    if (shortened.length <= maxLength) break;
    shortened = shortened.split(full).join(short);
  }
  return shortened.length <= maxLength ? shortened : shortened.slice(0, maxLength).trimEnd();
}

function isOwnTeam(name: string): boolean {
  return OWN_TEAM_PATTERN.test(name);
}

function localPartsOf(input: MatchTemplateInput): ZonedParts {
  if (input.localDate && input.localTime) {
    return { date: input.localDate, time: input.localTime };
  }
  if (input.startsAt) return formatIsoInZone(input.startsAt, HELSINKI);
  throw new Error("Ottelun alkuaika puuttuu — anna joko startsAt tai localDate + localTime.");
}

/** Rakentaa mallien syötteen tulospalvelun ottelusta. Kaikki mitä API ei tiedä
 *  (tapahtuma, vaihe, lyhyt paikkamuoto) tulee kutsujan overrideista. */
/** `venueOptions` siivoaa tulospalvelun kenttänimen (#132). Yksi paikka, koska
 *  kenttänimi haarautuu tästä otsikkoon, kuvaukseen, thumbnailiin ja
 *  jakoviestiin — siivous myöhemmin tarkoittaisi neljää siivousta. Selostus
 *  käyttää samaa corea (`stadiumSpeechName`), joten puhuttu ja kirjoitettu
 *  kenttänimi pysyvät samana. */
export function templateInputFromMatch(
  match: MatchLike,
  overrides: Partial<MatchTemplateInput> = {},
  venueOptions: VenueNameOptions = {}
): MatchTemplateInput {
  return {
    matchId: match.id,
    home: match.home,
    away: match.away,
    homeShort: match.homeShort ?? null,
    awayShort: match.awayShort ?? null,
    homeCode: match.homeCode ?? null,
    awayCode: match.awayCode ?? null,
    startsAt: match.startsAt,
    seriesName: match.seriesName,
    venue: venueDisplayName(match.stadium, venueOptions) || null,
    ...overrides,
  };
}

// --- Kaavat -----------------------------------------------------------------

/** Otsikon ottelupari: **kotijoukkue ensin, vierasjoukkue toisena** — aina
 *  (#223). Aiempi sääntö "oma joukkue on aina vasemmalla" on poistettu:
 *  operaattori luki vieraana pelaavan oman joukkueen ensimmäisenä paikkana
 *  viaksi. Kutsujan antamat `homeTeam`/`awayTeam` ovat esitysnimen ohituksia
 *  samoihin paikkoihin, eivät järjestyksen ohituksia. */
function teamPair(input: MatchTemplateInput): { home: TeamNames; away: TeamNames } {
  const home: TeamNames = { full: input.home, short: input.homeShort, code: input.homeCode };
  const away: TeamNames = { full: input.away, short: input.awayShort, code: input.awayCode };
  return {
    // Ohitus vaihtaa vain täyden nimen; lyhennysmuodot säilyvät, jotta pitkä
    // otsikko lyhenee edelleen oikein.
    home: input.homeTeam ? { ...home, full: input.homeTeam } : home,
    away: input.awayTeam ? { ...away, full: input.awayTeam } : away,
  };
}

/** Ottelupari annetulla lyhennystasolla, esim. "Hyvinkään Tahko - Pesä Ysit E-tytöt kilpa". */
export function buildMatchupLabel(input: MatchTemplateInput, level: ShorteningLevel): string {
  const { home, away } = teamPair(input);
  return `${nameAtLevel(home, level)} - ${nameAtLevel(away, level)}`;
}

/** `<joukkue/sarja> - <vastustaja>, <pvm> <lyhyt paikka>` (runbook
 *  "Otsikointisaannot"). Ei lopputulosta — koskaan.
 *
 *  Nimet lyhennetään asteittain (täysi → shorthand → three_letters) kunnes
 *  otsikko mahtuu budjettiin. Kova katkaisu on vasta viimeinen keino: se
 *  pudottaa loppuosan näkyvistä, mikä on juuri se vika joka thumbnailissa
 *  hukkasi vastustajan nimen kokonaan. */
export function buildTitle(input: MatchTemplateInput, maxLength: number = TITLE_MAX_LENGTH): string {
  const { date } = localPartsOf(input);
  const place = input.shortVenue ?? input.city ?? input.venue ?? null;
  const tail = place ? `${date} ${place}` : date;
  for (const level of [0, 1, 2] as ShorteningLevel[]) {
    const candidate = `${buildMatchupLabel(input, level)}, ${tail}`;
    if (candidate.length <= maxLength) return candidate;
  }
  return shortenTitle(`${buildMatchupLabel(input, 2)}, ${tail}`, maxLength);
}

/** Thumbnailin rivi 1: pelkkä ottelupari, lyhennettynä niin että se mahtuu
 *  renderöijän kahdelle riville. renderThumbnail (thumbnail.ts) ottaa otsikon
 *  valmiina merkkijonona eikä lyhennä mitään — se vain katkaisee. */
export function buildThumbnailHeadline(
  input: MatchTemplateInput,
  maxLength: number = THUMBNAIL_HEADLINE_MAX_LENGTH
): string {
  for (const level of [0, 1, 2] as ShorteningLevel[]) {
    const candidate = buildMatchupLabel(input, level);
    if (candidate.length <= maxLength) return candidate;
  }
  return shortenTitle(buildMatchupLabel(input, 2), maxLength);
}

export function buildNarratedTitle(title: string): string {
  return `${NARRATED_PREFIX}${title}`;
}

/** Runbookin kuvausrakenne. Tyhjät rivit jätetään pois sen sijaan että
 *  kuvaukseen jäisi "Vaihe: —" roikkumaan. */
export function buildDescription(input: MatchTemplateInput): string {
  const { date, time } = localPartsOf(input);
  const lines: string[] = [`Ottelu: ${input.home} - ${input.away}`, `Päivä: ${formatScheduledLocal(date, time)}`];

  const place = [input.venue, input.city].filter((v): v is string => Boolean(v)).join(", ");
  if (place) lines.push(`Paikka: ${place}`);
  if (input.event) lines.push(`Tapahtuma: ${input.event}`);
  if (input.stage) lines.push(`Vaihe: ${input.stage}`);
  lines.push(`Tulospalvelu: ${matchUrlFor(input.matchId)}`);

  const hashtags = input.hashtags ?? DEFAULT_HASHTAGS;
  if (hashtags.length > 0) {
    lines.push("");
    lines.push(hashtags.join(" "));
  }
  return lines.join("\n");
}

export interface ShareLinks {
  watchUrl?: string | null;
  narratedWatchUrl?: string | null;
  matchUrl: string;
}

/** Yhden pelin jaettava viesti. Ei stream keytä eikä RTMP-osoitetta: tämä
 *  teksti menee ulkopuolisille — operaattorin omat tiedot ovat
 *  buildBroadcastSummaryssa.
 *
 *  Muotoilu tulee `run/share-template.json`ista (#95), jotta sanamuodon
 *  vaihtaminen ei vaadi koodimuutosta kesken leiripäivän. Oletus on
 *  DEFAULT_SHARE_TEMPLATE, eli sama kanoninen muoto kuin ennen. */
export function buildShareMessage(
  opts: { localTime: string; matchup: string },
  links: ShareLinks,
  template: ShareTemplate = DEFAULT_SHARE_TEMPLATE
): string {
  return renderShareTemplate(template, {
    time: opts.localTime,
    matchup: opts.matchup,
    // Ennen luontia linkkejä ei vielä ole. Paikkamerkki näkyy esikatselussa
    // sellaisenaan, jotta operaattori näkee mikä puuttuu.
    watchUrl: links.watchUrl ?? "<youtube-linkki>",
    narratedWatchUrl: links.narratedWatchUrl ?? "<selostettu-youtube-linkki>",
    matchUrl: links.matchUrl,
  });
}

/** Jakoviesti työn tiedoista (#131).
 *
 *  Erillään `buildShareMessage`ista, koska tämä vastaa toiseen kysymykseen:
 *  *voiko viestin jo jakaa*. Ennen lähetysten luontia viestin saa yhä, mutta
 *  linkkien tilalla on paikkamerkit — ja se tieto on kuljetettava mukana, tai
 *  käyttöliittymä näyttää operaattorille jaettavalta näyttävän tekstin, jossa
 *  lukee "<youtube-linkki>".
 *
 *  Muodostetaan pyynnöstä eikä talleteta luontihetkellä: luontivastaus näkyi
 *  vain kerran, ja työllä on kaikki tarvittava (`sourceUrl`, `targetVideoId`,
 *  `matchId`) pysyvästi. */
export function buildJobShareMessage(
  job: { sourceUrl: string | null; targetVideoId: string | null },
  texts: { localTime: string; matchup: string; matchUrl: string },
  template?: ShareTemplate
): JobShareMessage {
  const narratedWatchUrl = job.targetVideoId ? watchUrlForVideo(job.targetVideoId) : null;
  return {
    shareMessage: buildShareMessage(
      { localTime: texts.localTime, matchup: texts.matchup },
      { watchUrl: job.sourceUrl, narratedWatchUrl, matchUrl: texts.matchUrl },
      template
    ),
    linksReady: Boolean(job.sourceUrl && narratedWatchUrl),
  };
}

export interface DayShareEntry {
  localTime: string;
  matchup: string;
  links: ShareLinks;
}

/** Usean saman päivän pelin yhteisviesti (share-message-format-SKILL).
 *  Ensimmäisen rivin on silti alettava `Seuraava live on`. */
export function buildDayShareMessage(entries: DayShareEntry[], context?: string | null): string {
  if (entries.length === 0) throw new Error("Jaettavaan viestiin ei annettu yhtään ottelua.");
  if (entries.length === 1) {
    const only = entries[0];
    return buildShareMessage({ localTime: only.localTime, matchup: only.matchup }, only.links);
  }
  const sorted = [...entries].sort((a, b) => a.localTime.localeCompare(b.localTime));
  const intro = context
    ? `${SHARE_MESSAGE_OPENING}klo ${sorted[0].localTime}. Kuvaan tänään ${context}. Päivän pelit:`
    : `${SHARE_MESSAGE_OPENING}klo ${sorted[0].localTime}. Päivän pelit:`;
  const blocks = sorted.map((entry) =>
    [
      `Klo ${entry.localTime} ${entry.matchup}`,
      `YouTube: ${entry.links.watchUrl ?? "<youtube-linkki>"}`,
      `YouTube selostettu: ${entry.links.narratedWatchUrl ?? "<selostettu-youtube-linkki>"}`,
      `Tulospalvelu: ${entry.links.matchUrl}`,
    ].join("\n")
  );
  return [intro, "", ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b]))].join("\n");
}

export interface BroadcastSummaryInput {
  watchUrl: string;
  narratedWatchUrl: string;
  matchUrl: string;
  narratedTitle: string;
  rtmpUrl: string | null;
  backupUrl: string | null;
  videoId: string;
  streamKey: string | null;
}

/** Runbookin pakollinen palautusrunko selostetulle versiolle: RTMP URL,
 *  backup URL, video id ja stream key. Nämä neljä ovat pakolliset — älä
 *  karsi. Tämä on operaattorin oma teksti, ei jaettava. */
export function buildBroadcastSummary(input: BroadcastSummaryInput): string {
  return [
    `YouTube: ${input.watchUrl}`,
    `YouTube selostettu: ${input.narratedWatchUrl}`,
    `Tulospalvelu: ${input.matchUrl}`,
    "",
    "Broadcast:",
    `Otsikko: ${input.narratedTitle}`,
    `RTMP URL: ${input.rtmpUrl ?? "-"}`,
    `Backup URL: ${input.backupUrl ?? "-"}`,
    `Video ID: ${input.videoId}`,
    `Stream Key: ${input.streamKey ?? "-"}`,
  ].join("\n");
}

/** Koko tekstipaketti yhdellä kutsulla: tämä on se mitä esikatselureitti
 *  palauttaa ja mitä createBroadcastPair syö. */
export function buildBroadcastTexts(
  input: MatchTemplateInput,
  shareTemplate: ShareTemplate = DEFAULT_SHARE_TEMPLATE
): BroadcastTexts {
  const { date, time } = localPartsOf(input);
  const title = buildTitle(input);
  const pair = teamPair(input);
  // Ikäluokka luetaan ensisijaisesti OMASTA joukkueesta: vastustajan nimessä
  // voi olla oma kirjaimensa ("SuPo G mustat"), eikä video kuulu sen mukaan.
  // Tämä on `isOwnTeam`in ainoa jäljellä oleva tehtävä — otsikon järjestykseen
  // se ei enää vaikuta (#223), mutta soittolistan valintaan kyllä.
  const names = [nameAtLevel(pair.home, 0), nameAtLevel(pair.away, 0)];
  const ownFirst = isOwnTeam(names[1]) && !isOwnTeam(names[0]) ? [names[1], names[0]] : names;
  const ageGroup = input.ageGroup ?? resolveAgeGroup(...ownFirst, input.seriesName);
  const playlist = playlistForAgeGroup(ageGroup);
  const matchUrl = matchUrlFor(input.matchId);
  // Sama ottelupari kuin otsikossa (#95): kun operaattori on antanut
  // homeTeam/awayTeam-arvot ("IPV - Pesä Ysit F-pojat"), viestin pitää käyttää
  // niitä eikä tulospalvelun raakoja nimiä — viesti ja otsikko puhuvat samasta
  // pelistä samoilla nimillä. Lyhennystaso 0: viestissä ei ole pituusrajaa.
  const matchup = buildMatchupLabel(input, 0);
  const venue = [input.venue, input.city].filter((v): v is string => Boolean(v)).join(", ");

  return {
    title,
    narratedTitle: buildNarratedTitle(title),
    description: buildDescription(input),
    shareMessage: buildShareMessage({ localTime: time, matchup }, { matchUrl }, shareTemplate),
    playlistId: input.playlistId ?? playlist?.id ?? null,
    playlistName: input.playlistId ? null : (playlist?.name ?? null),
    ageGroup,
    localDate: date,
    localTime: time,
    scheduledLocal: formatScheduledLocal(date, time),
    matchUrl,
    matchup,
    homeTeam: nameAtLevel(pair.home, 0),
    awayTeam: nameAtLevel(pair.away, 0),
    venue: venue || (input.shortVenue ?? ""),
    thumbnailHeadline: buildThumbnailHeadline(input),
    thumbnailDatetime: formatScheduledLocal(date, time),
    // Thumbnailiin lyhyt paikkamuoto (runbook: "Leiripelit" — thumbnailissa
    // riittää lyhyt tieto), tarkka kenttä jää kuvaukseen.
    thumbnailVenue: input.shortVenue ?? input.city ?? venue,
  };
}
