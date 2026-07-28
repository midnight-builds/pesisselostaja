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
import { getDayMatches, getMatch } from "./matches.js";
import {
  listJobs,
  createJob,
  patchJob,
  activateJob,
  getActiveJob,
  MatchNotFoundError,
} from "./jobs.js";
import { addSubscription, getSubscriptionCount, getVapidPublicKey, sendPushDetailed } from "./push.js";
import { getNotificationPrefs, observeLiveState, setNotificationPrefs } from "./notifications.js";
import type { CreateJobRequest, PatchJobRequest, PatchKnobsRequest } from "../shared/api.js";
import type { LiveState, NotificationPrefs } from "../shared/types.js";

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
    const job = await activateJob(activateMatch[1]);
    // The route's whole job (api.ts): flipping a job to active is what makes
    // it the one the relay will actually broadcast, so writing .env.relay is
    // part of activation, not a separate step the client has to remember.
    await writeRelayEnv(job);
    sendJson(res, 200, job);
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

  const relayActionMatch = pathname.match(/^\/api\/relay\/(start|stop|restart)$/);
  if (relayActionMatch && method === "POST") {
    const action = relayActionMatch[1];
    if (action === "start") await startRelay();
    else if (action === "stop") await stopRelay();
    else await restartRelay();
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

  // The live view needs to know which job is currently the relay's job to
  // know what to poll; the aggregator asks rather than the server pushing it
  // in, so a job activated after the aggregator started is picked up too.
  const live = startLiveAggregator({ getActiveJob });

  // Push triggers ride along as an ordinary subscriber instead of being wired
  // into the aggregator itself: notifications can then never alter, delay or
  // break the state the phone renders — the worst a bug in there can do is
  // fail to notify.
  live.subscribe(observeLiveState);

  const server = createServer((req, res) => {
    // A single route's error must never take the whole server down — every
    // request funnels through this try/catch, on top of whatever a handler
    // does itself.
    route(req, res, live).catch((err) => {
      console.error("[control]", req.method, req.url, err);
      if (!res.headersSent) {
        sendError(res, 500, "palvelinvirhe", err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    });
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[control] kuuntelee osoitteessa http://${CONFIG.host}:${CONFIG.port}/`);
  });

  const shutdown = () => {
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
