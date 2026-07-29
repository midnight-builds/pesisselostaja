/** Google-kirjautuminen laitevirralla (OAuth 2.0 Device Flow) + oma
 *  kiintiölaskuri + terveysraportti.
 *
 *  **Miksi laitevirta eikä web-redirect:** ohjaussovellus näkyy osoitteessa
 *  `https://codexsrv.tail6875ae.ts.net/`, emmekä omista `ts.net`-verkkotunnusta.
 *  Web-redirect vaatisi paluuosoitteen rekisteröinnin ja käytännössä domainin
 *  omistusvahvistuksen — laitevirrassa (OAuth client: *TVs and Limited Input
 *  devices*) kumpaakaan ei tarvita: puhelin näyttää koodin, käyttäjä hyväksyy
 *  toisella laitteella (DESIGN.md "YouTube-ketju").
 *
 *  **Miksi kiintiölaskuri on meidän:** YouTube ei kerro jäljellä olevaa
 *  kiintiötä missään rajapinnassa. Ainoa tapa tietää ollaanko lähellä rajaa on
 *  laskea itse — ja raja tulee vastaan juuri silloin kun päivän aikana on
 *  luotu monta leiripeliä.
 *
 *  Tässä tiedostossa EI ole yhtään kirjoittavaa YouTube-kutsua; ainoa
 *  YouTube-kutsu on `channels.list` (1 yksikkö), jolla terveysraportti kertoo
 *  MIKÄ kanava on valtuutettu. */
import { createStore } from "./store.js";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Oikeudet, jotka laitevirralla pyydetään.
 *
 *  **Vain `youtube`, eikä `youtube.force-ssl`** — ja tämä ei ole tyylivalinta:
 *  Googlen laitevirta HYLKÄÄ force-ssl:n. Koodipyyntö vastaa suoraan
 *  `Invalid device flow scope: …/youtube.force-ssl`, eli kirjautumista ei voi
 *  edes aloittaa niin kauan kuin se on listalla. Laitevirta tukee vain osaa
 *  Googlen scopeista, ja tämä on niiden ulkopuolella.
 *
 *  Aiempi kommentti tässä väitti, että thumbnailin asetus ja videon poisto
 *  vaativat force-ssl:n. Se oli väärin: YouTube Data API v3 hyväksyy
 *  `thumbnails.set`-, `videos.update`- ja `videos.delete`-kutsuihin myös pelkän
 *  `youtube`-oikeuden. force-ssl on tarpeen kommenteille, tekstityksille ja
 *  arvosteluille — joihin tämä sovellus ei koske.
 *
 *  Löytyi 29.7.2026 ensimmäisellä oikealla kirjautumisyrityksellä. */
export const SCOPES = ["https://www.googleapis.com/auth/youtube"];

/** YouTube Data API:n kiintiöhinnasto niiltä osin kuin tämä sovellus kutsuu.
 *  list = 1, kirjoittavat = 50. Nämä ovat Googlen dokumentoituja hintoja, ei
 *  arvioita. */
export type QuotaOp = "list" | "insert" | "update" | "bind" | "delete" | "thumbnail";

export const QUOTA_COST: Record<QuotaOp, number> = {
  list: 1,
  insert: 50,
  update: 50,
  bind: 50,
  delete: 50,
  thumbnail: 50,
};

/** Googlen oletuskiintiö per projekti per vrk. */
export const DEFAULT_QUOTA_LIMIT = 10_000;

/** Refresh token vanhenee 7 vrk:ssa jos OAuth-sovellus on jäänyt *Testing*-
 *  tilaan. Varoitus tulee vuorokautta aiemmin, jotta yhteyden ehtii uusia
 *  ennen kuin se katkeaa kesken lähetyksen. */
export const TOKEN_WARN_AGE_DAYS = 6;
export const TOKEN_FAIL_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Access token elää tunnin; uusitaan minuuttia ennen umpeutumista, jottei
 *  kesken lähetyksen lähtevä kutsu osu juuri vanhentuneeseen tokeniin. */
const ACCESS_TOKEN_SKEW_MS = 60_000;

// --- Tallennettu tila -------------------------------------------------------

export interface GoogleClientConfig {
  clientId: string | null;
  /** Laitevirtaclientilla secretiä ei välttämättä ole — se on valinnainen
   *  tarkoituksella, ei unohdus. */
  clientSecret: string | null;
}

export interface StoredToken {
  refreshToken: string;
  /** Scopet sellaisina kuin Google ne myönsi (välilyönnein eroteltuna). */
  scope: string;
  /** Milloin refresh token saatiin (= laitevirta hyväksyttiin). */
  obtainedAt: string;
  /** Viimeisin ONNISTUNUT access tokenin päivitys. Tämä on se kenttä, josta
   *  7 vrk:n vanheneminen huomataan ajoissa. */
  lastRefreshAt: string | null;
}

export interface PendingDeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** ISO — laitekoodi vanhenee, tyypillisesti 15 min. */
  expiresAt: string;
  intervalSec: number;
  startedAt: string;
}

export interface QuotaState {
  /** Kiintiöpäivä Yhdysvaltain Tyynenmeren aikaa (Googlen nollautumishetki). */
  day: string;
  units: number;
  byOp: Partial<Record<QuotaOp, number>>;
}

const clientStore = createStore<GoogleClientConfig>("google-client.json", {
  clientId: null,
  clientSecret: null,
});
const tokenStore = createStore<StoredToken | null>("google-token.json", null);
const deviceStore = createStore<PendingDeviceFlow | null>("google-device.json", null);
const quotaStore = createStore<QuotaState>("youtube-quota.json", { day: "", units: 0, byOp: {} });

export class GoogleAuthError extends Error {
  /** true = käyttäjän on kirjauduttava uudelleen laitevirralla. */
  readonly needsReauth: boolean;

  constructor(message: string, needsReauth = false) {
    super(message);
    this.name = "GoogleAuthError";
    this.needsReauth = needsReauth;
  }
}

// --- Kiintiö ----------------------------------------------------------------

/** Kiintiö nollautuu keskiyöllä Yhdysvaltain Tyynenmeren aikaa, ei Suomen
 *  aikaa — laskuri on siis pidettävä siinä vyöhykkeessä, muuten se nollautuu
 *  10 tuntia väärässä kohtaa ja näyttää vihreää juuri kun kiintiö on lopussa. */
export function pacificDayKey(nowMs: number): string {
  // en-CA antaa suoraan YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Puhdas siirtymäfunktio: lisää yhden kutsun hinnan ja nollaa laskurin jos
 *  kiintiöpäivä on vaihtunut. Erillään levystä, jotta se on testattavissa. */
export function applyQuota(state: QuotaState, op: QuotaOp, nowMs: number): QuotaState {
  const day = pacificDayKey(nowMs);
  const base: QuotaState = state.day === day ? state : { day, units: 0, byOp: {} };
  return {
    day,
    units: base.units + QUOTA_COST[op],
    byOp: { ...base.byOp, [op]: (base.byOp[op] ?? 0) + 1 },
  };
}

export async function getQuota(nowMs: number = Date.now()): Promise<QuotaState> {
  const state = await quotaStore.read();
  const day = pacificDayKey(nowMs);
  // Vanhentunutta laskuria ei kirjoiteta levylle lukiessa — palautetaan vain
  // nollattu näkymä, jotta lukeva reitti pysyy sivuvaikutuksettomana.
  return state.day === day ? state : { day, units: 0, byOp: {} };
}

export async function recordQuota(op: QuotaOp, nowMs: number = Date.now()): Promise<QuotaState> {
  return quotaStore.update((current) => applyQuota(current, op, nowMs));
}

// --- Client-tunnukset -------------------------------------------------------

export async function getClientConfig(): Promise<GoogleClientConfig> {
  const stored = await clientStore.read();
  // Ympäristömuuttujat ovat varatie: samat nimet kuin esikuvaskriptien
  // .env-tiedostossa, jotta olemassa olevat tunnukset kelpaavat sellaisenaan.
  return {
    clientId: stored.clientId ?? process.env.GOOGLE_CLIENT_ID ?? null,
    clientSecret: stored.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? null,
  };
}

export async function setClientConfig(config: {
  clientId: string;
  clientSecret?: string | null;
}): Promise<GoogleClientConfig> {
  const next: GoogleClientConfig = {
    clientId: config.clientId.trim(),
    clientSecret: config.clientSecret?.trim() || null,
  };
  await clientStore.write(next);
  return next;
}

async function requireClientId(): Promise<GoogleClientConfig> {
  const config = await getClientConfig();
  if (!config.clientId) {
    throw new GoogleAuthError(
      "Google-clientin tunnusta ei ole tallennettu. Lisää client_id (OAuth-tyyppi: TVs and Limited Input devices) run/google-client.json-tiedostoon tai lähetä se auth/start-kutsun mukana."
    );
  }
  return config;
}

// --- HTTP-apurit ------------------------------------------------------------

interface FormResult {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

async function postForm(url: string, params: Record<string, string>): Promise<FormResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function str(json: Record<string, unknown>, key: string): string | null {
  const value = json[key];
  return typeof value === "string" ? value : null;
}

function num(json: Record<string, unknown>, key: string): number | null {
  const value = json[key];
  return typeof value === "number" ? value : null;
}

// --- Laitevirta -------------------------------------------------------------

export interface DeviceFlowStart {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSec: number;
  /** Valmis suomenkielinen ohje puhelimen ruudulle. */
  instructions: string;
}

/** Vaihe 1: pyydä laitekoodi. Palauttaa käyttäjälle näytettävän koodin ja
 *  osoitteen; laitekoodi jää levylle, jotta pollaus ei vaadi clientiltä sen
 *  kuljettamista edestakaisin (ja jotta selaimen päivitys ei hukkaa virtaa). */
export async function startDeviceFlow(client?: {
  clientId?: string;
  clientSecret?: string | null;
}): Promise<DeviceFlowStart> {
  if (client?.clientId) await setClientConfig({ clientId: client.clientId, clientSecret: client.clientSecret });
  const config = await requireClientId();

  const result = await postForm(DEVICE_CODE_URL, {
    client_id: config.clientId as string,
    scope: SCOPES.join(" "),
  });
  if (!result.ok) {
    const detail = str(result.json, "error_description") ?? str(result.json, "error") ?? String(result.status);
    throw new GoogleAuthError(`Laitekoodin pyyntö epäonnistui: ${detail}`);
  }

  const deviceCode = str(result.json, "device_code");
  const userCode = str(result.json, "user_code");
  // Google palauttaa kentän nimellä verification_url; osa dokumentaatiosta
  // puhuu verification_uri:sta — hyväksytään kumpi tahansa.
  const verificationUrl = str(result.json, "verification_url") ?? str(result.json, "verification_uri");
  if (!deviceCode || !userCode || !verificationUrl) {
    throw new GoogleAuthError("Laitekoodivastauksesta puuttui kenttiä — Google palautti odottamattoman muodon.");
  }
  const expiresInSec = num(result.json, "expires_in") ?? 900;
  const intervalSec = num(result.json, "interval") ?? 5;

  const pending: PendingDeviceFlow = {
    deviceCode,
    userCode,
    verificationUrl,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    intervalSec,
    startedAt: new Date().toISOString(),
  };
  await deviceStore.write(pending);

  return {
    userCode,
    verificationUrl,
    expiresAt: pending.expiresAt,
    intervalSec,
    instructions: `Avaa ${verificationUrl} toisella laitteella ja syötä koodi ${userCode}. Kirjaudu sillä Google-tilillä, joka omistaa oikean YouTube-kanavan.`,
  };
}

export type DeviceFlowStatus = "pending" | "slow_down" | "connected" | "expired" | "denied" | "none";

export interface DeviceFlowPoll {
  status: DeviceFlowStatus;
  /** Sekunteja seuraavaan pollaukseen; kasvaa jos Google pyytää hidastamaan. */
  intervalSec: number;
  message: string;
  userCode?: string;
  verificationUrl?: string;
  channel?: { id: string; title: string } | null;
}

/** Vaihe 2: pollaa kunnes käyttäjä on hyväksynyt. Kolme virhettä ovat
 *  normaalia kulkua eivätkä vikoja: `authorization_pending` (ei vielä
 *  hyväksytty), `slow_down` (pollataan liian tiheään) ja `expired_token`
 *  (koodi vanheni, aloita alusta). */
export async function pollDeviceFlow(): Promise<DeviceFlowPoll> {
  const pending = await deviceStore.read();
  if (!pending) {
    return { status: "none", intervalSec: 5, message: "Laitevirtaa ei ole käynnissä — aloita kirjautuminen uudelleen." };
  }
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    await deviceStore.write(null);
    return { status: "expired", intervalSec: 5, message: "Laitekoodi vanheni. Aloita kirjautuminen uudelleen." };
  }

  const config = await requireClientId();
  const params: Record<string, string> = {
    client_id: config.clientId as string,
    device_code: pending.deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;

  const result = await postForm(TOKEN_URL, params);

  if (!result.ok) {
    const error = str(result.json, "error") ?? "unknown_error";
    if (error === "authorization_pending") {
      return {
        status: "pending",
        intervalSec: pending.intervalSec,
        message: `Odotetaan hyväksyntää. Koodi ${pending.userCode} osoitteessa ${pending.verificationUrl}.`,
        userCode: pending.userCode,
        verificationUrl: pending.verificationUrl,
      };
    }
    if (error === "slow_down") {
      // Googlen ohje: kasvata väliä. Talletetaan kasvatettu väli, jotta myös
      // seuraava pollaus noudattaa sitä eikä jää loputtomaan slow_downiin.
      const intervalSec = pending.intervalSec + 5;
      await deviceStore.write({ ...pending, intervalSec });
      return {
        status: "slow_down",
        intervalSec,
        message: "Google pyysi hidastamaan pollausta.",
        userCode: pending.userCode,
        verificationUrl: pending.verificationUrl,
      };
    }
    if (error === "expired_token") {
      await deviceStore.write(null);
      return { status: "expired", intervalSec: 5, message: "Laitekoodi vanheni. Aloita kirjautuminen uudelleen." };
    }
    if (error === "access_denied") {
      await deviceStore.write(null);
      return { status: "denied", intervalSec: 5, message: "Käyttäjä hylkäsi pyynnön." };
    }
    const detail = str(result.json, "error_description") ?? error;
    throw new GoogleAuthError(`Kirjautuminen epäonnistui: ${detail}`);
  }

  const refreshToken = str(result.json, "refresh_token");
  if (!refreshToken) {
    throw new GoogleAuthError(
      "Google ei palauttanut refresh_tokenia. Poista sovelluksen käyttöoikeus tililtä (myaccount.google.com/permissions) ja kirjaudu uudelleen."
    );
  }
  const now = new Date().toISOString();
  const stored: StoredToken = {
    refreshToken,
    scope: str(result.json, "scope") ?? SCOPES.join(" "),
    obtainedAt: now,
    lastRefreshAt: now,
  };
  await tokenStore.write(stored);
  await deviceStore.write(null);

  const accessToken = str(result.json, "access_token");
  cacheAccessToken(accessToken, num(result.json, "expires_in"));

  let channel: { id: string; title: string } | null = null;
  try {
    channel = accessToken ? await fetchChannel(accessToken) : null;
  } catch {
    // Kanavan haku on tässä pelkkä vahvistus oikeasta tilistä — jos se
    // epäonnistuu, kirjautuminen on silti onnistunut ja terveysreitti
    // kertoo asiasta myöhemmin.
    channel = null;
  }

  return {
    status: "connected",
    intervalSec: 0,
    message: channel
      ? `Yhdistetty kanavaan ${channel.title}.`
      : "Yhdistetty. Tarkista terveysnäkymästä että kanava on oikea.",
    channel,
  };
}

// --- Access token -----------------------------------------------------------

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

function cacheAccessToken(token: string | null, expiresInSec: number | null): void {
  if (!token) return;
  cachedAccessToken = {
    token,
    expiresAtMs: Date.now() + (expiresInSec ?? 3600) * 1000 - ACCESS_TOKEN_SKEW_MS,
  };
}

/** Testien ja uloskirjautumisen käyttöön: tyhjentää muistissa olevan tokenin. */
export function clearAccessTokenCache(): void {
  cachedAccessToken = null;
}

/** Sormenjälki tallennetusta tokenista: `null` kun tokenia ei ole, muuten
 *  merkkijono joka MUUTTUU kun operaattori kirjautuu uudelleen. Halpa
 *  tiedostoluku, ei yhtään verkkokutsua.
 *
 *  Kaksi tehtävää taustapollauksessa. `null` estää sen kutsumasta
 *  getAccessTokenia 30 s välein tilassa joka on tämän repon oletus (OAuth-
 *  clientia ei ole pakko olla) — jokainen kutsu heittäisi ja loki täyttyisi
 *  virheistä joita kukaan ei voi korjata muuten kuin kirjautumalla. Ja koska
 *  uusi laitevirtakirjautuminen ylikirjoittaa tiedoston käymättä nollan kautta,
 *  pelkkä olemassaolo ei erottaisi korjattua yhteyttä kuolleesta: `obtainedAt`
 *  on juuri se leima jonka onnistunut kirjautuminen kirjoittaa uusiksi —
 *  access tokenin uusinta ei koske siihen. */
export async function getTokenFingerprint(): Promise<string | null> {
  return (await tokenStore.read())?.obtainedAt ?? null;
}

/** Kiintiöstä jäljellä olevat yksiköt ohjaamon OMAN laskurin mukaan (YouTube ei
 *  kerro tätä missään). Paikallinen tiedostoluku, ei verkkokutsua — halpa myös
 *  taustasilmukasta. */
export async function getQuotaRemaining(nowMs: number = Date.now()): Promise<number> {
  return Math.max(0, quotaLimit() - (await getQuota(nowMs)).units);
}

/** Voimassa oleva access token, tarvittaessa refresh_tokenilla uusittuna.
 *  Onnistunut uusinta päivittää `lastRefreshAt`in — se on terveysraportin
 *  tärkein yksittäinen tieto. */
export async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAtMs > Date.now()) return cachedAccessToken.token;

  const stored = await tokenStore.read();
  if (!stored?.refreshToken) {
    throw new GoogleAuthError("Google-tiliä ei ole yhdistetty — kirjaudu laitevirralla ensin.", true);
  }
  const config = await requireClientId();

  const params: Record<string, string> = {
    client_id: config.clientId as string,
    refresh_token: stored.refreshToken,
    grant_type: "refresh_token",
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;

  const result = await postForm(TOKEN_URL, params);
  if (!result.ok) {
    const error = str(result.json, "error") ?? "";
    const detail = str(result.json, "error_description") ?? (error || String(result.status));
    // invalid_grant = refresh token on peruttu tai vanhentunut. Juuri tämä
    // tapahtuu 7 vrk:n kuluttua, jos OAuth-sovellus on jäänyt Testing-tilaan.
    if (error === "invalid_grant") {
      throw new GoogleAuthError(
        `Refresh token ei kelpaa enää (${detail}). Tyypillisin syy: OAuth-sovellus on Testing-tilassa, jolloin token vanhenee 7 vuorokaudessa. Julkaise sovellus tai kirjaudu uudelleen laitevirralla.`,
        true
      );
    }
    throw new GoogleAuthError(`Access tokenin uusinta epäonnistui: ${detail}`);
  }

  const accessToken = str(result.json, "access_token");
  if (!accessToken) throw new GoogleAuthError("Google ei palauttanut access_tokenia.");
  cacheAccessToken(accessToken, num(result.json, "expires_in"));
  await tokenStore.update((current) =>
    current ? { ...current, lastRefreshAt: new Date().toISOString() } : current
  );
  return accessToken;
}

// --- Terveysraportti --------------------------------------------------------

async function fetchGrantedScopes(accessToken: string): Promise<string[]> {
  const url = new URL(TOKENINFO_URL);
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const scope = str(json, "scope");
  return scope ? scope.split(/\s+/).filter(Boolean) : [];
}

async function fetchChannel(accessToken: string): Promise<{ id: string; title: string } | null> {
  const url = new URL(CHANNELS_URL);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
  await recordQuota("list");
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as {
    items?: Array<{ id?: string; snippet?: { title?: string } }>;
  };
  const item = json.items?.[0];
  if (!item?.id) return null;
  return { id: item.id, title: item.snippet?.title ?? "(nimetön kanava)" };
}

export interface AuthHealth {
  connected: boolean;
  health: "ok" | "warn" | "fail" | "idle";
  /** Yksi lause, jonka operaattori lukee puhelimen ruudulta. */
  headline: string;
  channel: { id: string; title: string } | null;
  scopes: string[];
  missingScopes: string[];
  tokenObtainedAt: string | null;
  lastRefreshAt: string | null;
  /** Vuorokausia viimeisimmästä onnistuneesta päivityksestä (tai tokenin
   *  saamisesta, jos päivityksiä ei ole ollut). */
  daysSinceSuccess: number | null;
  tokenAgeDays: number | null;
  warnings: string[];
  quota: { day: string; used: number; limit: number; remaining: number };
  /** Laitevirta kesken — puhelin voi jatkaa pollausta. */
  pending: { userCode: string; verificationUrl: string; expiresAt: string } | null;
}

export interface AuthHealthInput {
  now: number;
  token: StoredToken | null;
  channel: { id: string; title: string } | null;
  scopes: string[];
  quota: QuotaState;
  quotaLimit: number;
  pending: PendingDeviceFlow | null;
  /** Verkko- tai tokenvirhe terveystarkistuksen aikana. */
  error?: string | null;
}

function daysBetween(fromIso: string | null, nowMs: number): number | null {
  if (!fromIso) return null;
  const ms = Date.parse(fromIso);
  if (Number.isNaN(ms)) return null;
  return (nowMs - ms) / DAY_MS;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const HEALTH_RANK: Record<AuthHealth["health"], number> = { idle: 0, ok: 1, warn: 2, fail: 3 };

/** Terveys voi vain huonontua raportin kokoamisen aikana: yksikään myöhempi
 *  sääntö ei saa siivota aiempaa varoitusta pois. */
function worse(current: AuthHealth["health"], candidate: AuthHealth["health"]): AuthHealth["health"] {
  return HEALTH_RANK[candidate] > HEALTH_RANK[current] ? candidate : current;
}

/** Puhdas päättelytaulukko terveysraportille — erillään verkosta ja levystä,
 *  koska juuri tämä varoitus on se, jonka takia koko terveystarkistus
 *  pyydettiin: 7 vrk:n vanheneminen Testing-tilassa on kaatanut yhteyden
 *  ennenkin, ja se pitää huomata ENNEN kuin ollaan kentällä. */
export function buildAuthHealth(input: AuthHealthInput): AuthHealth {
  const warnings: string[] = [];
  const used = input.quota.units;
  const quota = {
    day: input.quota.day || pacificDayKey(input.now),
    used,
    limit: input.quotaLimit,
    remaining: Math.max(0, input.quotaLimit - used),
  };

  const pending = input.pending
    ? {
        userCode: input.pending.userCode,
        verificationUrl: input.pending.verificationUrl,
        expiresAt: input.pending.expiresAt,
      }
    : null;

  if (!input.token) {
    return {
      connected: false,
      health: "idle",
      headline: pending
        ? `Kirjautuminen kesken — syötä koodi ${pending.userCode} osoitteessa ${pending.verificationUrl}.`
        : "Google-tiliä ei ole yhdistetty.",
      channel: null,
      scopes: [],
      missingScopes: SCOPES,
      tokenObtainedAt: null,
      lastRefreshAt: null,
      daysSinceSuccess: null,
      tokenAgeDays: null,
      warnings,
      quota,
      pending,
    };
  }

  const tokenAgeDays = daysBetween(input.token.obtainedAt, input.now);
  const lastSuccessIso = input.token.lastRefreshAt ?? input.token.obtainedAt;
  const daysSinceSuccess = daysBetween(lastSuccessIso, input.now);

  const missingScopes = SCOPES.filter((scope) => !input.scopes.includes(scope));

  let health: AuthHealth["health"] = "ok";
  let headline = input.channel
    ? `Yhdistetty kanavaan ${input.channel.title}.`
    : "Yhdistetty, mutta kanavaa ei saatu varmistettua.";

  if (!input.channel) {
    warnings.push(
      "Kanavaa ei saatu haettua (channels.list). Varmista terveysnäkymästä ennen luontia, ettei lähetys päädy väärälle kanavalle."
    );
    health = worse(health, "warn");
  }

  if (input.scopes.length > 0 && missingScopes.length > 0) {
    warnings.push(
      `Puuttuvat oikeudet: ${missingScopes.join(", ")}. Lähetysten luonti ja hallinta eivät toimi ilman niitä — kirjaudu uudelleen.`
    );
    health = worse(health, "warn");
  }

  if (daysSinceSuccess !== null && daysSinceSuccess >= TOKEN_FAIL_AGE_DAYS) {
    warnings.push(
      `Viimeisimmästä onnistuneesta tokenin päivityksestä on ${round1(daysSinceSuccess)} vrk. Yhteys on lähes varmasti jo katkennut: OAuth-sovellus on jäänyt Testing-tilaan, jolloin refresh token vanhenee 7 vuorokaudessa. Julkaise sovellus (Publishing status: In production) tai kirjaudu uudelleen laitevirralla.`
    );
    health = worse(health, "fail");
    headline = `Google-yhteys todennäköisesti vanhentunut (${round1(daysSinceSuccess)} vrk ilman onnistunutta päivitystä).`;
  } else if (daysSinceSuccess !== null && daysSinceSuccess >= TOKEN_WARN_AGE_DAYS) {
    warnings.push(
      `Tokenia ei ole päivitetty onnistuneesti ${round1(daysSinceSuccess)} vuorokauteen. Jos OAuth-sovellus on Testing-tilassa, refresh token vanhenee 7 vuorokaudessa — uusi yhteys nyt, älä kesken lähetyksen.`
    );
    health = worse(health, "warn");
    headline = `Google-yhteys vanhenemassa: ${round1(daysSinceSuccess)} vrk ilman onnistunutta päivitystä.`;
  }

  // Tokenin IKÄ myöntämisestä, ei viimeisestä käytöstä. Tämä tarkistus on
  // pakollinen siitä hetkestä kun ohjaamo alkoi pollata lähteen tilaa
  // taustalla: pollaus uusii access tokenin noin tunnin välein, jolloin
  // daysSinceSuccess ei enää koskaan kasva — mutta Testing-tilan refresh token
  // kuolee silti 7 vrk myöntämisestä.
  //
  // Sääntö on tarkoituksella ENINTÄÄN warn, ei koskaan fail. 7 vrk:n
  // vanheneminen koskee vain Testing-tilaa; kun sovellus julkaistaan — juuri
  // mitä tämä varoitus neuvoo tekemään — refresh token ei enää vanhene, mutta
  // tokenAgeDays kasvaa loputtomiin. Failinä terveysnäkymä olisi päivästä 7
  // eteenpäin pysyvästi punainen, ja aina päällä oleva punainen peittää
  // alleen oikean vian. Aito katkeaminen näkyy yhä failina yllä olevan
  // daysSinceSuccess-säännön kautta: kun refresh lakkaa onnistumasta,
  // lastRefreshAt lakkaa päivittymästä.
  //
  // Ikävaroitus jätetään pois kun tokenAgeDays ja daysSinceSuccess ovat
  // käytännössä sama luku (laitevirta kirjoittaa molemmat leimat samalla
  // hetkellä): silloin yllä oleva sääntö on jo sanonut saman asian.
  const ageSaysTheSameThing =
    tokenAgeDays !== null && daysSinceSuccess !== null && Math.abs(tokenAgeDays - daysSinceSuccess) < 0.1;
  if (!ageSaysTheSameThing && tokenAgeDays !== null && tokenAgeDays >= TOKEN_WARN_AGE_DAYS) {
    const pastTestingLimit = tokenAgeDays >= TOKEN_FAIL_AGE_DAYS;
    warnings.push(
      pastTestingLimit
        ? `Tokenin myöntämisestä on ${round1(tokenAgeDays)} vrk. Jos OAuth-sovellus on yhä Testing-tilassa, refresh token on jo vanhentunut — julkaise sovellus (Publishing status: In production) tai kirjaudu uudelleen laitevirralla. Julkaistulla sovelluksella pelkkä ikä ei vanhenna tokenia, joten tämä on varoitus eikä vika.`
        : `Tokenin myöntämisestä on ${round1(tokenAgeDays)} vrk. Jos OAuth-sovellus on yhä Testing-tilassa, refresh token vanhenee 7 vuorokautta myöntämisestä, ei viimeisestä käytöstä — uusi yhteys nyt, älä kesken lähetyksen.`
    );
    // Otsikon saa vaihtaa vain ankarin löydös; jos jokin aiempi sääntö on jo
    // nostanut tilan failiin, sen otsikko jää voimaan.
    if (HEALTH_RANK.warn > HEALTH_RANK[health]) {
      headline = pastTestingLimit
        ? `Google-yhteys voi olla vanhentunut: token myönnetty ${round1(tokenAgeDays)} vrk sitten.`
        : `Google-yhteys vanhenemassa: token myönnetty ${round1(tokenAgeDays)} vrk sitten.`;
    }
    health = worse(health, "warn");
  }

  if (quota.remaining <= 0) {
    warnings.push(
      `Päivän YouTube-kiintiö (${quota.limit} yksikköä) on käytetty loppuun. Kiintiö nollautuu keskiyöllä Yhdysvaltain Tyynenmeren aikaa.`
    );
    health = worse(health, "fail");
    headline = "YouTube-kiintiö on lopussa — uusia lähetyksiä ei voi luoda tänään.";
  } else if (quota.remaining < QUOTA_COST.insert * 6) {
    // Yhden ottelun pari maksaa ~300 yksikköä; alle sen verran jäljellä on
    // varoitus, ei vielä este.
    warnings.push(
      `Kiintiöstä on jäljellä ${quota.remaining} yksikköä — yhden ottelun lähetyspari kuluttaa noin ${QUOTA_COST.insert * 6}.`
    );
    health = worse(health, "warn");
  }

  if (input.error) {
    warnings.push(input.error);
    health = worse(health, "fail");
    headline = `Google-yhteyden tarkistus epäonnistui: ${input.error}`;
  }

  return {
    connected: true,
    health,
    headline,
    channel: input.channel,
    scopes: input.scopes,
    missingScopes,
    tokenObtainedAt: input.token.obtainedAt,
    lastRefreshAt: input.token.lastRefreshAt,
    daysSinceSuccess: daysSinceSuccess === null ? null : round1(daysSinceSuccess),
    tokenAgeDays: tokenAgeDays === null ? null : round1(tokenAgeDays),
    warnings,
    quota,
    pending,
  };
}

/** Kokoaa terveysraportin: kanava (mikä tili on valtuutettu), myönnetyt
 *  scopet, tokenin ikä ja viimeisin onnistunut päivitys sekä oma
 *  kiintiölaskuri. Verkkovirhe ei kaada tätä — se raportoidaan. */
export async function getAuthHealth(now: number = Date.now()): Promise<AuthHealth> {
  const [token, pending, quota] = await Promise.all([tokenStore.read(), deviceStore.read(), getQuota(now)]);

  if (!token) {
    return buildAuthHealth({ now, token: null, channel: null, scopes: [], quota, quotaLimit: quotaLimit(), pending });
  }

  let channel: { id: string; title: string } | null = null;
  let scopes: string[] = [];
  let error: string | null = null;
  try {
    const accessToken = await getAccessToken();
    [scopes, channel] = await Promise.all([fetchGrantedScopes(accessToken), fetchChannel(accessToken)]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Tokenin uusinta saattoi juuri päivittää lastRefreshAtin — luetaan tila
  // uudelleen, jottei raportti näytä vanhentunutta ikää heti onnistumisen
  // jälkeen.
  const fresh = (await tokenStore.read()) ?? token;
  return buildAuthHealth({
    now,
    token: fresh,
    channel,
    scopes,
    quota: await getQuota(now),
    quotaLimit: quotaLimit(),
    pending,
    error,
  });
}

function quotaLimit(): number {
  const raw = Number(process.env.YOUTUBE_QUOTA_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUOTA_LIMIT;
}

/** Katkaisee yhteyden: unohtaa refresh tokenin ja kesken olevan laitevirran.
 *  Ei peruuta oikeutta Googlen päässä — se tehdään tilin asetuksista. */
export async function disconnect(): Promise<void> {
  await tokenStore.write(null);
  await deviceStore.write(null);
  clearAccessTokenCache();
}
