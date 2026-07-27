import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRunDir, DAY_MS } from "../src/runRetention.js";

const NOW = Date.parse("2026-07-27T12:00:00Z");
const daysAgo = (n: number) => NOW - n * DAY_MS;

describe("pruneRunDir (issue #39)", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "pesis-run-retention-"));
  });
  afterEach(() => rmSync(runDir, { recursive: true, force: true }));

  function file(relPath: string, bytes: number, mtimeMs: number): string {
    const full = join(runDir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, Buffer.alloc(bytes));
    utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
    return full;
  }

  const sha = (c: string) => c.repeat(64);

  describe("(a) old run artifacts are swept", () => {
    it("removes the relay's own stale files and reports what it freed", async () => {
      file("relay-143277.pcm", 0, daysAgo(40));
      file(".state-143277.json", 1000, daysAgo(40));
      file(".control-143277.json", 100, daysAgo(40));

      const result = await pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 0, now: NOW });

      expect(result.removed).toHaveLength(3);
      expect(result.freedBytes).toBe(1100);
      expect(existsSync(join(runDir, "relay-143277.pcm"))).toBe(false);
      expect(existsSync(join(runDir, ".state-143277.json"))).toBe(false);
    });

    it("keeps artifacts inside the retention window", async () => {
      file("relay-146210.pcm", 0, daysAgo(3));
      const result = await pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 0, now: NOW });
      expect(result.removed).toEqual([]);
      expect(existsSync(join(runDir, "relay-146210.pcm"))).toBe(true);
    });

    it("never sweeps the match that is starting right now, however stale its state file", async () => {
      file(".state-146210.json", 500, daysAgo(400));
      const result = await pruneRunDir(runDir, {
        maxAgeMs: 30 * DAY_MS,
        ttsCacheMaxBytes: 0,
        keepMatchIds: [146210],
        now: NOW,
      });
      expect(result.removed).toEqual([]);
      expect(existsSync(join(runDir, ".state-146210.json"))).toBe(true);
    });

    it("maxAgeMs 0 disables age pruning entirely", async () => {
      file("relay-1.pcm", 0, daysAgo(999));
      const result = await pruneRunDir(runDir, { maxAgeMs: 0, ttsCacheMaxBytes: 0, now: NOW });
      expect(result.removed).toEqual([]);
    });
  });

  describe("(b) operator material is protected", () => {
    it("leaves non-relay files and directories alone no matter how old or big", async () => {
      // Everything here predates the window by a year and would be swept by a
      // naive "delete old stuff in run/" implementation.
      const protectedPaths = [
        file("field-audio-demo/mix.wav", 5000, daysAgo(365)),
        file("voice-tuning-demo/a.wav", 5000, daysAgo(365)),
        file("voice-tuning-demo-2/b.wav", 5000, daysAgo(365)),
        file("simulate-143267/narration.pcm", 9000, daysAgo(365)),
        file("live-test-143277.mp4", 9000, daysAgo(365)),
        file("live-test-143277-partial-40s.mp4", 9000, daysAgo(365)),
        file("HANDOFF-notes.md", 10, daysAgo(365)),
        file(".env.relay", 10, daysAgo(365)),
      ];

      const result = await pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 1, now: NOW });

      expect(result.removed).toEqual([]);
      for (const path of protectedPaths) expect(existsSync(path)).toBe(true);
    });

    it("does not follow the relay naming rule into subdirectories", async () => {
      // A simulation run may contain identically named artifacts; only the
      // top level of run/ is the relay's own.
      const nested = file("simulate-143267/relay-143267.pcm", 100, daysAgo(365));
      await pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 0, now: NOW });
      expect(existsSync(nested)).toBe(true);
    });

    it("does not remove a directory that happens to match a relay filename", async () => {
      const dir = join(runDir, "relay-143277.pcm");
      mkdirSync(dir);
      utimesSync(dir, new Date(daysAgo(365)), new Date(daysAgo(365)));
      await pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 0, now: NOW });
      expect(existsSync(dir)).toBe(true);
    });

    it("only evicts sha-named .pcm entries from tts-cache", async () => {
      const stray = file("tts-cache/README.txt", 10_000, daysAgo(365));
      file(`tts-cache/${sha("a")}.pcm`, 10_000, daysAgo(10));
      const result = await pruneRunDir(runDir, { maxAgeMs: 0, ttsCacheMaxBytes: 1, now: NOW });
      expect(existsSync(stray)).toBe(true);
      expect(result.removed).toEqual([join(runDir, `tts-cache/${sha("a")}.pcm`)]);
    });
  });

  describe("tts-cache size ceiling", () => {
    it("evicts least-recently-used clips until the directory fits the budget", async () => {
      const oldest = file(`tts-cache/${sha("a")}.pcm`, 400, daysAgo(20));
      const middle = file(`tts-cache/${sha("b")}.pcm`, 400, daysAgo(10));
      const newest = file(`tts-cache/${sha("c")}.pcm`, 400, daysAgo(1));

      const result = await pruneRunDir(runDir, { maxAgeMs: 0, ttsCacheMaxBytes: 800, now: NOW });

      expect(result.removed).toEqual([oldest]);
      expect(result.freedBytes).toBe(400);
      expect(existsSync(middle)).toBe(true);
      expect(existsSync(newest)).toBe(true);
    });

    it("leaves the cache untouched when it already fits", async () => {
      file(`tts-cache/${sha("a")}.pcm`, 400, daysAgo(20));
      const result = await pruneRunDir(runDir, { maxAgeMs: 0, ttsCacheMaxBytes: 800, now: NOW });
      expect(result.removed).toEqual([]);
    });

    it("ttsCacheMaxBytes 0 disables cache pruning", async () => {
      const kept = file(`tts-cache/${sha("a")}.pcm`, 4000, daysAgo(365));
      const result = await pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 0, now: NOW });
      expect(result.removed).toEqual([]);
      expect(existsSync(kept)).toBe(true);
    });

    it("age pruning does not touch tts-cache entries (only the size ceiling does)", async () => {
      const kept = file(`tts-cache/${sha("a")}.pcm`, 100, daysAgo(365));
      await pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 1_000_000, now: NOW });
      expect(existsSync(kept)).toBe(true);
    });
  });

  describe("(c) missing directories", () => {
    it("does not throw when run/ does not exist", async () => {
      const missing = join(runDir, "no-such-dir");
      await expect(
        pruneRunDir(missing, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 1000, now: NOW })
      ).resolves.toEqual({ removed: [], freedBytes: 0 });
    });

    it("does not throw when run/ exists but tts-cache/ does not", async () => {
      file("relay-1.pcm", 0, daysAgo(1));
      await expect(
        pruneRunDir(runDir, { maxAgeMs: 30 * DAY_MS, ttsCacheMaxBytes: 1000, now: NOW })
      ).resolves.toEqual({ removed: [], freedBytes: 0 });
    });
  });
});
