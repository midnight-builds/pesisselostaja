/** Client side of the HTTP contract in ../shared/api.ts.
 *
 *  Everything the UI does to the server goes through here, so error handling
 *  and the SSE reconnect policy live in exactly one place. */

import type { ApiError, CreateJobRequest, PatchJobRequest, PatchKnobsRequest } from "../shared/api";
import { DEFAULT_RTMP_URL } from "../shared/api";
import type {
  ControlKnobs,
  ControlSettings,
  DayMatches,
  Job,
  LiveState,
  LogLine,
  MatchOption,
  PreflightResult,
  RelayProcess,
  JobShareMessage,
  SchedulerState,
} from "../shared/types";
/** The YouTube chain's response shapes are the server module's own exported
 *  types, imported TYPE-ONLY: `import type` is erased before the bundle is
 *  written, so no node code (fs, child_process, tokens) can follow them into
 *  the browser — but a change on the server still breaks this typecheck
 *  instead of the phone. They belong in ../shared eventually; that file is
 *  being edited by another workstream, so they are referenced at the source
 *  rather than copied into a second, drifting definition. */
import type { AuthHealth, DeviceFlowPoll, DeviceFlowStart } from "../server/googleAuth";
import type { BroadcastPair, BroadcastSummary, PlaylistSummary, PrivacyStatus } from "../server/youtube";
import type { ThumbnailOutcomes } from "../shared/types";
import type { BroadcastTexts } from "../server/templates";

export { DEFAULT_RTMP_URL };
export type { AuthHealth, BroadcastPair, BroadcastSummary, DeviceFlowPoll, DeviceFlowStart, PlaylistSummary, PrivacyStatus };

/** An HTTP failure that still carries its status.
 *
 *  The status matters in exactly one place and it matters a lot: every
 *  writing YouTube route answers **409** when there is no Google connection,
 *  and that is not an error to shout about — it is a state with a next step
 *  ("yhdistä Google-tili"). Without the status the client could only match on
 *  message text. */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

/** True when the failure is "no Google connection yet" rather than a fault. */
export function isAuthMissing(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 409;
}

/** True when the server has no such route — the ElevenLabs quota is behind a
 *  route that does not exist yet, and the UI says so instead of showing a
 *  meaningless "palvelinvirhe". */
export function isRouteMissing(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404;
}

/** Turns any failure — network, HTTP status, bad JSON — into a Finnish
 *  sentence, because every call site renders the message verbatim to an
 *  operator standing in a field. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
    });
  } catch {
    throw new Error("Palvelimeen ei saada yhteyttä");
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Palvelin vastasi virheellistä JSONia (HTTP ${res.status})`);
    }
  }

  if (!res.ok) {
    const err = body as ApiError | null;
    if (err && typeof err.error === "string") {
      throw new ApiRequestError(err.detail ? `${err.error}: ${err.detail}` : err.error, res.status);
    }
    throw new ApiRequestError(`Palvelinvirhe (HTTP ${res.status})`, res.status);
  }
  return body as T;
}

function postJson<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

// ── YouTube-ketjun pyyntö- ja vastausmuodot ───────────────────────────────

/** POST /api/youtube/templates/preview — pelkkää tekstiä, ei luo mitään. */
export interface TemplatePreview {
  matchId: number;
  jobId: string | null;
  texts: BroadcastTexts;
}

/** POST /api/youtube/broadcasts — luotu pari + tekstit joilla se luotiin. */
export interface CreatedBroadcastPair extends BroadcastPair {
  texts: BroadcastTexts;
  /** Miten thumbnailin asetus meni kummallekin lähetykselle (#130). Erillään
   *  itse luonnista, koska lähetykset ovat olemassa myös silloin kun thumbnail
   *  epäonnistui — ja epäonnistuminen on kerrottava eikä nieltävä.
   *
   *  Valinnainen, vaikka palvelin lähettää sen aina: selain voi ajaa vanhempaa
   *  nidettä kuin palvelin (tai päinvastoin), ja kentän puuttuminen ei saa
   *  kaataa koko "Luodut lähetykset" -korttia — sen mukana katoaisivat myös
   *  jakoviesti ja stream key, eli juuri ne kaksi asiaa joita luonnin jälkeen
   *  tarvitaan. */
  thumbnails?: ThumbnailOutcomes;
}

/** Otsikon ja thumbnailin tiedot joita pesistulokset-API ei tunne: joukkueiden
 *  esitysnimet ja lyhyt paikkamuoto. Ilman näitä otsikoksi tulee tulospalvelun
 *  raakamuoto ("Pesä Ysit, Lappeenranta - Espoon Pesis, 29.7.2026 04 - Liperin
 *  kirkonkylän kenttä 4| LEIRITUOTANTO") vakiintuneen muodon sijaan (#95).
 *
 *  Kentät nimeävät **paikan otsikossa**, eivät omistajuutta: otsikossa on aina
 *  koti ensin ja vieras toisena riippumatta siitä kumpi on oma joukkue (#223). */
export interface TitleOverrides {
  homeTeam?: string;
  awayTeam?: string;
  shortVenue?: string;
}

export interface CreateBroadcastsBody {
  jobId?: string;
  matchId?: number;
  privacy?: PrivacyStatus;
  playlistId?: string | null;
  overrides?: TitleOverrides;
}

export interface VideoPatchBody {
  title?: string;
  description?: string;
  privacyStatus?: PrivacyStatus;
  playlistId?: string;
}

export interface ThumbnailRequest {
  headline: string;
  datetime: string;
  venue: string;
  narrated: boolean;
}

/** listBroadcasts ei palauta katselukertoja (liveBroadcasts.list ei tunne
 *  statistics-osaa), joten kenttä on valinnainen: UI näyttää sen jos ja kun
 *  palvelin alkaa liittää sen mukaan, eikä valehtele nollaa siihen asti. */
export interface BroadcastRow extends BroadcastSummary {
  viewCount?: number | null;
}

/** Mitä ElevenLabsin kiintiömittari tarvitsee. Reittiä `GET
 *  /api/elevenlabs/quota` EI ole vielä palvelimella — tämä on se muoto, jota
 *  käyttöliittymä osaa lukea (ks. isRouteMissing-käsittely UI:ssa). */
export interface ElevenLabsQuota {
  tier: string | null;
  /** Merkkejä käytetty tällä laskutuskaudella. */
  characterCount: number;
  characterLimit: number;
  charactersRemaining: number;
  /** ISO — milloin laskuri nollautuu. */
  nextResetAt: string | null;
  status: string | null;
}

export const api = {
  live: () => request<LiveState>("/api/live"),
  matches: (date: string) => request<DayMatches>(`/api/matches?date=${encodeURIComponent(date)}`),
  match: (id: number) => request<MatchOption>(`/api/matches/${id}`),
  jobs: () => request<Job[]>("/api/jobs"),
  createJob: (payload: CreateJobRequest) => postJson<Job>("/api/jobs", payload),
  patchJob: (id: string, payload: PatchJobRequest) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  /** `force` = "lopeta edellinen ja aktivoi tämä": closes the job that holds
   *  the broadcast slot (and stops the relay if it is still running) before
   *  taking the slot. Only ever sent from an explicit, confirmed tap. */
  activateJob: (id: string, opts: { force?: boolean } = {}) =>
    postJson<Job>(`/api/jobs/${encodeURIComponent(id)}/activate`, opts.force ? { force: true } : undefined),
  /** Jakoviesti työn linkeistä, muodostettuna uudelleen joka pyynnöllä (#131).
   *  Toimii työn koko elinkaaren ajan, myös ennen lähetysten luontia — silloin
   *  `linksReady` on false ja viestissä on paikkamerkit. */
  jobShare: (id: string) => request<JobShareMessage>(`/api/jobs/${encodeURIComponent(id)}/share`),
  /** Pysyväisasetukset (#133). PATCH on osittainen: lähetä vain muuttunut osa,
   *  jottei toisen kortin arvo nollaudu sivutuotteena. */
  settings: () => request<ControlSettings>("/api/settings"),
  patchSettings: (payload: Partial<ControlSettings>) =>
    request<ControlSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(payload) }),
  /** jobId mukaan aina kun työ on avattuna: ilman sitä preflight kertoo
   *  totuuden .env.relay:stä, joka voi osoittaa eiliseen otteluun (#155). */
  preflight: (jobId?: string) => postJson<PreflightResult>("/api/preflight", jobId ? { jobId } : undefined),
  relay: (action: "start" | "stop" | "restart") => postJson<RelayProcess>(`/api/relay/${action}`),
  knobs: (payload: PatchKnobsRequest) => postJson<ControlKnobs>("/api/knobs", payload),
  delayNudge: (deltaMs: number) => postJson<ControlKnobs>("/api/knobs/delay-nudge", { deltaMs }),
  // ── Ajastin ─────────────────────────────────────────────────────────────
  // Kaksi reittiä, ei kolmatta: tila ulos ja kytkin sisään. Käynnistystä ei
  // voi pyytää ajastimelta — se päättää itse, ja käsikäynnistys on relay().
  scheduler: () => request<SchedulerState>("/api/scheduler"),
  /** Palvelin vaatii tiukan boolean-arvon: tämä kytkin päättää saako kone
   *  aloittaa lähetyksen omin päin. */
  schedulerEnable: (enabled: boolean) =>
    postJson<SchedulerState>("/api/scheduler/enable", { enabled }),

  log: (limit: number, level?: LogLine["level"]) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (level) q.set("level", level);
    return request<LogLine[]>(`/api/log?${q.toString()}`);
  },

  // ── YouTube-ketju ───────────────────────────────────────────────────────
  // Terveysreitti on ainoa joka vastaa 200 myös ilman Google-yhteyttä; kaikki
  // muut vastaavat 409, ja se on UI:lle tila eikä vika (isAuthMissing).
  youtubeHealth: () => request<AuthHealth>("/api/youtube/health"),
  youtubeAuthStart: (payload: { clientId?: string; clientSecret?: string | null }) =>
    postJson<DeviceFlowStart>("/api/youtube/auth/start", payload),
  youtubeAuthPoll: () => postJson<DeviceFlowPoll>("/api/youtube/auth/poll"),
  youtubeBroadcasts: (status: "upcoming" | "active" | "completed" | "all" = "all", limit = 25) =>
    request<BroadcastRow[]>(`/api/youtube/broadcasts?status=${status}&limit=${limit}`),
  youtubePlaylists: () => request<PlaylistSummary[]>("/api/youtube/playlists"),
  templatesPreview: (payload: CreateBroadcastsBody) =>
    postJson<TemplatePreview>("/api/youtube/templates/preview", payload),
  /** PERUUTTAMATON ja ulospäin näkyvä: luo kanavalle kaksi lähetystä. Ainoa
   *  kutsupaikka on vahvistuksen takana (BroadcastCreateCard). */
  createBroadcasts: (payload: CreateBroadcastsBody) =>
    postJson<CreatedBroadcastPair>("/api/youtube/broadcasts", payload),
  /** Renderöi thumbnailin ja lataa sen videolle samalla kutsulla. Sama
   *  kuvantekijä kuin esikatselussa, joten ladattu kuva on se joka näytettiin. */
  setThumbnail: (videoId: string, payload: ThumbnailRequest) =>
    postJson<{ videoId: string }>(
      `/api/youtube/videos/${encodeURIComponent(videoId)}/thumbnail`,
      payload,
    ),
  /** Metatietojen muokkaus. `confirm` lähtee aina mukana, koska palvelin
   *  vaatii sen näkyvyyden muutokseen ja UI kysyy sen erikseen. */
  patchVideo: (videoId: string, payload: VideoPatchBody) =>
    request<{ videoId: string; title: string; privacyStatus: string | null }>(
      `/api/youtube/videos/${encodeURIComponent(videoId)}`,
      { method: "PATCH", body: JSON.stringify({ ...payload, confirm: true }) },
    ),
  /** TUHOAVA. Kutsupaikka vaatii kirjoitetun vahvistussanan JA kaksi
   *  napautusta — tämä funktio ei suojaa mitään, se vain lähettää. */
  deleteVideo: (videoId: string) =>
    request<{ videoId: string }>(`/api/youtube/videos/${encodeURIComponent(videoId)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: true }),
    }),

  /** PUUTTUVA REITTI: palvelimella ei ole vielä /api/elevenlabs/quota-reittiä.
   *  UI käsittelee 404:n omana tilanaan (isRouteMissing) ja kertoo mitä
   *  puuttuu, sen sijaan että näyttäisi "tuntematon reitti". */
  elevenLabsQuota: () => request<ElevenLabsQuota>("/api/elevenlabs/quota"),
};

/** Thumbnail-esikatselu ei kulje request()-apurin läpi: reitti palauttaa
 *  image/png-tavuja, ei JSONia. Virhevastaus on silti JSONia, joten se
 *  puretaan samalla tavalla kuin muualla — muuten renderöijän puuttuva
 *  Pillow-asennus näkyisi operaattorin puhelimella tyhjänä kuvana. */
export async function fetchThumbnailPreview(opts: ThumbnailRequest): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch("/api/thumbnail/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
  } catch {
    throw new Error("Palvelimeen ei saada yhteyttä");
  }
  if (res.ok) return res.blob();

  const text = await res.text();
  let message = `Palvelinvirhe (HTTP ${res.status})`;
  try {
    const body = JSON.parse(text) as ApiError;
    if (typeof body?.error === "string") {
      message = body.detail ? `${body.error}: ${body.detail}` : body.error;
    }
  } catch {
    // Ei JSONia — pidetään geneerinen viesti.
  }
  throw new ApiRequestError(message, res.status);
}

export type LiveConnectionStatus = "connecting" | "open" | "down";

interface LiveConnectionOptions {
  onState: (state: LiveState) => void;
  onStatus: (status: LiveConnectionStatus) => void;
}

/** How long we tolerate silence on an "open" stream before assuming iOS froze
 *  it. The server pushes on every poll (seconds), so 30 s is already generous. */
const STALE_MS = 30_000;
const MAX_BACKOFF_MS = 15_000;

/** Opens the SSE stream and keeps it open.
 *
 *  iOS Safari suspends EventSource when the tab goes to the background and
 *  frequently never fires `error` on wake — the socket is just silently dead.
 *  So three things guard the connection:
 *    1. exponential backoff reconnect on error/close,
 *    2. a staleness watchdog that reconnects a silent-but-"open" stream,
 *    3. an immediate reconnect when the page becomes visible again.
 *  While disconnected we still poll GET /api/live once per retry, so the
 *  numbers on screen keep moving even if EventSource never opens at all
 *  (buffering proxy, etc.).
 *
 *  Returns a cleanup function. */
export function connectLive(opts: LiveConnectionOptions): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  let status: LiveConnectionStatus = "connecting";

  const setStatus = (next: LiveConnectionStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus(next);
  };

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (staleTimer) clearTimeout(staleTimer);
    retryTimer = null;
    staleTimer = null;
  };

  const armStaleWatchdog = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (stopped) return;
      // Open but silent: treat exactly like a dropped connection.
      scheduleReconnect();
    }, STALE_MS);
  };

  const handlePayload = (raw: string) => {
    try {
      opts.onState(JSON.parse(raw) as LiveState);
    } catch {
      return; // A malformed frame is not worth tearing the stream down for.
    }
    attempt = 0;
    setStatus("open");
    armStaleWatchdog();
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearTimers();
    source?.close();
    source = null;
    setStatus("down");

    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt += 1;

    // One-shot fallback so the view is not frozen while we wait.
    void api
      .live()
      .then((state) => {
        if (!stopped) opts.onState(state);
      })
      .catch(() => undefined);

    retryTimer = setTimeout(open, delay);
  };

  const open = () => {
    if (stopped) return;
    clearTimers();
    source?.close();
    if (status !== "open") setStatus("connecting");

    const es = new EventSource("/api/live/stream");
    source = es;
    es.addEventListener("live", (ev) => handlePayload((ev as MessageEvent<string>).data));
    // Unnamed frames too — a server-side rename should not blank the screen.
    es.onmessage = (ev: MessageEvent<string>) => handlePayload(ev.data);
    es.onopen = () => armStaleWatchdog();
    es.onerror = () => {
      if (es !== source) return;
      scheduleReconnect();
    };
  };

  const onVisible = () => {
    if (stopped || document.visibilityState !== "visible") return;
    if (status === "open") return;
    attempt = 0; // A deliberate return to the app deserves an instant retry.
    open();
  };

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);
  open();

  return () => {
    stopped = true;
    clearTimers();
    source?.close();
    source = null;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onVisible);
  };
}
