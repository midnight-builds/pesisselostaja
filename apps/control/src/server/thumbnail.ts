/** Thumbnail rendering for the YouTube production chain.
 *
 *  This module deliberately contains NO layout logic of its own — the actual
 *  drawing (LIVE badge, headline wrap, safe margins) lives in the canonical
 *  PIL composer `tools/pesaysit-thumbnail-compose.py` (DESIGN.md, runbook's
 *  "Thumbnail-saannot"), which stays exactly as it is. This file's only job
 *  is to shell out to it safely and cache the result:
 *
 *  - execFile, never a shell: headline/venue text arrives verbatim from an
 *    HTTP body, and a shell would turn a stray `"; rm -rf ~ #` into command
 *    injection on the box that runs the broadcast.
 *  - The preview route (POST /api/thumbnail/preview) calls the exact same
 *    renderThumbnail() as the render route — DESIGN.md's "esikatselu on
 *    totuus" decision means there is only one code path to keep honest.
 *  - Cached by a hash of the four inputs: the composer is a pure function of
 *    (background, headline, datetime, venue, narrated) and the background is
 *    fixed, so identical inputs always produce identical output. Re-running
 *    Python on every keystroke of a live preview would be wasteful and slow
 *    on a phone's connection. */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG } from "./config.js";

const run = promisify(execFile);

// apps/control/src/server/thumbnail.ts -> apps/control/tools/... . Resolved
// from this file's own location (like config.ts) so it doesn't depend on
// process.cwd() at startup.
const COMPOSE_SCRIPT = fileURLToPath(
  new URL("../../tools/pesaysit-thumbnail-compose.py", import.meta.url)
);

const BACKGROUND_FILE = "pesaysit-bg-raw-001.png";

/** The one canonical background (CLAUDE.md/runbook: never edited, never
 *  swapped for an older one with baked-in text from a previous match).
 *
 *  Read live from CONFIG.assetsDir for the same reason as cacheDir() below,
 *  plus one of its own: the image itself is NOT in git (2 MB brand asset,
 *  public repo), so CI has no copy of it. A test that hard-codes the real
 *  file can only pass on a machine that happens to have it — which is how
 *  five thumbnail tests turned green locally and red on the runner. Pointing
 *  assetsDir at a generated stand-in lets the tests exercise the actual PIL
 *  composition everywhere. */
function backgroundPath(): string {
  return join(CONFIG.assetsDir, BACKGROUND_FILE);
}

/** Runbook's "Thumbnail-saannot" > Selostus-versio: exact required wording. */
const NARRATED_BADGE_TEXT = "Selostettu tekoälyllä";

const RENDER_TIMEOUT_MS = 15_000;

export interface ThumbnailOptions {
  headline: string;
  datetime: string;
  venue: string;
  narrated: boolean;
}

export class ThumbnailRenderError extends Error {}

/** CONFIG.stateDir is read live (not captured at import time) so tests can
 *  redirect it before calling anything here, the same way relay.ts and
 *  store.ts read CONFIG.* at call time rather than at module load. */
function cacheDir(): string {
  return join(CONFIG.stateDir, "thumbnails");
}

function cachePath(id: string): string {
  return join(cacheDir(), `${id}.png`);
}

/** Exposed so callers (the /render route) can hand back the exact on-disk
 *  path a later YouTube-upload step should read, without recomputing the
 *  join() themselves and risking it drifting from where renderThumbnail
 *  actually writes. */
export function thumbnailCachePath(id: string): string {
  return cachePath(id);
}

/** Deterministic identity of a render: the composer has no other input besides
 *  the fixed background, so this hash IS the cache key and doubles as the id
 *  the /render route returns for a later YouTube upload to ask for by name. */
export function thumbnailId(opts: ThumbnailOptions): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      headline: opts.headline,
      datetime: opts.datetime,
      venue: opts.venue,
      narrated: opts.narrated,
    })
  );
  return hash.digest("hex").slice(0, 24);
}

/** Validates and narrows an arbitrary request body into ThumbnailOptions.
 *  Lives here rather than in index.ts so both routes (preview, render) share
 *  one Finnish error message instead of two that could drift. */
export function parseThumbnailRequest(body: unknown): ThumbnailOptions {
  if (!body || typeof body !== "object") {
    throw new Error("pyynnön runko puuttuu");
  }
  const b = body as Record<string, unknown>;
  const headline = typeof b.headline === "string" ? b.headline.trim() : "";
  const datetime = typeof b.datetime === "string" ? b.datetime.trim() : "";
  const venue = typeof b.venue === "string" ? b.venue.trim() : "";
  if (!headline) throw new Error("headline puuttuu tai on tyhjä");
  if (!datetime) throw new Error("datetime puuttuu tai on tyhjä");
  if (!venue) throw new Error("venue puuttuu tai on tyhjä");
  const narrated = b.narrated === true;
  return { headline, datetime, venue, narrated };
}

interface ExecFileFailure {
  code?: string;
  stderr?: unknown;
}

function stderrOf(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    return String((err as ExecFileFailure).stderr ?? "");
  }
  return "";
}

/** True when the failure looks like a missing python3 binary or a missing
 *  Pillow install, so the route can hand back a sentence naming the fix
 *  instead of letting a raw traceback (or "ENOENT") reach the phone. */
function isMissingDependency(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? (err as ExecFileFailure).code : undefined;
  if (code === "ENOENT") return true;
  return /ModuleNotFoundError|No module named ['"]PIL['"]/i.test(stderrOf(err));
}

function renderErrorFrom(err: unknown): ThumbnailRenderError {
  if (isMissingDependency(err)) {
    return new ThumbnailRenderError(
      "Thumbnailin renderöinti epäonnistui: palvelimelta puuttuu python3 tai Pillow-kirjasto. " +
        "Asenna jompikumpi: sudo apt install python3-pil (tai: pip install Pillow)."
    );
  }
  const detail = stderrOf(err).trim();
  const message = detail || (err instanceof Error ? err.message : String(err));
  return new ThumbnailRenderError(`Thumbnailin renderöinti epäonnistui: ${message}`);
}

/** Renders one thumbnail, or returns the cached PNG for identical inputs.
 *  narrated:true adds the top-left "Selostettu tekoälyllä" badge the runbook
 *  requires for the narrated variant; everything else about the layout is
 *  the composer script's own job (LIVE badge, headline wrap, margins). */
export async function renderThumbnail(opts: ThumbnailOptions): Promise<Buffer> {
  const id = thumbnailId(opts);
  const dest = cachePath(id);

  try {
    return await readFile(dest);
  } catch {
    // Not cached yet (or cache dir doesn't exist) — fall through to render.
  }

  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  // Written next to the destination (not os.tmpdir()) so the final rename()
  // stays on one filesystem and is atomic — the same reasoning as
  // writeFileAtomic in relay.ts/store.ts.
  const tmpOut = join(dir, `.tmp-${id}-${process.pid}-${randomBytes(4).toString("hex")}.png`);

  const args = [
    COMPOSE_SCRIPT,
    "--bg",
    backgroundPath(),
    "--out",
    tmpOut,
    "--headline",
    opts.headline,
    "--datetime",
    opts.datetime,
    "--venue",
    opts.venue,
  ];
  if (opts.narrated) {
    args.push("--left-badge-text", NARRATED_BADGE_TEXT);
  }

  try {
    // execFile, never exec/shell: opts.* come straight from an HTTP body.
    await run("python3", args, { timeout: RENDER_TIMEOUT_MS });
    const buf = await readFile(tmpOut);
    await rename(tmpOut, dest);
    return buf;
  } catch (err) {
    throw renderErrorFrom(err);
  } finally {
    // On success the file has already moved to `dest`, so this is a no-op
    // then; on any failure (missing python3, a bad font path, a timeout) it
    // guarantees no stray .tmp-*.png is left behind in run/thumbnails/.
    await rm(tmpOut, { force: true });
  }
}
