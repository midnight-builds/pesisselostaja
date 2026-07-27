import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { RELAY_ENV_FILE, loadRelayEnv } from "../src/relayEnv.js";

/** Names nothing else uses, so the test can scrub them from process.env. */
const KEYS = ["RELAY_TEST_ONLY_A", "RELAY_TEST_ONLY_B", "RELAY_TEST_ONLY_C"];

function envFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "pesis-relay-env-")), ".env.relay");
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("relay env loading (issue #55)", () => {
  it("reads settings out of the given .env.relay", () => {
    loadRelayEnv([envFile("RELAY_TEST_ONLY_A=tiedostosta\n")]);
    expect(process.env.RELAY_TEST_ONLY_A).toBe("tiedostosta");
  });

  it("never overwrites a variable systemd already exported", () => {
    process.env.RELAY_TEST_ONLY_B = "ymparistosta";
    loadRelayEnv([envFile("RELAY_TEST_ONLY_B=tiedostosta\n")]);
    expect(process.env.RELAY_TEST_ONLY_B).toBe("ymparistosta");
  });

  it("lets .env.relay win over the repo-root .env, like EnvironmentFile does", () => {
    const relay = envFile("RELAY_TEST_ONLY_C=relaysta\n");
    const dotenv = envFile("RELAY_TEST_ONLY_C=juuresta\n");
    loadRelayEnv([relay, dotenv]);
    expect(process.env.RELAY_TEST_ONLY_C).toBe("relaysta");
  });

  it("defaults to the file the systemd unit's EnvironmentFile points at", () => {
    expect(RELAY_ENV_FILE).toBe(resolve(import.meta.dirname, "../.env.relay"));
    expect(RELAY_ENV_FILE.endsWith(`apps${sep}broadcast${sep}.env.relay`)).toBe(true);
  });

  // Every executable entrypoint, not just the live relay: bare dotenv/config
  // reads the repo-root .env only, which is how the dry-run drifted from live.
  it.each(["index.ts", "simulate.ts"])("is what %s loads — not bare dotenv/config", (entrypoint) => {
    const source = readFileSync(resolve(import.meta.dirname, "../src", entrypoint), "utf8");
    expect(source).toMatch(/loadRelayEnv\(\)/);
    expect(source).not.toMatch(/dotenv\/config/);
  });
});
