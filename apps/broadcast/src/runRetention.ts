import { readdir, stat, unlink } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";

/** Filename shapes the relay itself writes straight into run/. The retention
 *  sweep is an *allowlist*: anything not matching one of these is operator
 *  material (the field-audio-demo, voice-tuning-demo and simulate-<id>
 *  directories, hand-made live-test recordings, …) and is never touched, no
 *  matter how old or how big. Directories are never removed at all — see
 *  pruneRunDir. */
const RUN_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /^relay-(\d+)\.pcm$/, // narration FIFO, one per match (0 bytes, but piles up)
  /^\.state-(\d+)\.json$/, // resume state
  /^\.control-(\d+)\.json$/, // live control file
  // …and a control file whose rename never happened. The control app writes
  // this one atomically through a uniquely-named temp file
  // (apps/control/src/server/relay.ts), so a crash between writeFile and
  // rename leaves `.control-<id>.json.tmp-<pid>-<n>` behind — every 30 s while
  // the source-ingest poller runs. Same reason status-<id>.json.tmp is listed.
  /^\.control-(\d+)\.json\.tmp-\d+-\d+$/,
  /^status-(\d+)\.json$/, // telemetry snapshot
  /^status-(\d+)\.json\.tmp$/, // …and a snapshot whose rename never happened
  /^timeline-(\d+)\.ndjson$/, // telemetry timeline
];

const TTS_CACHE_DIR = "tts-cache";
/** ElevenLabs cache entries are sha256(model|voice|text) + ".pcm". */
const TTS_CACHE_ENTRY = /^[0-9a-f]{64}\.pcm$/;

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Conservative defaults: nothing the operator produced this month disappears,
 *  and the regenerable TTS cache gets a ceiling rather than a purge.
 *
 *  1024 MB, not the original 512: the cache had already grown to 559 MB of
 *  genuinely reused clips by the time the policy landed, so 512 would have
 *  evicted ~47 MB on the very first relay start. Eviction is not free — a
 *  dropped clip is re-synthesized on its next use and costs ElevenLabs
 *  characters, and the quota is the scarcer resource of the two (disk had
 *  36 Gt free at the time). */
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_TTS_CACHE_MAX_MB = 1024;

export interface RunRetentionOptions {
  /** Run artifacts older than this are removed. 0 disables age pruning. */
  maxAgeMs: number;
  /** Size ceiling for run/tts-cache/; oldest-touched entries are evicted until
   *  the directory fits. 0 disables cache pruning. */
  ttsCacheMaxBytes: number;
  /** Match ids whose artifacts must survive regardless of age — the run that
   *  is starting right now owns its state/control files. */
  keepMatchIds?: readonly number[];
  now?: number;
}

export interface RunRetentionResult {
  removed: string[];
  freedBytes: number;
}

/** Enforces the run/ retention policy. Safe to call on every relay start:
 *  a missing run/ (or missing tts-cache/) is a no-op, and per-file errors are
 *  swallowed so retention can never keep a broadcast from starting. */
export async function pruneRunDir(
  runDir: string,
  opts: RunRetentionOptions
): Promise<RunRetentionResult> {
  const now = opts.now ?? Date.now();
  const keep = new Set((opts.keepMatchIds ?? []).map((id) => String(id)));
  const result: RunRetentionResult = { removed: [], freedBytes: 0 };

  if (opts.maxAgeMs > 0) {
    for (const entry of await listDir(runDir)) {
      // Directories are out of scope entirely: run/ hosts operator artifacts
      // (demos, simulation output) that only a human may delete.
      if (!entry.isFile() && !entry.isFIFO()) continue;
      const matchId = matchIdOfArtifact(entry.name);
      if (matchId === null || keep.has(matchId)) continue;
      const path = join(runDir, entry.name);
      const info = await statOrNull(path);
      if (!info || now - info.mtimeMs <= opts.maxAgeMs) continue;
      await remove(path, info.size, result);
    }
  }

  if (opts.ttsCacheMaxBytes > 0) {
    const cacheDir = join(runDir, TTS_CACHE_DIR);
    const entries: { path: string; size: number; mtimeMs: number }[] = [];
    for (const entry of await listDir(cacheDir)) {
      if (!entry.isFile() || !TTS_CACHE_ENTRY.test(entry.name)) continue;
      const path = join(cacheDir, entry.name);
      const info = await statOrNull(path);
      if (info) entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    }
    // mtime is refreshed on every cache hit (see ElevenLabsTts), so ordering by
    // it evicts least-recently-*used* clips, not merely the oldest ones.
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (total <= opts.ttsCacheMaxBytes) break;
      const before = result.freedBytes;
      await remove(entry.path, entry.size, result);
      total -= result.freedBytes - before;
    }
  }

  return result;
}

/** The match id in a relay-owned filename, or null when the name is not one of
 *  ours (= must be left alone). */
function matchIdOfArtifact(name: string): string | null {
  for (const pattern of RUN_ARTIFACT_PATTERNS) {
    const m = name.match(pattern);
    if (m) return m[1];
  }
  return null;
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // never created yet, or removed under us
  }
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function remove(path: string, size: number, result: RunRetentionResult): Promise<void> {
  try {
    await unlink(path);
    result.removed.push(path);
    result.freedBytes += size;
  } catch {
    /* busy, permissions, already gone — retention is best-effort */
  }
}
