/** Issue #155: preflight reported green about the wrong match.
 *
 *  On 31.7.2026, minutes before match 145918, all four match rows described
 *  YESTERDAY's match — truthfully, because `.env.relay` still named 145905 and
 *  "Kirjoita .env.relay" had not been run. "Lähde: livenä" was even true: the
 *  previous day's raakalähetys was still open. Nothing in the UI said which
 *  match the rows were about.
 *
 *  The binding check compares the env values against the job the operator has
 *  open. It is pure so it can be tested at all — the rest of runPreflight()
 *  shells out to yt-dlp, statfs and the network. */

import { describe, expect, it } from "vitest";

import { checkJobBinding, duplicateEnvKeys, mayRepairBinding } from "../src/server/preflight.js";
import type { Job } from "../src/shared/types.js";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "40ae910f",
    status: "scheduled",
    createdAt: "2026-07-31T05:00:00.000Z",
    matchId: 145918,
    home: "Kotijoukkue",
    away: "Vierasjoukkue",
    seriesName: null,
    stadium: null,
    startsAt: "2026-07-31T10:30:00.000Z",
    sourceUrl: "https://example.invalid/raaka-uusi",
    targetStreamKey: "avain-uusi",
    targetRtmpUrl: "rtmp://example.invalid/live2",
    targetVideoId: null,
    armedAt: null,
    startedAt: null,
    endedAt: null,
    cleanup: null,
    note: null,
    ...overrides,
  };
}

function boundEnv(): Record<string, string> {
  return {
    RELAY_MATCH_ID: "145918",
    RELAY_YOUTUBE_URL: "https://example.invalid/raaka-uusi",
    RELAY_STREAM_KEY: "avain-uusi",
    RELAY_RTMP_URL: "rtmp://example.invalid/live2",
  };
}

describe("preflight job binding (#155)", () => {
  it("passes when .env.relay points at the selected job", () => {
    const check = checkJobBinding(job(), boundEnv());
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("145918");
  });

  it("BLOCKS when the env file still names yesterday's match — the 31.7. case", () => {
    const stale = { ...boundEnv(), RELAY_MATCH_ID: "145905" };
    const check = checkJobBinding(job(), stale);
    expect(check.status).toBe("fail");
    // The operator must be able to act on the row without reading code.
    expect(check.detail).toContain("145905");
    expect(check.detail).toContain("Kirjoita .env.relay");
  });

  it("blocks on a stale source URL or stream key too, not just the match id", () => {
    expect(checkJobBinding(job(), { ...boundEnv(), RELAY_YOUTUBE_URL: "https://example.invalid/raaka-eilinen" }).status).toBe("fail");
    expect(checkJobBinding(job(), { ...boundEnv(), RELAY_STREAM_KEY: "avain-eilinen" }).status).toBe("fail");
  });

  it("blocks when the env file is missing entirely", () => {
    const check = checkJobBinding(job(), {});
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("puuttuu");
  });

  it("does not leak the stream key into the report", () => {
    const check = checkJobBinding(job(), { ...boundEnv(), RELAY_STREAM_KEY: "avain-eilinen" });
    expect(check.detail).not.toContain("avain-eilinen");
    expect(check.detail).not.toContain("avain-uusi");
  });

  it("does not call a not-yet-created broadcast a mismatch", () => {
    // A job without broadcasts has null links; the existing rows already say
    // what is missing, and a second red row would only add noise.
    const fresh = job({ sourceUrl: null, targetStreamKey: null });
    const check = checkJobBinding(fresh, { RELAY_MATCH_ID: "145918", RELAY_RTMP_URL: "rtmp://example.invalid/live2" });
    expect(check.status).toBe("ok");
  });

  it("does not block on a missing RTMP address — the relay defaults it", () => {
    // checkTarget already warns about this, and the value does not decide where
    // the broadcast goes. A blocker here would stop a start over nothing.
    const env = boundEnv();
    delete env.RELAY_RTMP_URL;
    expect(checkJobBinding(job(), env).status).toBe("ok");
  });

  it("names a duplicated key, because rewriting .env.relay cannot fix that", () => {
    // writeRelayEnv replaces the FIRST occurrence; parseEnvFile and systemd
    // both take the LAST. So a hand-edited duplicate makes the documented
    // remedy a no-op, and the scheduler would retry the same blocker forever.
    const check = checkJobBinding(job(), { ...boundEnv(), RELAY_MATCH_ID: "145905" }, ["RELAY_MATCH_ID"]);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("useammin kuin kerran");
  });

  it("finds duplicated keys in the raw file, ignoring comments", () => {
    const text = [
      "# RELAY_MATCH_ID=999999",
      "RELAY_MATCH_ID=145905",
      "RELAY_YOUTUBE_URL=https://example.invalid/a",
      "RELAY_MATCH_ID=145918",
    ].join("\n");
    expect(duplicateEnvKeys(text)).toEqual(["RELAY_MATCH_ID"]);
  });
});

/** #209: `.env.relay` on suojaamaton ajastimen käynnistysikkunassa — se
 *  kirjoitetaan, sitten ajetaan valmiustarkistus (~10 s), ja vasta sitten
 *  käynnistetään relay. Ikkunassa relay ei ole vielä aktiivinen, joten
 *  itsekorjauksen ehto täyttyi — ja PrepCard ajaa valmiustarkistuksen
 *  automaattisesti mountissa, joten riittää että ohjaamo avataan. Ajastimen
 *  oma sidontatarkistus on jo ajettu, joten #155:n suoja ei laukea. */
describe("milloin sidonnan saa korjata", () => {
  const base = { isSelectedJob: true, relayActive: false, schedulerStarting: false };

  it("korjaa operaattorin valitseman työn kun mikään ei ole ajossa", () => {
    expect(mayRepairBinding(base)).toBe(true);
  });

  it("ei korjaa työtä jota operaattori ei ole valinnut", () => {
    expect(mayRepairBinding({ ...base, isSelectedJob: false })).toBe(false);
  });

  it("ei korjaa ajossa olevan lähetyksen alta", () => {
    expect(mayRepairBinding({ ...base, relayActive: true })).toBe(false);
  });

  it("ei korjaa ajastimen käynnistysikkunassa", () => {
    expect(mayRepairBinding({ ...base, schedulerStarting: true })).toBe(false);
  });
});
