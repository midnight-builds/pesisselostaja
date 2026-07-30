// store.ts is the JSON-file persistence every control-plane state (jobs,
// knobs history, etc.) sits on top of. createStore() reads CONFIG.stateDir at
// the moment it's *called*, not at module-load time (unlike jobs.ts's
// top-level store), so a plain mutation of CONFIG.stateDir before each
// createStore() call is enough to isolate these tests in a temp directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/server/config.js";
import { createStore } from "../src/server/store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pesis-control-store-"));
  CONFIG.stateDir = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createStore", () => {
  it("returns the initial value when the file doesn't exist yet, without throwing", async () => {
    const store = createStore<number[]>("missing.json", []);
    await expect(store.read()).resolves.toEqual([]);
  });

  it("returns the initial value instead of crashing on corrupt JSON", async () => {
    writeFileSync(join(tmpDir, "broken.json"), "{ this is not valid json", "utf8");
    const store = createStore<{ ok: boolean }>("broken.json", { ok: false });
    await expect(store.read()).resolves.toEqual({ ok: false });
  });

  it("writes atomically: the file on disk always matches the last completed write", async () => {
    const store = createStore<{ n: number }>("atomic.json", { n: 0 });
    await store.write({ n: 42 });
    const raw = readFileSync(join(tmpDir, "atomic.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ n: 42 });
    await expect(store.read()).resolves.toEqual({ n: 42 });
  });

  it("leaves no leftover .tmp file behind after a write", async () => {
    const store = createStore<{ n: number }>("atomic2.json", { n: 0 });
    await store.write({ n: 1 });
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tmpDir);
    expect(files).toContain("atomic2.json");
    // Tmp-nimi on yksilöllinen (.tmp-<pid>-<n>), joten pelkkä endsWith ei riitä.
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });

  // google-token.json on ensimmäinen tiedosto jolla on kaksi kirjoittajaa:
  // taustapollerin tunnin välein uusiva update() ja operaattorin
  // uudelleenkirjautumisen write(). Ketjun ulkopuolinen write() ehtisi levylle
  // kesken update()n lue-muokkaa-kirjoita-jaksoa, ja update() kirjoittaisi
  // juuri saadun refresh tokenin päälle sen vanhan jonka se itse luki.
  it("serializes write() through the same chain as update(), so neither clobbers the other", async () => {
    for (let round = 0; round < 10; round++) {
      const store = createStore<{ from: string }>(`mixed-${round}.json`, { from: "initial" });
      await store.write({ from: "initial" });
      await Promise.all([
        store.update(() => ({ from: "update" })),
        store.write({ from: "write" }),
      ]);
      // Kutsujärjestys ratkaisee: write() jonottui update()n jälkeen.
      expect(await store.read()).toEqual({ from: "write" });
    }
  });

  it("a failed write does not poison the chain for later writers", async () => {
    const store = createStore<{ n: number }>("poison.json", { n: 0 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(store.write(circular as unknown as { n: number })).rejects.toThrow();
    await store.write({ n: 7 });
    await expect(store.read()).resolves.toEqual({ n: 7 });
  });

  it("serializes concurrent update() calls instead of losing writes to a race", async () => {
    const store = createStore<number[]>("concurrent.json", []);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.update((current) => [...current, i]))
    );
    const final = await store.read();
    expect(final.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i)
    );
  });

  it("keeps the update chain alive after one update's reducer throws", async () => {
    const store = createStore<number[]>("chain-survives.json", []);
    await store.update(() => [1]);
    await expect(
      store.update(() => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // The failure must not poison later updates queued behind it.
    const result = await store.update((current) => [...current, 2]);
    expect(result).toEqual([1, 2]);
  });
});
