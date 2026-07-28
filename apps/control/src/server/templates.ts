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
 *     leirimallin SKILLin nimenomainen vaatimus, ei tyyliseikka. */

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

/** Otsikon vasen puoli on aina *oma* joukkue, vastustaja oikealla, riippumatta
 *  siitä kumpi on koti- ja kumpi vierasjoukkue tulospalvelussa. */
export const OWN_TEAM_PATTERN = /pes[äa]\s*ysit/i;

export const NARRATED_PREFIX = "Selostettu ";

/** Leirimallin SKILL: viesti aloitetaan aina tällä fraasilla, merkilleen. */
export const SHARE_MESSAGE_OPENING = "Seuraava live on ";

export const MATCH_URL_BASE = "https://www.pesistulokset.fi/ottelu/";

export const DEFAULT_HASHTAGS = ["#pesäpallo", "#pesäysit", "#live", "#livestream"];

/** YouTuben oma raja on 100 merkkiä; pidemmät katkeavat myös mobiilinäkymässä.
 *  Runbook sallii pitkien seuranimien lyhentämisen nimenomaan otsikossa. */
export const TITLE_MAX_LENGTH = 100;

/** Runbookin esimerkit yleisesti tunnetuista lyhennyksistä. Käytetään VAIN jos
 *  otsikko uhkaa venyä yli rajan — normaalisti täysi nimi on parempi. */
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
  /** ISO/UTC sellaisena kuin API sen antaa. */
  startsAt: string | null;
  seriesName: string | null;
  stadium: string | null;
}

export interface MatchTemplateInput {
  matchId: number;
  home: string;
  away: string;
  /** Otsikon vasen puoli, esim. "Pesä Ysit E-tytöt kilpa". Oletuksena se
   *  joukkueista joka tunnistuu omaksi, muuten kotijoukkue. */
  teamLabel?: string | null;
  /** Otsikon oikea puoli. Oletuksena toinen joukkue. */
  opponent?: string | null;
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
  /** Ottelupari muodossa "Koti - Vieras", jaettavaa viestiä varten. */
  matchup: string;
  /** videos.recordingDetails.locationDescription -kenttään. */
  venue: string;
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
export function templateInputFromMatch(
  match: MatchLike,
  overrides: Partial<MatchTemplateInput> = {}
): MatchTemplateInput {
  return {
    matchId: match.id,
    home: match.home,
    away: match.away,
    startsAt: match.startsAt,
    seriesName: match.seriesName,
    venue: match.stadium,
    ...overrides,
  };
}

// --- Kaavat -----------------------------------------------------------------

/** `<joukkue/sarja> - <vastustaja>, <pvm> <lyhyt paikka>` (runbook
 *  "Otsikointisaannot"). Ei lopputulosta — koskaan. */
export function buildTitle(input: MatchTemplateInput): string {
  const ownIsHome = isOwnTeam(input.home);
  const ownIsAway = isOwnTeam(input.away);
  const teamLabel = input.teamLabel ?? (ownIsAway && !ownIsHome ? input.away : input.home);
  const opponent = input.opponent ?? (ownIsAway && !ownIsHome ? input.home : input.away);
  const { date } = localPartsOf(input);
  const place = input.shortVenue ?? input.city ?? input.venue ?? null;
  const tail = place ? `${date} ${place}` : date;
  return shortenTitle(`${teamLabel} - ${opponent}, ${tail}`);
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

/** Yhden pelin jaettava viesti. Ensimmäinen rivi alkaa aina merkilleen
 *  `Seuraava live on ` (leirimallin SKILL). Ei stream keytä eikä RTMP-osoitetta:
 *  tämä teksti menee ulkopuolisille — operaattorin omat tiedot ovat
 *  buildBroadcastSummaryssa. */
export function buildShareMessage(
  opts: { localTime: string; matchup: string },
  links: ShareLinks
): string {
  const watch = links.watchUrl ?? "<youtube-linkki>";
  const narrated = links.narratedWatchUrl ?? "<selostettu-youtube-linkki>";
  return [
    `${SHARE_MESSAGE_OPENING}klo ${opts.localTime}: ${opts.matchup}. Alla linkit:`,
    `YouTube: ${watch}`,
    `YouTube selostettu: ${narrated}`,
    `Tulospalvelu: ${links.matchUrl}`,
  ].join("\n");
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
export function buildBroadcastTexts(input: MatchTemplateInput): BroadcastTexts {
  const { date, time } = localPartsOf(input);
  const title = buildTitle(input);
  // Ikäluokka luetaan ensisijaisesti OMASTA joukkueesta: vastustajan nimessä
  // voi olla oma kirjaimensa ("SuPo G mustat"), eikä video kuulu sen mukaan.
  const ownFirst = isOwnTeam(input.away) && !isOwnTeam(input.home) ? [input.away, input.home] : [input.home, input.away];
  const ageGroup =
    input.ageGroup ?? resolveAgeGroup(input.teamLabel, ...ownFirst, input.seriesName);
  const playlist = playlistForAgeGroup(ageGroup);
  const matchUrl = matchUrlFor(input.matchId);
  const matchup = `${input.home} - ${input.away}`;

  return {
    title,
    narratedTitle: buildNarratedTitle(title),
    description: buildDescription(input),
    shareMessage: buildShareMessage({ localTime: time, matchup }, { matchUrl }),
    playlistId: input.playlistId ?? playlist?.id ?? null,
    playlistName: input.playlistId ? null : (playlist?.name ?? null),
    ageGroup,
    localDate: date,
    localTime: time,
    scheduledLocal: formatScheduledLocal(date, time),
    matchUrl,
    matchup,
    venue: [input.venue, input.city].filter((v): v is string => Boolean(v)).join(", ") || (input.shortVenue ?? ""),
  };
}
