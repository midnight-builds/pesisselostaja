/** YouTube Data API v3 -kutsut lähetysten luontiin ja jälkitöihin.
 *
 *  Tämä on **portattu** toimivasta tuotantokoodista
 *  (`.incoming/pesis-ai-youtube-pack-2026-07-28/tools/youtube-*.js`), ei
 *  keksitty uudelleen. Erityisesti createBroadcastPair noudattaa
 *  `youtube-create-broadcast-with-stream.js`:n ketjua kutsu kutsulta:
 *
 *    liveBroadcasts.insert (enableAutoStart/enableAutoStop/recordFromStart)
 *      -> videos PUT recordingDetails
 *      -> playlistItems.insert
 *      -> liveStreams.insert (isReusable:false)
 *      -> liveBroadcasts/bind
 *      -> liveStreams.list -> cdn.ingestionInfo
 *
 *  Järjestys ei ole makuasia: bind vaatii valmiin striimin, ja ingestionInfo
 *  (rtmpUrl / backupUrl / streamKey) on luettavissa vasta liveStreams.list
 *  -kutsulla bindin jälkeen. Aikavyöhykkeen edestakaisin-tarkistus tehdään
 *  templates.ts:n scheduledStartTimeFromLocal-funktiossa, ja se on säilytetty
 *  sellaisenaan.
 *
 *  **Jokainen luotu lähetys kirjataan NDJSON-lokiin run/youtube-created.ndjson
 *  heti kun sillä on video id.** Se on ainoa jälki siitä mitä on luotu: jos
 *  ketju katkeaa vaikka bindiin, lokista näkee silti mikä video jäi taivaalle
 *  roikkumaan. Stream keytä ei kirjata lokiin — se on haettavissa
 *  liveStreams.list-kutsulla eikä kuulu ikuiseen tiedostoon.
 *
 *  Tuhoavat toimet (poisto, näkyvyyden muutos) vaativat erillisen
 *  vahvistuksen; ilman sitä ne heittävät ConfirmationRequiredErrorin, jonka
 *  HTTP-kerros kääntää 400:ksi. */
import { readFile } from "node:fs/promises";
import { watchUrlForVideo } from "./youtubeUrl.js";
import { extname } from "node:path";
import { appendNdjson } from "./store.js";
import { getAccessToken, recordQuota, type QuotaOp } from "./googleAuth.js";
import {
  buildBroadcastSummary,
  buildShareMessage,
  scheduledStartTimeFromLocal,
  formatScheduledLocal,
  HELSINKI,
  type BroadcastTexts,
  type ShareTemplate,
} from "./templates.js";

const API_BASE = "https://www.googleapis.com/youtube/v3/";
/** Kokonaisaikaraja yhdelle YouTube-kutsulle. Kaikki kutsujat ovat joko
 *  operaattorin odottamia pyyntöjä tai aggregaattorin tikillä ajavia, eikä
 *  kummassakaan ole varaa odottaa loputtomiin. */
const YT_REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_THUMBNAIL_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";

/** Ainoa tiedosto, josta näkee mitä kanavalle on tämän sovelluksen kautta
 *  luotu (runbookin "Lokitus"-kenttien mukaisesti). */
export const CREATED_LOG = "youtube-created.ndjson";

export type PrivacyStatus = "public" | "unlisted" | "private";

/** Näkyvyys on oletuksena unlisted (runbook): linkin saaneet näkevät, mutta
 *  lapsijoukkueen peli ei päädy kanavan julkiseen listaan vahingossa. */
export const DEFAULT_PRIVACY: PrivacyStatus = "unlisted";

export class YouTubeApiError extends Error {
  readonly status: number;

  constructor(path: string, status: number, body: unknown) {
    super(`YouTube API ${path} -> HTTP ${status}: ${JSON.stringify(body)}`);
    this.name = "YouTubeApiError";
    this.status = status;
  }
}

/** Heitetään kun tuhoava toimi yritetään ilman { confirm: true }. */
export class ConfirmationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationRequiredError";
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

/** Yksi YouTube-kutsu: token, kiintiökirjaus ja virheiden muotoilu yhdessä
 *  paikassa. `op` kertoo kiintiöhinnan — se on annettava aina, koska
 *  YouTube ei kerro kulutusta itse (googleAuth.ts). */
async function ytRequest<T>(
  method: string,
  path: string,
  params: Params,
  body: unknown,
  op: QuotaOp
): Promise<T> {
  const accessToken = await getAccessToken();
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    // Ilman aikarajaa yksi roikkuva kutsu jäädyttää kutsujan. Hard stopin
    // siivous (#123) ajetaan aggregaattorin nopealla tikillä ennen työn
    // sulkemista, joten roikkuva kutsu pysäyttäisi koko ohjaamon näkymän ja
    // jättäisi työn "live"-tilaan lukitsemaan seuraavan ottelun (#101).
    signal: AbortSignal.timeout(YT_REQUEST_TIMEOUT_MS),
  });
  // Kiintiö kuluu myös epäonnistuneesta kutsusta, joten kirjaus tehdään ennen
  // virheen heittoa.
  await recordQuota(op);
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new YouTubeApiError(path, res.status, errorBody);
  }
  // videos.delete vastaa 204:llä ilman runkoa.
  if (res.status === 204) return {} as T;
  return (await res.json().catch(() => ({}))) as T;
}

// --- Vastausmuodot (vain ne kentät joita luetaan) ----------------------------

interface LiveBroadcastResource {
  id?: string;
  snippet?: { title?: string; description?: string; scheduledStartTime?: string; actualStartTime?: string };
  status?: { privacyStatus?: string; lifeCycleStatus?: string };
  contentDetails?: { boundStreamId?: string };
}

interface LiveStreamResource {
  id?: string;
  cdn?: {
    ingestionInfo?: {
      ingestionAddress?: string;
      backupIngestionAddress?: string;
      streamName?: string;
    };
  };
  // healthStatus on sisäkkäinen objekti, ei merkkijono — YouTube palauttaa
  // sen muodossa { status: "good" | "ok" | "bad" | "noData", ... }.
  status?: { streamStatus?: string; healthStatus?: { status?: string } };
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

// --- Luontiketju ------------------------------------------------------------

export interface BroadcastJobInput {
  /** pesistulokset-ottelun id; päätyy lokiin jäljitettävyyden vuoksi. */
  matchId: number;
  /** Ohjaussovelluksen työn id, jos luonti tehdään työlle. */
  jobId?: string | null;
  /** Suomen paikallisaika, d.m.yyyy. */
  localDate: string;
  /** Suomen paikallisaika, HH:MM. */
  localTime: string;
  /** Tarkka pelipaikka -> videos.recordingDetails.locationDescription. */
  venue: string;
  privacy?: PrivacyStatus;
  playlistId?: string | null;
  timeZone?: string;
  sourceMatchUrl?: string | null;
  /** DESIGN.md "YouTube-ketju": uusi stream key per lähetys, myös normaalille
   *  versiolle — kuvauspuhelimen Streamlabs tarvitsee oman avaimen, eikä
   *  uudelleenkäytettävä striimi saa sotkeutua selostetun kanssa. Aseta
   *  false, jos halutaan runbookin alkuperäinen malli, jossa normaali
   *  lähetys nojaa kanavan oletusavaimeen. */
  streamForNormal?: boolean;
  /** Normaalin version automaattinen käynnistys, kun lähde alkaa työntää.
   *  DESIGN.md:n laukaisumalli ("lähde menee liveen -> relay käynnistyy")
   *  edellyttää tätä; esikuvaskripti loi normaalin ilman automatiikkaa. */
  normalAutoStart?: boolean;
}

export interface CreatedBroadcast {
  variant: "normal" | "narrated";
  videoId: string;
  watchUrl: string;
  title: string;
  scheduledStartTime: string;
  scheduledLocal: string;
  privacy: PrivacyStatus;
  playlistId: string | null;
  streamId: string | null;
  rtmpUrl: string | null;
  backupUrl: string | null;
  streamKey: string | null;
  streamStatus: string | null;
}

export interface BroadcastPair {
  normal: CreatedBroadcast;
  narrated: CreatedBroadcast;
  /** Ulkopuolisille jaettava viesti (ei stream keytä). */
  shareMessage: string;
  /** Operaattorin oma kooste: RTMP URL, backup URL, video id, stream key. */
  broadcastSummary: string;
}



async function logCreated(row: Record<string, unknown>): Promise<void> {
  await appendNdjson(CREATED_LOG, { createdAtUtc: new Date().toISOString(), ...row });
}

/** Luo yhden lähetyksen ja (valinnaisesti) sille oman striimin. Yhteinen
 *  runko normaalille ja selostetulle versiolle — ero on vain otsikossa,
 *  automaattikäynnistyksessä ja siinä tarvitaanko oma stream key. */
async function createOne(
  variant: "normal" | "narrated",
  title: string,
  input: BroadcastJobInput & { description: string; scheduledStartTime: string; withStream: boolean; autoStart: boolean }
): Promise<CreatedBroadcast> {
  const privacy = input.privacy ?? DEFAULT_PRIVACY;

  const created = await ytRequest<LiveBroadcastResource>(
    "POST",
    "liveBroadcasts",
    { part: "snippet,status,contentDetails" },
    {
      snippet: {
        title,
        description: input.description,
        scheduledStartTime: input.scheduledStartTime,
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        enableAutoStart: input.autoStart,
        enableAutoStop: input.autoStart,
        // Aina päälle: jokaisesta pelistä pitää jäädä katsottava tallenne
        // (DESIGN.md "Työn yksikkö").
        recordFromStart: true,
        latencyPreference: "normal",
      },
    },
    "insert"
  );

  const videoId = created.id;
  if (!videoId) throw new Error("YouTube ei palauttanut lähetykselle id:tä.");
  const watchUrl = watchUrlForVideo(videoId);

  // Kirjataan heti kun id on tiedossa: jos jokin seuraavista vaiheista
  // kaatuu, lokista näkee silti mitä kanavalle jäi.
  await logCreated({
    event: "broadcast.created",
    variant,
    videoId,
    watchUrl,
    title,
    scheduledLocal: formatScheduledLocal(input.localDate, input.localTime),
    scheduledStartTime: input.scheduledStartTime,
    privacy,
    location: input.venue,
    sourceMatchId: input.matchId,
    sourceMatchUrl: input.sourceMatchUrl ?? null,
    jobId: input.jobId ?? null,
  });

  await ytRequest(
    "PUT",
    "videos",
    { part: "recordingDetails" },
    { id: videoId, recordingDetails: { locationDescription: input.venue } },
    "update"
  );

  let playlistId: string | null = null;
  if (input.playlistId) {
    await addToPlaylist(input.playlistId, videoId);
    playlistId = input.playlistId;
  }

  if (!input.withStream) {
    return {
      variant,
      videoId,
      watchUrl,
      title,
      scheduledStartTime: input.scheduledStartTime,
      scheduledLocal: formatScheduledLocal(input.localDate, input.localTime),
      privacy,
      playlistId,
      streamId: null,
      rtmpUrl: null,
      backupUrl: null,
      streamKey: null,
      streamStatus: null,
    };
  }

  const createdStream = await ytRequest<LiveStreamResource>(
    "POST",
    "liveStreams",
    { part: "snippet,cdn,contentDetails" },
    {
      snippet: { title: `${title} stream` },
      cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
      // Kertakäyttöinen striimi: uusi stream key per lähetys, jottei edellisen
      // pelin avain jää elämään ja työnnä kuvaa väärään lähetykseen.
      contentDetails: { isReusable: false },
    },
    "insert"
  );
  const streamId = createdStream.id;
  if (!streamId) throw new Error("YouTube ei palauttanut striimille id:tä.");

  await ytRequest("POST", "liveBroadcasts/bind", { id: videoId, part: "id,contentDetails", streamId }, null, "bind");

  const details = await ytRequest<ListResponse<LiveStreamResource>>(
    "GET",
    "liveStreams",
    { id: streamId, part: "snippet,cdn,status,contentDetails" },
    null,
    "list"
  );
  // Puuttuva rivi on VIRHE, ei nullien lähde (#162). Juuri luodun striimin
  // replikointiviive vastaa 200 OK:lla ja tyhjällä items-listalla, jolloin
  // stream key jäisi nulliksi vaikka videoId on oikein — ja työhön kirjoittuisi
  // pari, jonka avain ja video ovat eri lähetyksistä. Heittäminen on tässä
  // turvallista: lähetykset ovat jo olemassa, ja operaattori näkee selvän
  // virheen sen sijaan että saisi hiljaa vajaan parin.
  const stream = details.items?.[0];
  if (!stream) {
    throw new Error(
      `YouTube ei palauttanut juuri luodun striimin ${streamId} tietoja — lähetykset on luotu, mutta stream key jäi saamatta. Yritä luontia uudelleen vasta kun olet poistanut juuri luodut lähetykset.`
    );
  }
  const ingestion = stream.cdn?.ingestionInfo ?? {};
  // Sama sääntö yhtä kenttää syvemmällä (#203). Puuttuva `items`-rivi oli
  // virhe jo #184:stä lähtien, mutta täytetty rivi ilman `ingestionInfo`a
  // tuotti hiljaisen nullin täsmälleen kuten ennen korjausta — sama
  // replikointiviive, sama lopputulos: pari ilman avainta, jolla relayn
  // preflight estää käynnistyksen aina. Ilman avainta striimillä ei ole
  // mitään käyttöä, joten se on virhe eikä puuttuva lisätieto.
  if (!ingestion.streamName || !ingestion.ingestionAddress) {
    throw new Error(
      `YouTube ei palauttanut striimin ${streamId} työntötietoja — lähetykset on luotu, mutta stream key jäi saamatta. Yritä luontia uudelleen vasta kun olet poistanut juuri luodut lähetykset.`
    );
  }

  // Stream key EI päädy lokiin — se on haettavissa liveStreams.list-kutsulla.
  await logCreated({ event: "stream.bound", variant, videoId, streamId, jobId: input.jobId ?? null });

  return {
    variant,
    videoId,
    watchUrl,
    title,
    scheduledStartTime: input.scheduledStartTime,
    scheduledLocal: formatScheduledLocal(input.localDate, input.localTime),
    privacy,
    playlistId,
    streamId,
    rtmpUrl: ingestion.ingestionAddress ?? null,
    backupUrl: ingestion.backupIngestionAddress ?? null,
    streamKey: ingestion.streamName ?? null,
    streamStatus: stream.status?.streamStatus ?? null,
  };
}

/** Luo ottelulle BÅDE normaalin että "Selostettu"-version.
 *
 *  Selostettu luodaan **aina ilman erillistä kysymystä**
 *  (pesis-ai-youtube-leirimalli-SKILL): se on koko ohjaussovelluksen syy
 *  olla olemassa, ja sen neljä palautettavaa kenttää (rtmpUrl, backupUrl,
 *  videoId, streamKey) ovat runbookin mukaan pakollisia. */
export async function createBroadcastPair(
  job: BroadcastJobInput,
  texts: BroadcastTexts,
  shareTemplate?: ShareTemplate
): Promise<BroadcastPair> {
  const timeZone = job.timeZone ?? HELSINKI;
  // Heittää jos vyöhykemuunnos ei käänny takaisin samaksi paikallisajaksi —
  // väärä tunti huomattaisiin muuten vasta kentällä.
  const scheduledStartTime = scheduledStartTimeFromLocal(job.localDate, job.localTime, timeZone);

  const playlistId = job.playlistId === undefined ? texts.playlistId : job.playlistId;
  const shared = {
    ...job,
    playlistId,
    description: texts.description,
    scheduledStartTime,
    // Kuvaus on selostetussa sama kuin normaalissa (runbook).
  };

  const normal = await createOne("normal", texts.title, {
    ...shared,
    withStream: job.streamForNormal ?? true,
    autoStart: job.normalAutoStart ?? true,
  });

  const narrated = await createOne("narrated", texts.narratedTitle, {
    ...shared,
    // Selostetulla aina oma striimi ja enableAutoStart/enableAutoStop=true:
    // relay työntää kuvaa ilman että kukaan painaa mitään YouTube Studiossa.
    withStream: true,
    autoStart: true,
  });

  // Sama muotoilu kuin esikatselussa (#95) — vain linkit ovat nyt oikeat.
  const shareMessage = buildShareMessage(
    { localTime: texts.localTime, matchup: texts.matchup },
    { watchUrl: normal.watchUrl, narratedWatchUrl: narrated.watchUrl, matchUrl: texts.matchUrl },
    shareTemplate
  );

  const broadcastSummary = buildBroadcastSummary({
    watchUrl: normal.watchUrl,
    narratedWatchUrl: narrated.watchUrl,
    matchUrl: texts.matchUrl,
    narratedTitle: narrated.title,
    rtmpUrl: narrated.rtmpUrl,
    backupUrl: narrated.backupUrl,
    videoId: narrated.videoId,
    streamKey: narrated.streamKey,
  });

  return { normal, narrated, shareMessage, broadcastSummary };
}

// --- Listaus ja jälkityöt ---------------------------------------------------

export interface BroadcastSummary {
  videoId: string;
  title: string;
  watchUrl: string;
  scheduledStartTime: string | null;
  actualStartTime: string | null;
  lifeCycleStatus: string | null;
  privacyStatus: string | null;
  boundStreamId: string | null;
}

/** Kanavan omat lähetykset. `status` = YouTuben broadcastStatus
 *  (upcoming/active/completed/all).
 *
 *  `id` hakee yhden tunnetun videon. Se on **eri suodatin** kuin
 *  broadcastStatus, eikä niitä saa lähettää samassa pyynnössä: YouTube Data
 *  API:ssa `id` ja `mine`/`broadcastStatus` sulkevat toisensa pois, ja
 *  `broadcastType` on dokumentoitu käytettäväksi vain `mine`/`broadcastStatus`
 *  -pyynnöissä. Tyhjä tulos id-haussa on **normaali** vastaus — video ei
 *  yksinkertaisesti ole omalla kanavalla — ei virhe. */
export async function listBroadcasts(
  opts: { id?: string; status?: "upcoming" | "active" | "completed" | "all"; maxResults?: number } = {}
): Promise<BroadcastSummary[]> {
  const filter: Params = opts.id
    ? { id: opts.id }
    : {
        broadcastStatus: opts.status ?? "all",
        broadcastType: "all",
        maxResults: Math.min(Math.max(opts.maxResults ?? 25, 1), 50),
      };
  const response = await ytRequest<ListResponse<LiveBroadcastResource>>(
    "GET",
    "liveBroadcasts",
    {
      // Sama part molemmissa haussa, jotta boundStreamId ja lifeCycleStatus
      // tulevat mukana myös id-haussa.
      part: "id,snippet,status,contentDetails",
      ...filter,
    },
    null,
    "list"
  );
  return (response.items ?? [])
    .filter((item): item is LiveBroadcastResource & { id: string } => Boolean(item.id))
    .map((item) => ({
      videoId: item.id,
      title: item.snippet?.title ?? "",
      watchUrl: watchUrlForVideo(item.id),
      scheduledStartTime: item.snippet?.scheduledStartTime ?? null,
      actualStartTime: item.snippet?.actualStartTime ?? null,
      lifeCycleStatus: item.status?.lifeCycleStatus ?? null,
      privacyStatus: item.status?.privacyStatus ?? null,
      boundStreamId: item.contentDetails?.boundStreamId ?? null,
    }));
}

export interface StreamStatus {
  streamId: string;
  /** YouTuben raaka arvo: created|ready|active|inactive|error. Tallennetaan
   *  sellaisenaan — vain "active" tarkoittaa että dataa virtaa sisään. */
  streamStatus: string | null;
  /** status.healthStatus.status: good|ok|bad|noData. */
  healthStatus: string | null;
}

/** Yhden striimin tila. Tämä on ainoa tieto siitä, työntääkö lähde oikeasti
 *  kuvaa sisään: lähetyksen lifeCycleStatus voi olla "live" vaikka ingest
 *  olisi jo katkennut. Tuntematon striimi (esim. poistettu) ei ole virhe
 *  vaan null. */
export async function getStreamStatus(streamId: string): Promise<StreamStatus | null> {
  const response = await ytRequest<ListResponse<LiveStreamResource>>(
    "GET",
    "liveStreams",
    { id: streamId, part: "status" },
    null,
    "list"
  );
  const item = response.items?.[0];
  if (!item) return null;
  return {
    streamId,
    streamStatus: item.status?.streamStatus ?? null,
    healthStatus: item.status?.healthStatus?.status ?? null,
  };
}

/** Lopetuksen tulos. Ei heitä "ei ollut liveä" -tapauksissa: kutsuja
 *  (hard stopin siivous, live.ts) haluaa lokittaa mitä tehtiin ja miksi, eikä
 *  siivouksen ohitus ole virhe. Aidot API-virheet heitetään yhä
 *  YouTubeApiErrorina. */
export interface TransitionResult {
  videoId: string;
  /** true = transitio tehtiin nyt. */
  ok: boolean;
  /** true = ei tehty mitään, koska ei ollut tarpeen tai mahdollista. */
  skipped: boolean;
  /** Ihmisluettava syy, aina täytetty — lokirivin sisältö. */
  reason: string;
  /** Tila ennen kutsua, jos lähetys löytyi kanavalta. */
  lifeCycleStatus: string | null;
}

/** Lopettaa lähetyksen (`liveBroadcasts.transition` -> `complete`).
 *
 *  Idempotentti tarkoituksella: tila luetaan ensin, koska YouTube vastaa
 *  virheellä jos lähetys ei ole transitoitavassa tilassa, ja siivouksen
 *  toistuminen (tikki uudestaan, käsin ajettu lopetus) on normaalia.
 *
 *  Tyhjä id-haku ei ole virhe vaan tieto: video ei ole omalla kanavalla, joten
 *  meillä ei ole oikeutta lopettaa sitä. Ainoat tilat joista transitio tehdään
 *  ovat `live` ja `testing`. */
export async function transitionBroadcast(
  videoId: string,
  broadcastStatus: "complete" = "complete"
): Promise<TransitionResult> {
  const found = await listBroadcasts({ id: videoId });
  const broadcast = found[0];
  if (!broadcast) {
    return {
      videoId,
      ok: false,
      skipped: true,
      reason: "lähetys ei ole tämän kanavan omistama (id-haku palautti tyhjän) — ei oikeutta lopettaa",
      lifeCycleStatus: null,
    };
  }
  const state = broadcast.lifeCycleStatus;
  if (state !== "live" && state !== "testing") {
    return {
      videoId,
      ok: false,
      skipped: true,
      reason: `lähetys ei ole live (lifeCycleStatus=${state ?? "?"}) — ei lopetettavaa`,
      lifeCycleStatus: state,
    };
  }
  await ytRequest<LiveBroadcastResource>(
    "POST",
    "liveBroadcasts/transition",
    { id: videoId, broadcastStatus, part: "id,status" },
    null,
    "update"
  );
  await logCreated({ event: "broadcast.transition", videoId, broadcastStatus, from: state });
  return {
    videoId,
    ok: true,
    skipped: false,
    reason: `lopetettu (${state} -> ${broadcastStatus})`,
    lifeCycleStatus: state,
  };
}

export interface PlaylistSummary {
  id: string;
  title: string;
  itemCount: number | null;
}

export async function listPlaylists(maxResults = 50): Promise<PlaylistSummary[]> {
  const response = await ytRequest<
    ListResponse<{ id?: string; snippet?: { title?: string }; contentDetails?: { itemCount?: number } }>
  >("GET", "playlists", { part: "snippet,contentDetails", mine: true, maxResults }, null, "list");
  return (response.items ?? [])
    .filter((item): item is { id: string; snippet?: { title?: string }; contentDetails?: { itemCount?: number } } =>
      Boolean(item.id)
    )
    .map((item) => ({
      id: item.id,
      title: item.snippet?.title ?? "",
      itemCount: item.contentDetails?.itemCount ?? null,
    }));
}

export async function addToPlaylist(playlistId: string, videoId: string): Promise<{ playlistItemId: string | null }> {
  const created = await ytRequest<{ id?: string }>(
    "POST",
    "playlistItems",
    { part: "snippet" },
    {
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
      },
    },
    "insert"
  );
  await logCreated({ event: "playlist.added", videoId, playlistId, playlistItemId: created.id ?? null });
  return { playlistItemId: created.id ?? null };
}

export interface VideoMetadataPatch {
  title?: string;
  description?: string;
  /** TUHOAVA: näkyvyyden muutos voi piilottaa julkaistun videon katsojilta,
   *  joten se vaatii erillisen vahvistuksen. */
  privacyStatus?: PrivacyStatus;
}

/** videos.update korvaa koko snippetin, joten nykyinen on luettava ensin —
 *  muuten pelkän otsikon muutos nollaisi kuvauksen ja kategorian. */
export async function updateVideoMetadata(
  videoId: string,
  patch: VideoMetadataPatch,
  opts: { confirm?: boolean } = {}
): Promise<{ videoId: string; title: string; privacyStatus: string | null }> {
  if (patch.privacyStatus && !opts.confirm) {
    throw new ConfirmationRequiredError(
      "Näkyvyyden muuttaminen on tuhoava toimi (video voi kadota katsojilta). Lähetä { confirm: true } jos tämä on tarkoitus."
    );
  }

  const current = await ytRequest<
    ListResponse<{ snippet?: Record<string, unknown>; status?: Record<string, unknown> }>
  >("GET", "videos", { part: "snippet,status", id: videoId }, null, "list");
  const item = current.items?.[0];
  if (!item) throw new Error(`Videota ${videoId} ei löytynyt.`);

  const snippet = { ...(item.snippet ?? {}) };
  if (patch.title !== undefined) snippet.title = patch.title;
  if (patch.description !== undefined) snippet.description = patch.description;
  const status = { ...(item.status ?? {}) };
  if (patch.privacyStatus !== undefined) status.privacyStatus = patch.privacyStatus;

  const updated = await ytRequest<{ snippet?: { title?: string }; status?: { privacyStatus?: string } }>(
    "PUT",
    "videos",
    { part: "snippet,status" },
    { id: videoId, snippet, status },
    "update"
  );

  await logCreated({
    event: "video.updated",
    videoId,
    changed: Object.keys(patch),
    privacyStatus: updated.status?.privacyStatus ?? null,
  });

  return {
    videoId,
    title: updated.snippet?.title ?? String(snippet.title ?? ""),
    privacyStatus: updated.status?.privacyStatus ?? null,
  };
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Thumbnailin lataus. Riittää youtube-oikeus (ks. SCOPES). Kuva luetaan
 *  levyltä (thumbnail.ts renderöi sen) tai annetaan valmiina puskurina. */
export async function setThumbnail(
  videoId: string,
  image: string | Uint8Array,
  contentType?: string
): Promise<{ videoId: string }> {
  const buffer = typeof image === "string" ? await readFile(image) : Buffer.from(image);
  const mime =
    contentType ?? (typeof image === "string" ? (IMAGE_MIME[extname(image).toLowerCase()] ?? "image/png") : "image/png");

  const accessToken = await getAccessToken();
  const url = new URL(UPLOAD_THUMBNAIL_URL);
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("uploadType", "media");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": mime,
      "content-length": String(buffer.length),
    },
    body: buffer,
  });
  await recordQuota("thumbnail");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new YouTubeApiError("thumbnails/set", res.status, body);
  }
  await logCreated({ event: "thumbnail.set", videoId });
  return { videoId };
}

/** TUHOAVA: poistaa videon lopullisesti. Vaatii { confirm: true } ja kirjaa
 *  poiston samaan NDJSON-lokiin — muuten poistetusta lähetyksestä ei jäisi
 *  minkäänlaista jälkeä. */
export async function deleteVideo(videoId: string, opts: { confirm?: boolean } = {}): Promise<{ videoId: string }> {
  if (!opts.confirm) {
    throw new ConfirmationRequiredError(
      "Videon poisto on peruuttamaton. Lähetä { confirm: true } jos tämä on varmasti tarkoitus."
    );
  }
  await ytRequest("DELETE", "videos", { id: videoId }, null, "delete");
  await logCreated({ event: "video.deleted", videoId });
  return { videoId };
}
