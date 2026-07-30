// youtube.ts:n LUKEVAT kutsut: yhden videon haku id:llä ja striimin tila.
// Nämä ovat lähteen tilan valvonnan koko rajapinta YouTubeen, ja ne ajetaan
// toistuvasti ottelun aikana — siksi on olennaista että
//
//  1. id-haku lähettää id:n EIKÄ broadcastStatusia (YouTube hylkää pyynnön,
//     jos molemmat suodattimet ovat mukana),
//  2. tyhjä tulos on normaali vastaus eikä virhe (video toisella kanavalla),
//  3. sisäkkäinen healthStatus.status poimitaan oikein — se on objekti, ei
//     merkkijono.
//
// Verkko on mockattu kokonaan; yksikään testi ei tee kirjoittavaa kutsua.
// Levylle kirjoittavat osat (token, kiintiölaskuri) ohjataan
// väliaikaishakemistoon ennen moduulien latausta.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GoogleAuth = typeof import("../src/server/googleAuth.js");
type YouTube = typeof import("../src/server/youtube.js");

let auth: GoogleAuth;
let yt: YouTube;

beforeAll(async () => {
  process.env.CONTROL_STATE_DIR = await mkdtemp(join(tmpdir(), "control-youtube-"));
  auth = await import("../src/server/googleAuth.js");
  yt = await import("../src/server/youtube.js");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface MockRoutes {
  liveBroadcasts?: () => Response;
  liveStreams?: () => Response;
}

/** Reititys osoitteen perusteella, jotta testi voi vaihtaa vain sen
 *  vastauksen josta se on kiinnostunut. Mockkaamaton osoite heittää — muuten
 *  testi voisi vahingossa mennä oikeaan verkkoon. */
function mockFetch(routes: MockRoutes): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
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
      if (url.includes("youtube/v3/liveBroadcasts")) {
        return routes.liveBroadcasts?.() ?? jsonResponse(500, { error: "odottamaton liveBroadcasts-kutsu" });
      }
      if (url.includes("youtube/v3/liveStreams")) {
        return routes.liveStreams?.() ?? jsonResponse(500, { error: "odottamaton liveStreams-kutsu" });
      }
      throw new Error(`Mockkaamaton kutsu: ${url}`);
    })
  );
}

/** Kirjautuu laitevirralla sisään, jotta getAccessToken löytää tokenin. */
async function connect(): Promise<void> {
  await auth.startDeviceFlow();
  await auth.pollDeviceFlow();
}

/** Viimeisimmän YouTube-kutsun query-parametrit tarkistettavaksi. */
function lastYouTubeParams(match: string): URLSearchParams {
  const calls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
  const url = [...calls].reverse().find((candidate) => candidate.includes(match));
  if (!url) throw new Error(`Yhtään ${match}-kutsua ei tehty.`);
  return new URL(url).searchParams;
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  delete process.env.GOOGLE_CLIENT_SECRET;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await auth.disconnect();
});

describe("listBroadcasts id-suodattimella", () => {
  it("lähettää id:n eikä broadcastStatusia — ne sulkevat toisensa pois", async () => {
    mockFetch({ liveBroadcasts: () => jsonResponse(200, { items: [] }) });
    await connect();

    await yt.listBroadcasts({ id: "dQw4w9WgXcQ" });

    const params = lastYouTubeParams("liveBroadcasts");
    expect(params.get("id")).toBe("dQw4w9WgXcQ");
    expect(params.get("broadcastStatus")).toBeNull();
    expect(params.get("broadcastType")).toBeNull();
    // part pysyy samana, jotta boundStreamId ja lifeCycleStatus tulevat mukana.
    expect(params.get("part")).toBe("id,snippet,status,contentDetails");
  });

  it("ilman id:tä listaus toimii ennallaan broadcastStatusilla", async () => {
    mockFetch({ liveBroadcasts: () => jsonResponse(200, { items: [] }) });
    await connect();

    await yt.listBroadcasts({ status: "active" });

    const params = lastYouTubeParams("liveBroadcasts");
    expect(params.get("broadcastStatus")).toBe("active");
    expect(params.get("broadcastType")).toBe("all");
    expect(params.get("id")).toBeNull();
  });

  it("poimii boundStreamId:n ja lifeCycleStatuksen samalla mapilla", async () => {
    mockFetch({
      liveBroadcasts: () =>
        jsonResponse(200, {
          items: [
            {
              id: "dQw4w9WgXcQ",
              snippet: {
                title: "Selostettu: Kotijoukkue - Vierasjoukkue",
                scheduledStartTime: "2026-07-29T15:00:00Z",
                actualStartTime: "2026-07-29T15:02:11Z",
              },
              status: { lifeCycleStatus: "live", privacyStatus: "unlisted" },
              contentDetails: { boundStreamId: "STREAM-1" },
            },
          ],
        }),
    });
    await connect();

    const [broadcast] = await yt.listBroadcasts({ id: "dQw4w9WgXcQ" });
    expect(broadcast).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "Selostettu: Kotijoukkue - Vierasjoukkue",
      watchUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      scheduledStartTime: "2026-07-29T15:00:00Z",
      actualStartTime: "2026-07-29T15:02:11Z",
      lifeCycleStatus: "live",
      privacyStatus: "unlisted",
      boundStreamId: "STREAM-1",
    });
  });

  it("tyhjä items on normaali vastaus (video ei ole omalla kanavalla), ei virhe", async () => {
    mockFetch({ liveBroadcasts: () => jsonResponse(200, {}) });
    await connect();

    await expect(yt.listBroadcasts({ id: "dQw4w9WgXcQ" })).resolves.toEqual([]);
  });

  it("HTTP-virhe nousee YouTubeApiErrorina", async () => {
    mockFetch({ liveBroadcasts: () => jsonResponse(403, { error: { message: "quotaExceeded" } }) });
    await connect();

    await expect(yt.listBroadcasts({ id: "dQw4w9WgXcQ" })).rejects.toBeInstanceOf(yt.YouTubeApiError);
  });

  it("kirjaa id-haun kiintiöön yhtenä yksikkönä", async () => {
    mockFetch({ liveBroadcasts: () => jsonResponse(200, { items: [] }) });
    await connect();

    const before = (await auth.getQuota()).units;
    await yt.listBroadcasts({ id: "dQw4w9WgXcQ" });
    expect((await auth.getQuota()).units).toBe(before + auth.QUOTA_COST.list);
  });
});

describe("getStreamStatus", () => {
  it("poimii streamStatuksen ja sisäkkäisen healthStatus.statuksen", async () => {
    mockFetch({
      liveStreams: () =>
        jsonResponse(200, {
          items: [
            {
              id: "STREAM-1",
              status: {
                streamStatus: "active",
                healthStatus: { status: "good", lastUpdateTimeSeconds: "1", configurationIssues: [] },
              },
            },
          ],
        }),
    });
    await connect();

    await expect(yt.getStreamStatus("STREAM-1")).resolves.toEqual({
      streamId: "STREAM-1",
      streamStatus: "active",
      healthStatus: "good",
    });

    const params = lastYouTubeParams("liveStreams");
    expect(params.get("id")).toBe("STREAM-1");
    expect(params.get("part")).toBe("status");
  });

  it("säilyttää YouTuben raa'an arvon — vain active tarkoittaa että dataa tulee", async () => {
    mockFetch({
      liveStreams: () =>
        jsonResponse(200, {
          items: [{ id: "STREAM-1", status: { streamStatus: "inactive", healthStatus: { status: "noData" } } }],
        }),
    });
    await connect();

    await expect(yt.getStreamStatus("STREAM-1")).resolves.toEqual({
      streamId: "STREAM-1",
      streamStatus: "inactive",
      healthStatus: "noData",
    });
  });

  it("puuttuva status-objekti antaa nullit, ei kaadu", async () => {
    mockFetch({ liveStreams: () => jsonResponse(200, { items: [{ id: "STREAM-1" }] }) });
    await connect();

    await expect(yt.getStreamStatus("STREAM-1")).resolves.toEqual({
      streamId: "STREAM-1",
      streamStatus: null,
      healthStatus: null,
    });
  });

  it("tuntematon striimi on null, ei virhe", async () => {
    mockFetch({ liveStreams: () => jsonResponse(200, { items: [] }) });
    await connect();

    await expect(yt.getStreamStatus("POISTETTU")).resolves.toBeNull();
  });

  it("HTTP-virhe nousee YouTubeApiErrorina", async () => {
    mockFetch({ liveStreams: () => jsonResponse(404, { error: { message: "notFound" } }) });
    await connect();

    await expect(yt.getStreamStatus("STREAM-1")).rejects.toBeInstanceOf(yt.YouTubeApiError);
  });
});
