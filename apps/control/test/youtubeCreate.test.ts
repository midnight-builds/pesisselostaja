// Lähetysparin LUONTI: ainoa peruuttamaton, ulospäin näkyvä teko koko
// ottelupäivässä. Nämä testit koskevat sitä yhtä kohtaa, jossa se voi mennä
// puoliksi läpi.
//
// #162 → #184 → #203 ovat sama vika kolmella syvyydellä: YouTube vastaa
// 200 OK:lla, mutta juuri luodun striimin tiedot eivät ole vielä
// replikoituneet. #184 teki puuttuvasta `items`-rivistä virheen; yhtä kenttää
// syvemmällä (`cdn.ingestionInfo`) sama viive tuotti yhä hiljaisen nullin, ja
// lopputulos oli pari ilman stream keytä — työ, jonka relayn preflight estää
// aina, ja josta kentällä ei ollut ulospääsyä.
//
// Verkko on mockattu kokonaan.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BroadcastTexts } from "../src/server/templates.js";

type GoogleAuth = typeof import("../src/server/googleAuth.js");
type YouTube = typeof import("../src/server/youtube.js");

let auth: GoogleAuth;
let yt: YouTube;

beforeAll(async () => {
  process.env.CONTROL_STATE_DIR = await mkdtemp(join(tmpdir(), "control-youtube-create-"));
  auth = await import("../src/server/googleAuth.js");
  yt = await import("../src/server/youtube.js");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Striimin tiedot sellaisina kuin YouTube ne antaa kun kaikki on valmista. */
function fullIngestion() {
  return {
    ingestionAddress: "rtmp://a.rtmp.youtube.com/live2",
    backupIngestionAddress: "rtmp://b.rtmp.youtube.com/live2?backup=1",
    streamName: "aaaa-bbbb-cccc-dddd",
  };
}

/** `liveStreams.list` palauttaa rivin, mutta sen sisältö vaihtelee kutsun
 *  mukaan — juuri se, mitä replikointiviive tekee. */
let streamListItem: Record<string, unknown> = { id: "STREAM-1", cdn: { ingestionInfo: fullIngestion() } };

function mockFetch(): void {
  let broadcastCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/device/code")) {
        return jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse(200, {
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: auth.SCOPES.join(" "),
        });
      }
      if (url.includes("youtube/v3/channels")) {
        return jsonResponse(200, { items: [{ id: "UC123", snippet: { title: "Kanava" } }] });
      }
      if (url.includes("youtube/v3/liveBroadcasts/bind")) {
        return jsonResponse(200, { id: "VIDEO" });
      }
      if (url.includes("youtube/v3/liveBroadcasts")) {
        broadcastCount += 1;
        return jsonResponse(200, { id: `VIDEO-${broadcastCount}` });
      }
      if (url.includes("youtube/v3/liveStreams")) {
        if (method === "POST") return jsonResponse(200, { id: "STREAM-1" });
        return jsonResponse(200, { items: [streamListItem] });
      }
      if (url.includes("youtube/v3/videos")) {
        return jsonResponse(200, { id: "VIDEO" });
      }
      throw new Error(`Mockkaamaton kutsu: ${url}`);
    })
  );
}

async function connect(): Promise<void> {
  await auth.startDeviceFlow();
  await auth.pollDeviceFlow();
}

function texts(): BroadcastTexts {
  return {
    title: "Ketut - Sudet",
    narratedTitle: "Ketut - Sudet (selostettu)",
    description: "kuvaus",
    shareMessage: "",
    playlistId: null,
    playlistName: null,
    ageGroup: null,
    localDate: "5.8.2026",
    localTime: "13:00",
    scheduledLocal: "ke 5.8.2026 klo 13:00",
    matchUrl: "https://www.pesistulokset.fi/ottelut/146210/",
    matchup: "Ketut - Sudet",
    ownTeam: "Ketut",
    opponentTeam: "Sudet",
    venue: "Kenttä",
    thumbnailHeadline: "Ketut - Sudet",
    thumbnailDatetime: "5.8. klo 13:00",
    thumbnailVenue: "Kenttä",
  };
}

function jobInput() {
  return { matchId: 146210, localDate: "5.8.2026", localTime: "13:00", venue: "Kenttä" };
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  delete process.env.GOOGLE_CLIENT_SECRET;
  streamListItem = { id: "STREAM-1", cdn: { ingestionInfo: fullIngestion() } };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await auth.disconnect();
});

describe("lähetysparin luonti", () => {
  it("palauttaa stream keyn kun YouTube on ehtinyt täyttää työntötiedot", async () => {
    mockFetch();
    await connect();

    const pair = await yt.createBroadcastPair(jobInput(), texts());

    expect(pair.narrated.streamKey).toBe("aaaa-bbbb-cccc-dddd");
    expect(pair.narrated.rtmpUrl).toBe("rtmp://a.rtmp.youtube.com/live2");
  });

  // #203: rivi on olemassa, mutta cdn.ingestionInfo puuttuu. Ennen korjausta
  // tästä tuli hiljainen null — ja sen kanssa työ, jonka relay kieltäytyy
  // käynnistämästä, ja kortti, joka ei enää tarjoa luontia.
  it("heittää kun striimin työntötiedot puuttuvat kokonaan", async () => {
    mockFetch();
    await connect();
    streamListItem = { id: "STREAM-1" };

    await expect(yt.createBroadcastPair(jobInput(), texts())).rejects.toThrow(/stream key jäi saamatta/);
  });

  it("heittää kun avain puuttuu vaikka osoite on paikallaan", async () => {
    mockFetch();
    await connect();
    streamListItem = {
      id: "STREAM-1",
      cdn: { ingestionInfo: { ingestionAddress: "rtmp://a.rtmp.youtube.com/live2" } },
    };

    await expect(yt.createBroadcastPair(jobInput(), texts())).rejects.toThrow(/stream key jäi saamatta/);
  });

  // #204: `createOne("normal")` ajetaan kokonaan ennen selostettua, ilman
  // transaktiota, ja `patchJob` vasta kun molemmat ovat valmiit. Jos
  // selostetun luonti kaatui, raakalähetys jäi kanavalle orvoksi eikä työhön
  // jäänyt siitä jälkeä — ja seuraava yritys loi TOISEN samannimisen. Kuvaaja
  // poimii raakalähetyksen kanavan lähetyslistasta, joten kaksi identtistä
  // riviä tarkoittaa että puolet ajasta valitaan orpo.
  it("poistaa juuri luodun raakalähetyksen kun selostetun luonti kaatuu", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch();
    await connect();
    const deleted: string[] = [];
    const inner = vi.mocked(fetch).getMockImplementation();
    let broadcastInserts = 0;
    vi.mocked(fetch).mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("youtube/v3/videos") && method === "DELETE") {
        deleted.push(new URL(url).searchParams.get("id") ?? "");
        return jsonResponse(204, {});
      }
      if (url.includes("youtube/v3/liveBroadcasts") && method === "POST" && !url.includes("bind")) {
        broadcastInserts += 1;
        // Selostettu on toinen luonti — se kaatuu.
        if (broadcastInserts === 2) return jsonResponse(500, { error: { message: "YouTube hikkasi" } });
      }
      return inner!(input as string, init);
    });

    await expect(yt.createBroadcastPair(jobInput(), texts())).rejects.toThrow();

    expect(deleted, "orpo raakalähetys ei jää kanavalle").toEqual(["VIDEO-1"]);
  });

  it("nimeää orvon lähetyksen kun senkään poisto ei onnistu", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch();
    await connect();
    const inner = vi.mocked(fetch).getMockImplementation();
    let broadcastInserts = 0;
    vi.mocked(fetch).mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("youtube/v3/videos") && method === "DELETE") {
        return jsonResponse(403, { error: { message: "ei oikeuksia" } });
      }
      if (url.includes("youtube/v3/liveBroadcasts") && method === "POST" && !url.includes("bind")) {
        broadcastInserts += 1;
        if (broadcastInserts === 2) return jsonResponse(500, { error: { message: "YouTube hikkasi" } });
      }
      return inner!(input as string, init);
    });

    // Kentällä seisovalle ihmiselle jää yksi asia tehtäväksi, ja sen on
    // näyttävä virheessä — ei lokissa.
    await expect(yt.createBroadcastPair(jobInput(), texts())).rejects.toThrow(/VIDEO-1.*jäi kanavalle/s);
  });

  it("heittää kun rivi puuttuu kokonaan (#184, ennallaan)", async () => {
    mockFetch();
    await connect();
    vi.mocked(fetch).mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("youtube/v3/liveStreams") && (init?.method ?? "GET") === "GET") {
        return jsonResponse(200, { items: [] });
      }
      if (url.includes("youtube/v3/liveStreams")) return jsonResponse(200, { id: "STREAM-1" });
      if (url.includes("youtube/v3/liveBroadcasts/bind")) return jsonResponse(200, { id: "VIDEO" });
      if (url.includes("youtube/v3/liveBroadcasts")) return jsonResponse(200, { id: "VIDEO-1" });
      if (url.includes("youtube/v3/videos")) return jsonResponse(200, { id: "VIDEO" });
      if (url.includes("youtube/v3/channels")) {
        return jsonResponse(200, { items: [{ id: "UC123", snippet: { title: "Kanava" } }] });
      }
      throw new Error(`Mockkaamaton kutsu: ${url}`);
    });

    await expect(yt.createBroadcastPair(jobInput(), texts())).rejects.toThrow(/stream key jäi saamatta/);
  });
});
