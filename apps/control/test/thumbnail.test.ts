// thumbnail.ts shells out to the canonical PIL composer
// (tools/pesaysit-thumbnail-compose.py) via execFile and caches the result
// under CONFIG.stateDir/thumbnails. CONFIG.stateDir is read live (not
// captured at import time — see thumbnail.ts's cacheDir()), so a plain
// static import plus overriding CONFIG.stateDir per test is enough; no need
// for the dynamic-import trick jobs.test.ts uses for its eager store.
//
// These tests actually invoke python3 + Pillow (both present on this box —
// see docs/youtube-runbook.md) rather than mocking child_process: the whole
// point of this module is "does the real render work", and a mock would only
// prove the mock works.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/server/config.js";
import {
  parseThumbnailRequest,
  renderThumbnail,
  thumbnailCachePath,
  thumbnailId,
  ThumbnailRenderError,
  type ThumbnailOptions,
} from "../src/server/thumbnail.js";

let tmpDir: string;
let originalStateDir: string;
let originalPath: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pesis-control-thumbnail-"));
  originalStateDir = CONFIG.stateDir;
  originalPath = process.env.PATH;
  CONFIG.stateDir = tmpDir;
});

afterEach(() => {
  CONFIG.stateDir = originalStateDir;
  process.env.PATH = originalPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_OPTS: ThumbnailOptions = {
  headline: "Pesä Ysit G - SuPo G mustat",
  datetime: "21.3.2026 klo 10:00",
  venue: "Kotka Ruonalan urheiluhalli",
  narrated: false,
};

/** Pulls width/height straight out of the PNG IHDR chunk (bytes 16-23) —
 *  avoids pulling in an image-decoding dependency just to assert on a fixed
 *  1280x720 output. */
function pngDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("renderThumbnail", () => {
  it("renders a real 1280x720 PNG", async () => {
    const buf = await renderThumbnail(BASE_OPTS);
    expect(buf.length).toBeGreaterThan(1000);
    expect(pngDimensions(buf)).toEqual({ width: 1280, height: 720 });
  }, 20_000);

  it("caches identical input instead of re-rendering", async () => {
    const first = await renderThumbnail(BASE_OPTS);

    // If a second call re-shelled out to python3, an empty PATH would make
    // that fail with ENOENT. It doesn't fail, so this proves the cache hit
    // rather than merely asserting the returned bytes match.
    process.env.PATH = "";
    const second = await renderThumbnail(BASE_OPTS);
    expect(second.equals(first)).toBe(true);
  }, 20_000);

  it("produces a different (and differently keyed) image when narrated", async () => {
    const plain = await renderThumbnail(BASE_OPTS);
    const narrated = await renderThumbnail({ ...BASE_OPTS, narrated: true });
    expect(narrated.equals(plain)).toBe(false);
    expect(thumbnailId({ ...BASE_OPTS, narrated: true })).not.toBe(thumbnailId(BASE_OPTS));
  }, 30_000);

  it("wraps a very long team pairing without throwing, and stays 1280x720", async () => {
    const buf = await renderThumbnail({
      ...BASE_OPTS,
      headline: "Jyväskylän Kiri & Kirittäret Juniorit Rautiainen - Joensuun Maila Punainen",
    });
    expect(pngDimensions(buf)).toEqual({ width: 1280, height: 720 });
  }, 20_000);

  it("writes the cached file at the path thumbnailCachePath() reports", async () => {
    await renderThumbnail(BASE_OPTS);
    const id = thumbnailId(BASE_OPTS);
    expect(thumbnailCachePath(id)).toBe(join(tmpDir, "thumbnails", `${id}.png`));
  }, 20_000);

  it("raises a Finnish, dependency-naming error when python3 is missing, and leaves no temp file behind", async () => {
    process.env.PATH = ""; // no python3 reachable
    const uncached: ThumbnailOptions = { ...BASE_OPTS, headline: "Ottelu jota ei ole vielä renderöity" };

    await expect(renderThumbnail(uncached)).rejects.toThrow(ThumbnailRenderError);
    await expect(renderThumbnail(uncached)).rejects.toThrow(/python3|Pillow/);

    const thumbsDir = join(tmpDir, "thumbnails");
    const leftovers = readdirSync(thumbsDir).filter((name) => name.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
  }, 20_000);
});

describe("parseThumbnailRequest", () => {
  it("accepts a full body and defaults narrated to false", () => {
    expect(parseThumbnailRequest({ headline: "H", datetime: "D", venue: "V" })).toEqual({
      headline: "H",
      datetime: "D",
      venue: "V",
      narrated: false,
    });
  });

  it("passes narrated:true through", () => {
    expect(parseThumbnailRequest({ headline: "H", datetime: "D", venue: "V", narrated: true }).narrated).toBe(
      true
    );
  });

  it.each(["headline", "datetime", "venue"])("rejects a missing %s", (field) => {
    const body: Record<string, unknown> = { headline: "H", datetime: "D", venue: "V" };
    delete body[field];
    expect(() => parseThumbnailRequest(body)).toThrow(new RegExp(field));
  });

  it("rejects a non-object body", () => {
    expect(() => parseThumbnailRequest(null)).toThrow();
    expect(() => parseThumbnailRequest("nope")).toThrow();
  });
});
