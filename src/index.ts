import "dotenv/config";
import { parseArgs } from "node:util";
import { fetchMatchMetadata, fetchLiveEvents } from "./api.js";
import { buildPlayerLookup, eventToSpeech, eventFingerprint } from "./speech.js";
import { speak, type HaConfig } from "./ha.js";
import { loadState, saveState, type WatcherState } from "./state.js";
import { WatcherController } from "./watcher.js";
import { startServer } from "./server.js";
import type { AppConfig, LiveEvent } from "./types.js";

function parseMatchUrl(url: string): number {
  const match = url.match(/ottelut\/(\d+)/);
  if (!match) throw new Error(`Cannot parse match ID from URL: ${url}`);
  return parseInt(match[1], 10);
}

function parseCliArgs(): AppConfig {
  const { values } = parseArgs({
    options: {
      "match-url": { type: "string" },
      "match-id": { type: "string" },
      "poll-interval": { type: "string", default: "6" },
      "dry-run": { type: "boolean", default: false },
      "no-batter-changes": { type: "boolean", default: false },
      "state-file": { type: "string" },
      "api-key": { type: "string" },
    },
    strict: true,
  });

  let matchId: number;
  if (values["match-url"]) {
    matchId = parseMatchUrl(values["match-url"]);
  } else if (values["match-id"]) {
    matchId = parseInt(values["match-id"], 10);
  } else {
    console.error("Error: --match-url or --match-id is required");
    process.exit(1);
  }

  if (isNaN(matchId)) {
    console.error("Error: invalid match ID");
    process.exit(1);
  }

  const pollInterval = parseInt(values["poll-interval"] ?? "6", 10) * 1000;
  const dryRun = values["dry-run"] ?? false;
  const announceBatterChanges = !(values["no-batter-changes"] ?? false);
  const apiKey = values["api-key"] ?? process.env.PESISTULOKSET_API_KEY ?? "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";
  const apiBase = process.env.PESISTULOKSET_API_BASE ?? "https://api.pesistulokset.fi/api/v1";

  const haUrl = process.env.HOMEASSISTANT_URL ?? "";
  const haToken = process.env.HOMEASSISTANT_TOKEN ?? "";
  const haTtsEntity = process.env.HA_TTS_ENTITY ?? "tts.home_assistant_cloud";
  const haMediaPlayerEntity = process.env.HA_MEDIA_PLAYER_ENTITY ?? "media_player.living_room_speaker";

  if (!dryRun && (!haUrl || !haToken)) {
    console.error("Error: HOMEASSISTANT_URL and HOMEASSISTANT_TOKEN env vars required (or use --dry-run)");
    process.exit(1);
  }

  const stateFile = values["state-file"] ?? `.state-${matchId}.json`;

  return {
    matchId,
    pollInterval,
    dryRun,
    announceBatterChanges,
    apiKey,
    apiBase,
    haUrl,
    haToken,
    haTtsEntity,
    haMediaPlayerEntity,
    stateFile,
  };
}

async function processEvents(
  events: LiveEvent[],
  state: WatcherState,
  config: AppConfig,
  meta: Awaited<ReturnType<typeof fetchMatchMetadata>>,
  lookup: ReturnType<typeof buildPlayerLookup>,
  haConfig: HaConfig,
  silent = false
): Promise<void> {
  for (const event of events) {
    for (let i = 0; i < event.events.length; i++) {
      const fp = eventFingerprint(event, i);
      if (state.seenFingerprints.has(fp)) continue;
      state.seenFingerprints.add(fp);

      if (silent) continue;

      const speech = eventToSpeech(event, meta, lookup, config.announceBatterChanges);
      if (!speech) continue;

      const ts = new Date().toLocaleTimeString("fi-FI");
      if (config.dryRun) {
        console.log(`[${ts}] 🔊 ${speech}`);
      } else {
        console.log(`[${ts}] Speaking: ${speech}`);
        try {
          await speak(haConfig, speech);
        } catch (err) {
          console.error(`[${ts}] TTS error:`, err instanceof Error ? err.message : err);
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      break;
    }

    if (event.timestamp !== null && event.timestamp > state.lastTimestamp) {
      state.lastTimestamp = event.timestamp;
    }
  }
}

async function runCli(): Promise<void> {
  const config = parseCliArgs();

  console.log(`Pesisselostaja`);
  console.log(`Match ID: ${config.matchId}`);
  console.log(`Poll interval: ${config.pollInterval / 1000}s`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Batter changes: ${config.announceBatterChanges}`);
  console.log(`State file: ${config.stateFile}`);
  if (!config.dryRun) console.log(`HA URL: ${config.haUrl}`);

  console.log("Fetching match metadata...");
  const meta = await fetchMatchMetadata(config.matchId, {
    apiBase: config.apiBase,
    apiKey: config.apiKey,
  });
  const lookup = buildPlayerLookup(meta);

  console.log(`${meta.home.name} (${meta.home.shorthand}) vs ${meta.away.name} (${meta.away.shorthand})`);
  console.log(`Series: ${meta.series.custom_name ?? meta.series.name}`);
  console.log(`Stadium: ${meta.stadium.name}`);
  console.log(`Players loaded: ${lookup.byId.size}`);

  const haConfig: HaConfig = {
    url: config.haUrl,
    token: config.haToken,
    ttsEntity: config.haTtsEntity,
    mediaPlayerEntity: config.haMediaPlayerEntity,
  };

  const state = loadState(config.stateFile);
  console.log(`Loaded state: ${state.seenFingerprints.size} seen events`);

  console.log("Fetching initial events...");
  const initial = await fetchLiveEvents(config.matchId, { apiBase: config.apiBase });
  await processEvents(initial.events, state, config, meta, lookup, haConfig, true);
  saveState(config.stateFile, state);
  console.log(`Skipped ${initial.events.length} historical events, ${state.seenFingerprints.size} fingerprints tracked`);

  if (!meta.live && meta.started) {
    console.log("Match has already ended. Exiting after processing all events.");
    return;
  }

  console.log("Starting poll loop...");
  const poll = async () => {
    try {
      const data = await fetchLiveEvents(config.matchId, { apiBase: config.apiBase });
      await processEvents(data.events, state, config, meta, lookup, haConfig);
      saveState(config.stateFile, state);
    } catch (err) {
      console.error("Poll error:", err instanceof Error ? err.message : err);
    }
  };

  let running = true;
  const shutdown = () => {
    console.log("\nShutting down...");
    running = false;
    saveState(config.stateFile, state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    await new Promise((r) => setTimeout(r, config.pollInterval));
    await poll();
  }
}

function runServer(): void {
  const haUrl = process.env.HOMEASSISTANT_URL ?? "";
  const haToken = process.env.HOMEASSISTANT_TOKEN ?? "";
  const dryRun = !haUrl || !haToken;
  if (dryRun) {
    console.log("HOMEASSISTANT_URL tai HOMEASSISTANT_TOKEN puuttuu — testitila, ei oikeaa TTS:ää");
  }

  const watcher = new WatcherController({
    pollInterval: parseInt(process.env.POLL_INTERVAL ?? "6", 10) * 1000,
    dryRun,
    announceBatterChanges: process.env.NO_BATTER_CHANGES !== "true",
    apiKey: process.env.PESISTULOKSET_API_KEY ?? "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9",
    apiBase: process.env.PESISTULOKSET_API_BASE ?? "https://api.pesistulokset.fi/api/v1",
    haUrl,
    haToken,
    haTtsEntity: process.env.HA_TTS_ENTITY ?? "tts.home_assistant_cloud",
    haMediaPlayerEntity: process.env.HA_MEDIA_PLAYER_ENTITY ?? "media_player.living_room_speaker",
    pronunciationsFile: process.env.PRONUNCIATIONS_FILE ?? ".pronunciations.json",
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  startServer(watcher, port);
}

// If called with --match-url or --match-id, run in CLI mode; otherwise start the UI server.
const hasMatchArgs = process.argv.some((a) => a.startsWith("--match-url") || a.startsWith("--match-id"));

if (hasMatchArgs) {
  runCli().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else {
  runServer();
}
