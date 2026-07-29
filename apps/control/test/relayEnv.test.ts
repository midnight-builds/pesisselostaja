// writeRelayEnv is the most production-critical function in the control app:
// it rewrites the exact .env.relay file the live relay's systemd unit reads
// on start (see apps/control/src/server/relay.ts, CLAUDE.md "Running"). A bug
// here can silently drop the operator's ElevenLabs key or point a live
// broadcast at the wrong match. Everything below runs against a throwaway
// temp file — CONFIG.relayEnvPath is redirected there, never at the real
// apps/broadcast/.env.relay.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/server/config.js";
import { writeRelayEnv } from "../src/server/relay.js";
import type { Job } from "../src/shared/types.js";
import { DEFAULT_RTMP_URL } from "../src/shared/api.js";

let tmpDir: string;
let envPath: string;

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job1",
    status: "arming",
    createdAt: new Date().toISOString(),
    matchId: 146210,
    home: "Koti",
    away: "Vieras",
    seriesName: null,
    stadium: null,
    startsAt: null,
    sourceUrl: "https://youtube.com/watch?v=source",
    targetStreamKey: "stream-key-xyz",
    targetRtmpUrl: DEFAULT_RTMP_URL,
    targetVideoId: null,
    startedAt: null,
    endedAt: null,
    note: null,
    ...overrides,
  };
}

function readEnv(): string {
  return readFileSync(envPath, "utf8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pesis-control-relayenv-"));
  envPath = join(tmpDir, ".env.relay");
  CONFIG.relayEnvPath = envPath;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeRelayEnv", () => {
  it("creates a valid file when none exists yet", async () => {
    await writeRelayEnv(baseJob());
    const text = readEnv();
    expect(text).toContain("RELAY_MATCH_ID=146210");
    expect(text).toContain("RELAY_YOUTUBE_URL=https://youtube.com/watch?v=source");
    expect(text).toContain("RELAY_STREAM_KEY=stream-key-xyz");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("leaves operator-configured keys untouched (ELEVENLABS_API_KEY, RELAY_URL_REFRESH_MS)", async () => {
    writeFileSync(
      envPath,
      [
        "ELEVENLABS_API_KEY=sk-do-not-touch",
        "RELAY_URL_REFRESH_MS=1800000",
        "#RELAY_MATCH_ID=",
        "",
      ].join("\n")
    );
    await writeRelayEnv(baseJob({ matchId: 999 }));
    const text = readEnv();
    expect(text).toContain("ELEVENLABS_API_KEY=sk-do-not-touch");
    expect(text).toContain("RELAY_URL_REFRESH_MS=1800000");
  });

  it("replaces a commented #RELAY_MATCH_ID= placeholder in place, without duplicating the line", async () => {
    writeFileSync(
      envPath,
      ["ELEVENLABS_API_KEY=sk-abc", "#RELAY_MATCH_ID=", "RELAY_URL_REFRESH_MS=1800000", ""].join(
        "\n"
      )
    );
    await writeRelayEnv(baseJob({ matchId: 555 }));
    const lines = readEnv().split("\n").filter((l) => l.length > 0);

    const matchLines = lines.filter((l) => /RELAY_MATCH_ID/.test(l));
    expect(matchLines).toHaveLength(1);
    expect(matchLines[0]).toBe("RELAY_MATCH_ID=555");

    // Position is preserved: the match-id line stays where the placeholder was,
    // between the two operator keys, not appended at the bottom.
    const idx = lines.indexOf("RELAY_MATCH_ID=555");
    expect(lines[idx - 1]).toBe("ELEVENLABS_API_KEY=sk-abc");
  });

  it("overwrites an existing value for a match-scoped key rather than appending", async () => {
    writeFileSync(envPath, ["RELAY_MATCH_ID=1", "RELAY_YOUTUBE_URL=https://old", ""].join("\n"));
    await writeRelayEnv(baseJob({ matchId: 2, sourceUrl: "https://new" }));
    const lines = readEnv().split("\n").filter((l) => l.length > 0);
    expect(lines.filter((l) => l.startsWith("RELAY_MATCH_ID=")).length).toBe(1);
    expect(lines).toContain("RELAY_MATCH_ID=2");
    expect(lines).toContain("RELAY_YOUTUBE_URL=https://new");
    expect(lines).not.toContain("RELAY_YOUTUBE_URL=https://old");
  });

  it("keeps unrelated comment lines intact", async () => {
    writeFileSync(
      envPath,
      ["# operator notes, do not remove", "RELAY_MATCH_ID=1", ""].join("\n")
    );
    await writeRelayEnv(baseJob({ matchId: 2 }));
    expect(readEnv()).toContain("# operator notes, do not remove");
  });

  it("comments out a match-scoped key when the job has no value for it (e.g. missing stream key)", async () => {
    writeFileSync(envPath, ["RELAY_STREAM_KEY=old-key", ""].join("\n"));
    await writeRelayEnv(baseJob({ targetStreamKey: null }));
    const lines = readEnv().split("\n").filter((l) => l.length > 0);
    expect(lines).toContain("#RELAY_STREAM_KEY=");
    expect(lines).not.toContain("RELAY_STREAM_KEY=old-key");
  });

  it("writes all four match-scoped keys even from a completely empty file", async () => {
    writeFileSync(envPath, "");
    await writeRelayEnv(baseJob());
    const text = readEnv();
    for (const key of ["RELAY_MATCH_ID", "RELAY_YOUTUBE_URL", "RELAY_STREAM_KEY", "RELAY_RTMP_URL"]) {
      expect(text).toMatch(new RegExp(`^${key}=`, "m"));
    }
  });
});
