/** The control side of the relay's telemetry (issue #97).
 *
 *  These tests exist because the reader has to survive files that are being
 *  written to WHILE it reads them, by a relay whose code may be older than
 *  this one — a half-written last line, a multi-byte character split across a
 *  read, a restart that starts clip ids over at c1. Every one of those is a
 *  normal moment in a live broadcast, not an edge case.
 *
 *  Fictional names only (CLAUDE.md fixtures rule). */

import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { END_REASONS, NarrationTimeline, parseRelayStatus, SOURCE_STATES } from "../src/server/telemetry.js";
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pesis-telemetry-"));
  path = join(dir, "timeline-1.ndjson");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(...records: unknown[]): void {
  appendFileSync(path, records.map((r) => JSON.stringify(r) + "\n").join(""));
}

function detected(id: string, at: string, text: string) {
  return { at, kind: "detected", id, text };
}

function spoken(id: string, at: string, text: string, muted = false) {
  return { at, kind: "spoken", id, text, muted };
}

function timeline(keep?: number): NarrationTimeline {
  return new NarrationTimeline(1, { path, keep });
}

describe("NarrationTimeline", () => {
  it("a missing file is a relay that hasn't started, not a failure", async () => {
    const reader = timeline();
    await reader.poll();
    expect(reader.lines()).toEqual([]);
  });

  it("pairs spoken with detected instead of showing the clip twice", async () => {
    write(
      detected("c1", "2026-07-29T05:00:00.000Z", "Toinen palo."),
      spoken("c1", "2026-07-29T05:00:04.000Z", "Toinen palo.")
    );
    const reader = timeline();
    await reader.poll();

    expect(reader.lines()).toEqual([
      {
        id: "1:c1",
        detectedAt: "2026-07-29T05:00:00.000Z",
        spokenAt: "2026-07-29T05:00:04.000Z",
        muted: false,
        text: "Toinen palo.",
      },
    ]);
  });

  it("carries the muted flag through — a clip nobody heard must not read as spoken", async () => {
    write(
      detected("c1", "2026-07-29T05:00:00.000Z", "Juoksu!"),
      spoken("c1", "2026-07-29T05:00:00.000Z", "Juoksu!", true)
    );
    const reader = timeline();
    await reader.poll();
    expect(reader.lines()[0].muted).toBe(true);
  });

  it("shows a detected clip before it is spoken — the list is two-phase on purpose", async () => {
    write(detected("c1", "2026-07-29T05:00:00.000Z", "Vuorossa Virtanen."));
    const reader = timeline();
    await reader.poll();
    expect(reader.lines()[0].spokenAt).toBeNull();

    write(spoken("c1", "2026-07-29T05:00:04.000Z", "Vuorossa Virtanen."));
    await reader.poll();
    expect(reader.lines()[0].spokenAt).toBe("2026-07-29T05:00:04.000Z");
    expect(reader.lines()).toHaveLength(1);
  });

  it("reads only what was appended since the last poll", async () => {
    write(detected("c1", "2026-07-29T05:00:00.000Z", "Eka."));
    const reader = timeline();
    await reader.poll();
    write(detected("c2", "2026-07-29T05:00:10.000Z", "Toka."));
    await reader.poll();

    expect(reader.lines().map((l) => l.text)).toEqual(["Eka.", "Toka."]);
    expect(reader.lines().map((l) => l.id)).toEqual(["1:c1", "2:c2"]);
  });

  it("waits for a half-written final line instead of dropping it", async () => {
    const record = JSON.stringify(detected("c1", "2026-07-29T05:00:00.000Z", "Kolmas palo."));
    appendFileSync(path, record.slice(0, 20));
    const reader = timeline();
    await reader.poll();
    expect(reader.lines()).toEqual([]);

    appendFileSync(path, record.slice(20) + "\n");
    await reader.poll();
    expect(reader.lines().map((l) => l.text)).toEqual(["Kolmas palo."]);
  });

  it("survives a multi-byte character split across two reads — Finnish narration is full of them", async () => {
    const record = Buffer.from(
      JSON.stringify(detected("c1", "2026-07-29T05:00:00.000Z", "Pesä ja hyvä lyönti.")) + "\n",
      "utf8"
    );
    // Cut inside the two bytes of "ä" in "Pesä".
    const cut = record.indexOf(Buffer.from("ä", "utf8")) + 1;
    appendFileSync(path, record.subarray(0, cut));
    const reader = timeline();
    await reader.poll();

    appendFileSync(path, record.subarray(cut));
    await reader.poll();
    expect(reader.lines().map((l) => l.text)).toEqual(["Pesä ja hyvä lyönti."]);
  });

  it("ignores log and synthesized records — the log view has its own source", async () => {
    write(
      { at: "2026-07-29T05:00:00.000Z", kind: "log", level: "info", code: "relay.start", msg: "Alkaa" },
      detected("c1", "2026-07-29T05:00:01.000Z", "Juoksu!"),
      { at: "2026-07-29T05:00:02.000Z", kind: "synthesized", id: "c1", text: "Juoksu!", engine: "piper", ms: 900 }
    );
    const reader = timeline();
    await reader.poll();
    expect(reader.lines()).toHaveLength(1);
    expect(reader.lines()[0].spokenAt).toBeNull();
  });

  it("one malformed line costs one record, not the rest of the file", async () => {
    write(detected("c1", "2026-07-29T05:00:00.000Z", "Eka."));
    appendFileSync(path, "{ ei tämä JSONia ole\n");
    write(detected("c2", "2026-07-29T05:00:10.000Z", "Toka."));
    const reader = timeline();
    await reader.poll();
    expect(reader.lines().map((l) => l.text)).toEqual(["Eka.", "Toka."]);
  });

  // The relay appends to the same file across restarts and starts its clip
  // counter over at c1, so ids alone are not unique within a match.
  it("keeps restarted clip ids apart, and pairs a later spoken with the later clip", async () => {
    write(
      detected("c1", "2026-07-29T05:00:00.000Z", "Ennen uudelleenkäynnistystä."),
      spoken("c1", "2026-07-29T05:00:04.000Z", "Ennen uudelleenkäynnistystä."),
      detected("c1", "2026-07-29T05:10:00.000Z", "Uudelleenkäynnistyksen jälkeen."),
      spoken("c1", "2026-07-29T05:10:04.000Z", "Uudelleenkäynnistyksen jälkeen.")
    );
    const reader = timeline();
    await reader.poll();

    const lines = reader.lines();
    expect(lines.map((l) => l.id)).toEqual(["1:c1", "2:c1"]);
    expect(lines[0].spokenAt).toBe("2026-07-29T05:00:04.000Z");
    expect(lines[1].spokenAt).toBe("2026-07-29T05:10:04.000Z");
  });

  it("starts over when the file is truncated rather than splicing two files together", async () => {
    write(detected("c1", "2026-07-29T05:00:00.000Z", "Vanha ajo."));
    const reader = timeline();
    await reader.poll();

    writeFileSync(path, "");
    write(detected("c1", "2026-07-29T06:00:00.000Z", "Uusi ajo."));
    await reader.poll();
    expect(reader.lines().map((l) => l.text)).toEqual(["Uusi ajo."]);
  });

  it("keeps only the tail — a two-hour match must not grow the SSE payload without bound", async () => {
    for (let i = 1; i <= 10; i++) {
      write(detected(`c${i}`, `2026-07-29T05:00:0${i % 10}.000Z`, `Rivi ${i}`));
    }
    const reader = timeline(3);
    await reader.poll();
    expect(reader.lines().map((l) => l.text)).toEqual(["Rivi 8", "Rivi 9", "Rivi 10"]);
  });

  it("hands out copies, so a caller cannot mutate the reader's state", async () => {
    write(detected("c1", "2026-07-29T05:00:00.000Z", "Juoksu!"));
    const reader = timeline();
    await reader.poll();
    reader.lines()[0].text = "sabotaasi";
    expect(reader.lines()[0].text).toBe("Juoksu!");
  });
});

describe("parseRelayStatus", () => {
  const full = {
    at: "2026-07-29T05:00:00.000Z",
    matchId: 145895,
    startedAt: "2026-07-29T04:30:00.000Z",
    uptimeSec: 1800,
    readerAttached: true,
    pendingClips: 2,
    respawns: 1,
    source: { state: "live", detail: "ffmpeg käynnissä" },
    match: { finished: false, eventCount: 412, lastEventAt: "2026-07-29T04:59:50.000Z", sourceLagMs: 12_000 },
    narration: { detected: 90, spoken: 88, muted: 1, queued: 1 },
    tts: { engine: "piper", elevenLabsCharsUsed: 0 },
    lastProblem: null,
    // #123: relay kertoo miksi se lopetti. Ajossa oleva relay ei ole
    // lopettanut, joten null on normaali arvo.
    endReason: null,
  };

  it("reads a full snapshot back verbatim", () => {
    expect(parseRelayStatus(JSON.stringify(full))).toEqual(full);
  });

  it("lukee puuttuvan viivemittauksen nulliksi eikä nollaksi (#120)", () => {
    // Vanhempi deploy ei julkaise kenttää lainkaan, ja `created` on muutenkin
    // valinnainen. Nolla väittäisi ettei viivettä ole — juuri se sekaannus,
    // jonka takia mittaus ylipäätään lisättiin.
    const { sourceLagMs, ...matchWithout } = full.match;
    void sourceLagMs;
    const parsed = parseRelayStatus(JSON.stringify({ ...full, match: matchWithout }));
    expect(parsed?.match.sourceLagMs).toBeNull();
  });

  it("a snapshot with no usable timestamp is refused — an undateable snapshot cannot be judged stale", () => {
    expect(parseRelayStatus(JSON.stringify({ ...full, at: "eilen" }))).toBeNull();
    expect(parseRelayStatus(JSON.stringify({ ...full, at: undefined }))).toBeNull();
  });

  // A deploy older or newer than this build writes a different shape; the view
  // must render rather than crash, and must not invent an attached reader.
  it("fills missing fields conservatively instead of trusting a partial snapshot", () => {
    const status = parseRelayStatus(JSON.stringify({ at: full.at }));
    expect(status).not.toBeNull();
    expect(status?.readerAttached).toBe(false);
    expect(status?.source.state).toBe("unknown");
    expect(status?.narration).toEqual({ detected: 0, spoken: 0, muted: 0, queued: 0 });
  });

  it("an unknown source state degrades to unknown rather than being shown as live", () => {
    const status = parseRelayStatus(JSON.stringify({ ...full, source: { state: "kaikki_hyvin" } }));
    expect(status?.source.state).toBe("unknown");
  });

  // Sopimustesti (#117): jäsennin ei saa pakottaa yhtäkään unionin arvoa
  // "unknown"iksi. Kattavuuden (lista == unioni, molempiin suuntiin) vartioi
  // telemetry.ts:n Record-tyyppinen SOURCE_STATE_SET jo käännösaikana; tämä
  // varmistaa että jäsennin oikeasti päästää jokaisen arvon läpi.
  it.each(SOURCE_STATES)("preserves source state %j verbatim", (state) => {
    const status = parseRelayStatus(JSON.stringify({ ...full, source: { state } }));
    expect(status?.source.state).toBe(state);
  });

  // Sama sopimus endReasonille (#123). Kattavuuden vartioi END_REASON_SET
  // käännösaikana; tämä varmistaa että jokainen arvo myös läpäisee jäsentimen.
  it.each(END_REASONS)("preserves end reason %j verbatim", (reason) => {
    const status = parseRelayStatus(JSON.stringify({ ...full, endReason: reason }));
    expect(status?.endReason).toBe(reason);
  });

  it("an unknown end reason degrades to null instead of taking down the snapshot", () => {
    const status = parseRelayStatus(JSON.stringify({ ...full, endReason: "tuntematon_syy" }));
    expect(status).not.toBeNull();
    expect(status?.endReason).toBeNull();
  });

  it("a missing end reason is null — an old deploy simply does not report it", () => {
    const status = parseRelayStatus(JSON.stringify({ at: full.at }));
    expect(status?.endReason).toBeNull();
  });
});
