/** HTTP entry point for the control server: routes api.ts's contract to the
 *  other modules and serves the built client. No framework (DESIGN.md) — a
 *  few dozen routes don't need one, and a plain node:http server is one less
 *  thing that can drift from what api.ts documents. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { CONFIG } from "./config.js";
import { sendJson, sendError, readJsonBody, serveStatic, parseQuery } from "./http.js";
import {
  getRelayProcess,
  startRelay,
  stopRelay,
  restartRelay,
  writeRelayEnv,
  writeKnobs,
  nudgeDelay,
} from "./relay.js";
import { readLog } from "./journal.js";
import { runControlPreflight } from "./preflight.js";
import { startLiveAggregator } from "./live.js";
import { createSourceIngestPoller } from "./sourceIngest.js";
import { getDayMatches, getMatch } from "./matches.js";
import {
  listJobs,
  createJob,
  patchJob,
  activateJob,
  closeRunningJob,
  JobClashError,
  getActiveJob,
  MatchNotFoundError,
} from "./jobs.js";
import { getSchedulerState, setSchedulerEnabled, startScheduler } from "./scheduler.js";
import { addSubscription, getSubscriptionCount, getVapidPublicKey, sendPushDetailed } from "./push.js";
import { getNotificationPrefs, observeLiveState, setNotificationPrefs } from "./notifications.js";
import {
  parseThumbnailRequest,
  renderThumbnail,
  thumbnailCachePath,
  thumbnailId,
  ThumbnailRenderError,
} from "./thumbnail.js";
import { getAuthHealth, GoogleAuthError, pollDeviceFlow, startDeviceFlow } from "./googleAuth.js";
import {
  addToPlaylist,
  ConfirmationRequiredError,
  createBroadcastPair,
  deleteVideo,
  listBroadcasts,
  listPlaylists,
  setThumbnail,
  updateVideoMetadata,
  YouTubeApiError,
  type PrivacyStatus,
  type VideoMetadataPatch,
} from "./youtube.js";
import {
  buildBroadcastTexts,
  buildJobShareMessage,
  templateInputFromMatch,
  type BroadcastTexts,
  type MatchTemplateInput,
  type ShareTemplate,
} from "./templates.js";
import { ensureShareTemplateFile, readShareTemplate, writeShareTemplate } from "./shareTemplate.js";
import { ensureVenueSettingsFile, readVenueSettings, writeVenueSettings } from "./venueSettings.js";
import { uploadPairThumbnails } from "./broadcastThumbnails.js";
import type { CreateJobRequest, PatchJobRequest, PatchKnobsRequest } from "../shared/api.js";
import type { ControlSettings, Job, LiveState, NotificationPrefs } from "../shared/types.js";

type LiveAggregator = {
  subscribe(fn: (state: LiveState) => void): () => void;
  current(): LiveState;
  stop(): void;
};

// iOS Safari silently drops an idle SSE connection; a comment line every 20s
// keeps it from ever going quiet enough to trigger that.
const SSE_HEARTBEAT_MS = 20_000;

function sendSseEvent(res: ServerResponse, state: LiveState): void {
  res.write(`event: live\ndata: ${JSON.stringify(state)}\n\n`);
}

function handleLiveStream(req: IncomingMessage, res: ServerResponse, live: LiveAggregator): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  sendSseEvent(res, live.current());
  const unsubscribe = live.subscribe((state) => sendSseEvent(res, state));
  const heartbeat = setInterval(() => res.write(":ping\n\n"), SSE_HEARTBEAT_MS);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

/** Resolves `rel` against `root` and refuses to leave it — a client asking
 *  for /assets/../../.env.relay must get 404, not the file. */
function resolveWithin(root: string, rel: string): string | null {
  const filePath = normalize(join(root, rel));
  if (filePath === root || filePath.startsWith(root + "/")) return filePath;
  return null;
}

async function serveApp(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  // Client build first: vite emits its bundle under /assets/, which would
  // otherwise be shadowed by the operator media directory below and leave the
  // page loading a blank shell (caught by a screenshot check, not by tsc).
  const filePath = resolveWithin(CONFIG.clientDist, rel);
  if (filePath && (await serveStatic(res, filePath))) return;

  // Operator media (brand background, PWA icons, manifest) is kept outside the
  // build so it can stay out of a public git history — served as a fallback,
  // both from /assets/ and from the root paths index.html references.
  const mediaRel = rel.startsWith("assets/") ? rel.slice("assets/".length) : rel;
  const mediaPath = resolveWithin(CONFIG.assetsDir, mediaRel);
  if (mediaPath && (await serveStatic(res, mediaPath))) return;

  // SPA fallback: an unknown path (e.g. a deep link to a job) still renders
  // the app shell, which does its own client-side routing.
  const indexPath = join(CONFIG.clientDist, "index.html");
  if (await serveStatic(res, indexPath)) return;

  // clientDist doesn't exist at all yet — say so instead of a bare 404, this
  // is the first thing a freshly cloned checkout hits.
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Käyttöliittymää ei ole rakennettu — aja: npm run build -w @pesisselostaja/control");
}

/** Yhteinen runko sekä esikatselulle että luonnille: ottelu voi tulla työn
 *  kautta (jobId) tai suoraan ottelu-id:nä, ja käyttäjän omat lisätiedot
 *  (tapahtuma, vaihe, lyhyt paikkamuoto) tulevat overrides-kentässä — niitä
 *  ei ole pesistulokset-API:ssa lainkaan. */
interface YoutubeCreateRequest {
  jobId?: string;
  matchId?: number;
  overrides?: Partial<MatchTemplateInput>;
  privacy?: PrivacyStatus;
  playlistId?: string | null;
  streamForNormal?: boolean;
  normalAutoStart?: boolean;
}

type TemplateContext =
  | { texts: BroadcastTexts; matchId: number; job: Job | null; shareTemplate: ShareTemplate }
  | { error: string; status: number };

async function resolveTemplateContext(body: YoutubeCreateRequest): Promise<TemplateContext> {
  // Luetaan joka pyynnöllä: operaattorin muokkaus run/share-template.jsoniin
  // näkyy seuraavassa esikatselussa ilman uudelleenkäynnistystä (#95).
  const shareTemplate = await readShareTemplate();
  // Sama peruste kuin jakoviestin pohjalla: luetaan joka pyynnöllä, jotta
  // muutos näkyy seuraavassa esikatselussa ilman uudelleenkäynnistystä (#132).
  const venueOptions = await readVenueSettings();
  let job: Job | null = null;
  if (body.jobId) {
    job = (await listJobs()).find((j) => j.id === body.jobId) ?? null;
    if (!job) return { error: `Työtä ${body.jobId} ei löytynyt.`, status: 404 };
  }
  const matchId = job?.matchId ?? body.matchId;
  if (matchId === undefined) return { error: "Anna joko jobId tai matchId.", status: 400 };

  const match = await getMatch(matchId);
  if (!match) return { error: `Ottelua ${matchId} ei löytynyt tulospalvelusta.`, status: 404 };

  const input = templateInputFromMatch(
    { ...match, startsAt: job?.startsAt ?? match.startsAt },
    body.overrides ?? {},
    venueOptions
  );
  try {
    return { texts: buildBroadcastTexts(input, shareTemplate), matchId, job, shareTemplate };
  } catch (err) {
    // Käytännössä vain "alkuaika puuttuu" — ottelu on listalla ilman
    // kellonaikaa, ja se on käyttäjän täydennettävä (overrides.localTime).
    return { error: err instanceof Error ? err.message : "tekstien muodostus epäonnistui", status: 400 };
  }
}

/** Kokoaa pysyväisasetukset yhteen vastaukseen (#133). Luetaan tiedostoista
 *  joka pyynnöllä, kuten kaikki muukin run/-tila: käsin tehty korjaus näkyy
 *  käyttöliittymässä ilman uudelleenkäynnistystä. */
async function readControlSettings(): Promise<ControlSettings> {
  const [shareTemplate, venueCleanup] = await Promise.all([readShareTemplate(), readVenueSettings()]);
  return { shareTemplate, venueCleanup };
}

async function route(req: IncomingMessage, res: ServerResponse, live: LiveAggregator): Promise<void> {
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const pathname = rawUrl.split("?")[0];
  const query = parseQuery(rawUrl);

  if (pathname === "/api/live" && method === "GET") {
    sendJson(res, 200, live.current());
    return;
  }
  if (pathname === "/api/live/stream" && method === "GET") {
    handleLiveStream(req, res, live);
    return;
  }

  if (pathname === "/api/matches" && method === "GET") {
    const date = query.get("date");
    if (!date) {
      sendError(res, 400, "date-parametri puuttuu (muoto YYYY-MM-DD)");
      return;
    }
    sendJson(res, 200, await getDayMatches(date));
    return;
  }
  const matchIdMatch = pathname.match(/^\/api\/matches\/([^/]+)$/);
  if (matchIdMatch && method === "GET") {
    const id = Number(matchIdMatch[1]);
    if (!Number.isFinite(id)) {
      sendError(res, 400, "virheellinen ottelun id");
      return;
    }
    const match = await getMatch(id);
    if (!match) {
      sendError(res, 404, "ottelua ei löydy");
      return;
    }
    sendJson(res, 200, match);
    return;
  }

  if (pathname === "/api/jobs" && method === "GET") {
    sendJson(res, 200, await listJobs());
    return;
  }
  if (pathname === "/api/jobs" && method === "POST") {
    const body = await readJsonBody<CreateJobRequest>(req);
    try {
      sendJson(res, 201, await createJob(body));
    } catch (err) {
      // A mistyped match id is the client's mistake, not a server fault: 404
      // with the Finnish sentence the phone can show as-is, instead of a 500
      // carrying a raw "Match metadata fetch failed: 404" behind it.
      if (err instanceof MatchNotFoundError) {
        sendError(res, 404, err.message);
        return;
      }
      throw err;
    }
    return;
  }
  const activateMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/activate$/);
  if (activateMatch && method === "POST") {
    // `force` is the operator answering "lopeta edellinen ja aktivoi tämä".
    // Strict boolean: this ends a broadcast that may be on air, so a truthy
    // string from a hand-written curl must not do it by accident.
    const body = await readJsonBody<{ force?: unknown }>(req).catch(() => ({}) as { force?: unknown });
    const force = body.force === true;
    try {
      // Cutting the previous run means stopping the unit too, not just marking
      // the job closed: leaving the relay pushing the old match while a new job
      // owns .env.relay is a worse state than the clash we came here to fix.
      if (force && (await getRelayProcess()).active) await stopRelay();
      const job = await activateJob(activateMatch[1], { force });
      // The route's whole job (api.ts): flipping a job to active is what makes
      // it the one the relay will actually broadcast, so writing .env.relay is
      // part of activation, not a separate step the client has to remember.
      await writeRelayEnv(job);
      sendJson(res, 200, job);
    } catch (err) {
      // A second job wanting the one broadcast slot is a state conflict with an
      // obvious next step, not a server fault — 409, and the client turns it
      // into a button instead of a red toast (#101).
      if (err instanceof JobClashError) {
        sendError(res, 409, err.message);
        return;
      }
      throw err;
    }
    return;
  }
  const jobIdMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobIdMatch && method === "PATCH") {
    const patch = await readJsonBody<PatchJobRequest>(req);
    sendJson(res, 200, await patchJob(jobIdMatch[1], patch));
    return;
  }

  if (pathname === "/api/preflight" && method === "POST") {
    sendJson(res, 200, await runControlPreflight());
    return;
  }

  // --- Ajastin. Kaksi reittiä: tila ulos, kytkin sisään. Käynnistystä ei voi
  // pyytää tästä — ajastin päättää itse, ja käsikäynnistys on /api/relay/start.
  // Pysyväisasetukset (#133). Yksi reitti, koska operaattorin kannalta kyse on
  // yhdestä sivusta — mutta talletus jakautuu samoihin run/-tiedostoihin kuin
  // ennenkin, joten hätätilassa ne voi yhä korjata tiedostoselaimella.
  if (pathname === "/api/settings" && method === "GET") {
    sendJson(res, 200, await readControlSettings());
    return;
  }
  if (pathname === "/api/settings" && method === "PATCH") {
    const body = await readJsonBody<Partial<ControlSettings>>(req);
    // Osittainen: koskematon osa säilyy. Käyttöliittymä lähettää vain sen
    // kortin jota operaattori muokkasi, eikä toisen kortin arvo saa nollautua
    // sivutuotteena.
    if (body.shareTemplate !== undefined) await writeShareTemplate(body.shareTemplate);
    if (body.venueCleanup !== undefined) await writeVenueSettings(body.venueCleanup);
    sendJson(res, 200, await readControlSettings());
    return;
  }

  if (pathname === "/api/scheduler" && method === "GET") {
    sendJson(res, 200, await getSchedulerState());
    return;
  }
  if (pathname === "/api/scheduler/enable" && method === "POST") {
    const body = await readJsonBody<{ enabled?: unknown }>(req);
    // Strict boolean: this switch decides whether a machine may start a
    // broadcast on its own, and a truthy string arriving from a hand-written
    // curl must not arm it by accident.
    if (typeof body.enabled !== "boolean") {
      sendError(res, 400, "enabled puuttuu tai ei ole tosi/epätosi");
      return;
    }
    sendJson(res, 200, await setSchedulerEnabled(body.enabled));
    return;
  }

  // Preview renders through the exact same function as the saved render
  // (DESIGN.md: "esikatselu on totuus") — the only difference is that this
  // route hands back the PNG bytes directly instead of a stored id, because a
  // live preview has nothing to save yet.
  if (pathname === "/api/thumbnail/preview" && method === "POST") {
    const body = await readJsonBody<unknown>(req);
    let opts;
    try {
      opts = parseThumbnailRequest(body);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "virheellinen pyyntö");
      return;
    }
    try {
      const png = await renderThumbnail(opts);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        // Every keystroke can change the text, and the id below already
        // gives the client a stable cache key if it wants one — the browser
        // must not serve a stale preview for a URL it never saw before.
        "Cache-Control": "no-store",
      });
      res.end(png);
    } catch (err) {
      if (err instanceof ThumbnailRenderError) {
        sendError(res, 502, err.message);
        return;
      }
      throw err;
    }
    return;
  }
  if (pathname === "/api/thumbnail/render" && method === "POST") {
    const body = await readJsonBody<unknown>(req);
    let opts;
    try {
      opts = parseThumbnailRequest(body);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "virheellinen pyyntö");
      return;
    }
    try {
      await renderThumbnail(opts);
    } catch (err) {
      if (err instanceof ThumbnailRenderError) {
        sendError(res, 502, err.message);
        return;
      }
      throw err;
    }
    // The id doubles as the cache key (thumbnail.ts) and as the handle a
    // later YouTube-upload step asks for by name; path is handed back too so
    // an operator can find the file from a shell without recomputing it.
    const id = thumbnailId(opts);
    sendJson(res, 200, { id, path: thumbnailCachePath(id) });
    return;
  }
  // Renders and uploads in one call, because the two halves have no separate
  // use: setThumbnail existed in youtube.ts with no route at all, so a
  // thumbnail could be previewed and rendered but never actually set from the
  // UI (#95). Rendering here rather than trusting a client-supplied path keeps
  // the upload bound to the same composer the preview showed.
  const thumbnailUploadMatch = pathname.match(/^\/api\/youtube\/videos\/([^/]+)\/thumbnail$/);
  if (thumbnailUploadMatch && method === "POST") {
    const body = await readJsonBody<unknown>(req);
    let opts;
    try {
      opts = parseThumbnailRequest(body);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "virheellinen pyyntö");
      return;
    }
    let image: Buffer;
    try {
      image = await renderThumbnail(opts);
    } catch (err) {
      if (err instanceof ThumbnailRenderError) {
        sendError(res, 502, err.message);
        return;
      }
      throw err;
    }
    sendJson(res, 200, await setThumbnail(thumbnailUploadMatch[1], image, "image/png"));
    return;
  }

  // --- YouTube-ketju. Kaikki kirjoittavat kutsut kulkevat youtube.ts:n läpi,
  // joka kirjaa jokaisen luodun lähetyksen run/youtube-created.ndjson-lokiin.
  // Tuhoavat reitit (näkyvyys, poisto) vaativat erillisen vahvistuksen.
  if (pathname === "/api/youtube/health" && method === "GET") {
    sendJson(res, 200, await getAuthHealth());
    return;
  }
  if (pathname === "/api/youtube/auth/start" && method === "POST") {
    // Client-tunnukset saa lähettää mukana: laitteella ei ole muuta reittiä
    // syöttää niitä kuin operaattorin puhelimen lomake (tai käsin run/google-client.json).
    const body = await readJsonBody<{ clientId?: string; clientSecret?: string | null }>(req).catch(() => ({}));
    sendJson(res, 200, await startDeviceFlow(body));
    return;
  }
  if (pathname === "/api/youtube/auth/poll" && method === "POST") {
    sendJson(res, 200, await pollDeviceFlow());
    return;
  }
  if (pathname === "/api/youtube/broadcasts" && method === "GET") {
    const statusRaw = query.get("status");
    const status =
      statusRaw === "upcoming" || statusRaw === "active" || statusRaw === "completed" || statusRaw === "all"
        ? statusRaw
        : undefined;
    const limitRaw = Number(query.get("limit"));
    sendJson(
      res,
      200,
      await listBroadcasts({ status, maxResults: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined })
    );
    return;
  }
  // Jakoviesti milloin tahansa työn elinkaaren aikana (#131). Luontivastaus
  // sisältää saman tekstin, mutta se näkyy vain kerran: jos operaattori ei
  // kopioinut sitä heti — tai sivu latautui uudelleen — viestiä ei saanut enää
  // mistään. Katsojia tulee kanaville kesken ottelunkin ja viesti jaetaan
  // useaan ryhmään eri aikoina, joten se on muodostettava uudelleen eikä
  // talletettava luontihetkellä. Kaikki tarvittava on työssä ja ottelussa.
  const jobShareMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/share$/);
  if (jobShareMatch && method === "GET") {
    const resolved = await resolveTemplateContext({ jobId: jobShareMatch[1] });
    if ("error" in resolved) {
      sendError(res, resolved.status, resolved.error);
      return;
    }
    const { texts, job, shareTemplate } = resolved;
    // resolveTemplateContext palauttaa työn vain kun jobId annettiin, ja se
    // annettiin — mutta tyyppi sallii nullin, joten se tarkistetaan.
    if (!job) {
      sendError(res, 404, `Työtä ${jobShareMatch[1]} ei löytynyt.`);
      return;
    }
    sendJson(res, 200, buildJobShareMessage(job, texts, shareTemplate));
    return;
  }

  if (pathname === "/api/youtube/broadcasts" && method === "POST") {
    const body = await readJsonBody<YoutubeCreateRequest>(req);
    const resolved = await resolveTemplateContext(body);
    if ("error" in resolved) {
      sendError(res, resolved.status, resolved.error);
      return;
    }
    const { texts, job } = resolved;
    const pair = await createBroadcastPair(
      {
        matchId: resolved.matchId,
        jobId: job?.id ?? null,
        localDate: texts.localDate,
        localTime: texts.localTime,
        venue: texts.venue,
        privacy: body.privacy,
        playlistId: body.playlistId === undefined ? texts.playlistId : body.playlistId,
        sourceMatchUrl: texts.matchUrl,
        streamForNormal: body.streamForNormal,
        normalAutoStart: body.normalAutoStart,
      },
      texts,
      resolved.shareTemplate
    );
    // Työ tietää nyt kohteensa: selostettu lähetys on relayn kohde, normaali
    // on lähde jota puhelin työntää. Ilman tätä operaattori joutuisi
    // kopioimaan samat arvot käsin takaisin työlle.
    if (job) {
      await patchJob(job.id, {
        targetVideoId: pair.narrated.videoId,
        targetStreamKey: pair.narrated.streamKey ?? undefined,
        sourceUrl: pair.normal.watchUrl,
      });
    }
    const thumbnails = await uploadPairThumbnails(pair, texts);
    sendJson(res, 201, { ...pair, texts, thumbnails });
    return;
  }
  if (pathname === "/api/youtube/playlists" && method === "GET") {
    sendJson(res, 200, await listPlaylists());
    return;
  }
  if (pathname === "/api/youtube/templates/preview" && method === "POST") {
    // Puhtaasti tekstiä: ei yhtään YouTube-kutsua, ei mitään luotua.
    const body = await readJsonBody<YoutubeCreateRequest>(req);
    const resolved = await resolveTemplateContext(body);
    if ("error" in resolved) {
      sendError(res, resolved.status, resolved.error);
      return;
    }
    sendJson(res, 200, {
      matchId: resolved.matchId,
      jobId: resolved.job?.id ?? null,
      texts: resolved.texts,
    });
    return;
  }
  const youtubeVideoMatch = pathname.match(/^\/api\/youtube\/videos\/([^/]+)$/);
  if (youtubeVideoMatch && method === "PATCH") {
    const videoId = youtubeVideoMatch[1];
    const body = await readJsonBody<VideoMetadataPatch & { confirm?: boolean; playlistId?: string }>(req);
    const { confirm, playlistId, ...patch } = body;
    const updated = await updateVideoMetadata(videoId, patch, { confirm });
    const added = playlistId ? await addToPlaylist(playlistId, videoId) : null;
    sendJson(res, 200, { ...updated, playlist: added });
    return;
  }
  if (youtubeVideoMatch && method === "DELETE") {
    const videoId = youtubeVideoMatch[1];
    // Vahvistus saa tulla joko rungossa tai kyselyparametrina — DELETE-runko
    // on monessa asiakkaassa hankala, eikä poisto saa kaatua siihen.
    const body = await readJsonBody<{ confirm?: boolean }>(req).catch(() => ({}) as { confirm?: boolean });
    const confirm = body.confirm === true || query.get("confirm") === "true";
    sendJson(res, 200, await deleteVideo(videoId, { confirm }));
    return;
  }

  const relayActionMatch = pathname.match(/^\/api\/relay\/(start|stop|restart)$/);
  if (relayActionMatch && method === "POST") {
    const action = relayActionMatch[1];
    if (action === "start") await startRelay();
    else if (action === "stop") {
      await stopRelay();
      // Stopping the unit ends the run, so the job stops holding the broadcast
      // slot. Without this the next match cannot be activated at all, and the
      // operator finds that out at the worst possible moment (#101). Restart is
      // deliberately NOT included: the same job keeps running.
      // null = "whichever job holds the slot": an operator's stop frees the
      // slot itself, it does not end one particular run (#118).
      await closeRunningJob(null);
    } else await restartRelay();
    // Ask systemd fresh rather than trust whatever start/stop/restart
    // returned — the response should reflect reality even if the unit
    // didn't settle into the expected state.
    sendJson(res, 200, await getRelayProcess());
    return;
  }

  // Knobs live in the relay's per-match control file, so every knob route
  // needs a match to address. Without an active job there is nothing to
  // steer — say so instead of writing a stray control file.
  if (pathname === "/api/knobs" && method === "POST") {
    const job = await getActiveJob();
    if (!job) return sendError(res, 409, "Ei aktiivista työtä — valitse ottelu ensin");
    const patch = await readJsonBody<PatchKnobsRequest>(req);
    // writeKnobs merges into whatever is already on disk, so a partial write
    // must not be pre-merged here: that would resurrect stale values.
    sendJson(res, 200, await writeKnobs(job.matchId, patch));
    return;
  }
  if (pathname === "/api/knobs/delay-nudge" && method === "POST") {
    const job = await getActiveJob();
    if (!job) return sendError(res, 409, "Ei aktiivista työtä — valitse ottelu ensin");
    const body = await readJsonBody<{ deltaMs: number }>(req);
    sendJson(res, 200, await nudgeDelay(job.matchId, body.deltaMs));
    return;
  }

  // --- Push-ilmoitukset. The public key is handed out rather than baked into
  // the client bundle, because the pair is generated on first boot and lives
  // in run/vapid.json — the client must ask, or a rebuilt bundle could be
  // signed against a key this server never had.
  if (pathname === "/api/push/key" && method === "GET") {
    sendJson(res, 200, { publicKey: await getVapidPublicKey() });
    return;
  }
  if (pathname === "/api/push/subscribe" && method === "POST") {
    const body = await readJsonBody<unknown>(req);
    try {
      await addSubscription(body);
    } catch (err) {
      // A malformed subscription is the client's fault, not a server fault —
      // 400 so the phone shows the reason instead of "palvelinvirhe".
      sendError(res, 400, "tilaus hylättiin", err instanceof Error ? err.message : String(err));
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === "/api/push/test" && method === "POST") {
    // Exists so the operator can prove the whole chain works while standing in
    // the field BEFORE the match — an alert path you only discover is broken
    // when it fails to alert you is worse than no alert path.
    if ((await getSubscriptionCount()) === 0) {
      sendError(res, 409, "Ei ilmoitustilauksia — ota ilmoitukset käyttöön ensin");
      return;
    }
    const result = await sendPushDetailed(
      "Testi-ilmoitus",
      "Ilmoitukset toimivat. Näin näkyy myös oikea hälytys.",
      { tag: "test" }
    );
    sendJson(res, 200, result);
    return;
  }
  if (pathname === "/api/push/prefs" && method === "GET") {
    sendJson(res, 200, await getNotificationPrefs());
    return;
  }
  if (pathname === "/api/push/prefs" && method === "POST") {
    const patch = await readJsonBody<Partial<NotificationPrefs>>(req);
    sendJson(res, 200, await setNotificationPrefs(patch));
    return;
  }

  if (pathname === "/api/log" && method === "GET") {
    const limitRaw = query.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const level = query.get("level") ?? undefined;
    sendJson(res, 200, await readLog({ limit, level }));
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendError(res, 404, "tuntematon reitti", `${method} ${pathname}`);
    return;
  }

  if (method === "GET" || method === "HEAD") {
    await serveApp(pathname, res);
    return;
  }
  sendError(res, 405, "metodia ei tueta");
}

async function main(): Promise<void> {
  // The state dir also backs Store/NDJSON writes (store.ts), but nothing
  // else guarantees it exists before the first request — create it once at
  // boot rather than on every write.
  await mkdir(CONFIG.stateDir, { recursive: true });
  // Materializes run/share-template.json with its defaults, so the operator can
  // find and edit the share message's wording without being told it exists
  // (#95). Failing to write it must not stop the server: the defaults are
  // compiled in and the messages come out the same.
  await ensureShareTemplateFile().catch(() => undefined);
  await ensureVenueSettingsFile().catch(() => undefined);

  // Lähteen tilan polleri käynnistyy ennen aggregaattoria, jotta ensimmäinen
  // koottu tila voi jo sisältää havainnon. Se on porttien takana: ilman
  // aktiivista työtä, ajossa olevaa relayta ja Google-tunnuksia se ei kutsu
  // YouTubea kertaakaan (sourceIngest.ts).
  const sourceIngest = createSourceIngestPoller();

  // The live view needs to know which job is currently the relay's job to
  // know what to poll; the aggregator asks rather than the server pushing it
  // in, so a job activated after the aggregator started is picked up too.
  const live = startLiveAggregator({
    getActiveJob,
    getSourceIngest: () => ({ ingest: sourceIngest.current(), reason: sourceIngest.reason() }),
  });

  // Push triggers ride along as an ordinary subscriber instead of being wired
  // into the aggregator itself: notifications can then never alter, delay or
  // break the state the phone renders — the worst a bug in there can do is
  // fail to notify.
  live.subscribe(observeLiveState);

  // The scheduler polls on its own timer, independent of the live aggregator:
  // it has to keep watching a source that no phone is currently looking at.
  // Starting it here is safe because it boots DISABLED (run/scheduler.json,
  // default {enabled:false}) — until the operator flips the switch in the UI it
  // only records what it would have done.
  const scheduler = startScheduler();

  const server = createServer((req, res) => {
    // A single route's error must never take the whole server down — every
    // request funnels through this try/catch, on top of whatever a handler
    // does itself.
    route(req, res, live).catch((err) => {
      console.error("[control]", req.method, req.url, err);
      if (!res.headersSent) {
        // YouTube-ketjun virheillä on omat merkityksensä, jotka hukkuisivat
        // geneeriseen 500:aan: puuttuva vahvistus on asiakkaan virhe (400),
        // katkennut Google-yhteys vaatii kirjautumisen (409), ja YouTuben oma
        // virhe on ylävirran vika (502) — ei tämän palvelimen.
        if (err instanceof ConfirmationRequiredError) {
          sendError(res, 400, err.message);
        } else if (err instanceof GoogleAuthError) {
          sendError(res, 409, err.message);
        } else if (err instanceof YouTubeApiError) {
          sendError(res, 502, "YouTube-kutsu epäonnistui", err.message);
        } else {
          sendError(res, 500, "palvelinvirhe", err instanceof Error ? err.message : String(err));
        }
      } else {
        res.end();
      }
    });
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[control] kuuntelee osoitteessa http://${CONFIG.host}:${CONFIG.port}/`);
  });

  const shutdown = () => {
    // Stopping the scheduler stops it from acting; it never stops a broadcast
    // that is already on air (uptime first — that is systemd's business).
    scheduler.stop();
    // Polleri pysäytetään erikseen: sen ajastin on aggregaattorista
    // riippumaton, eikä kesken oleva YouTube-kutsu saa pitää prosessia
    // pystyssä sammutuksen jälkeen.
    sourceIngest.stop();
    live.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[control] käynnistys epäonnistui:", err);
  process.exit(1);
});
