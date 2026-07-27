import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchLiveEvents, formatHelsinkiTimestamp } from "../src/api.js";

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("formatHelsinkiTimestamp", () => {
  it("renders 'YYYY-MM-DD HH:mm:ss' in Europe/Helsinki (EEST in July = UTC+3)", () => {
    expect(formatHelsinkiTimestamp(new Date("2026-07-16T09:35:00Z"))).toBe("2026-07-16 12:35:00");
  });

  it("handles winter time too (EET = UTC+2)", () => {
    expect(formatHelsinkiTimestamp(new Date("2026-01-10T09:35:00Z"))).toBe("2026-01-10 11:35:00");
  });
});

describe("fetchLiveEvents delta options", () => {
  it("encodes the after timestamp's space as %20, never '+' (the API 400s on wrong formats)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLiveEvents(123, { after: "2026-07-16 09:35:00", skipDelay: true });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("after=2026-07-16%2009%3A35%3A00");
    expect(url).not.toContain("+");
    expect(url).toContain("skip-delay=true");
  });

  it("sends If-None-Match and reports a 304 as notModified with the same etag", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 304,
          headers: { date: "Fri, 17 Jul 2026 01:00:26 GMT" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchLiveEvents(123, { etag: 'W/"abc"' });
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)["If-None-Match"]).toBe('W/"abc"');
    expect(res.notModified).toBe(true);
    expect(res.events).toEqual([]);
    expect(res.etag).toBe('W/"abc"');
    expect(res.serverDateMs).toBe(Date.parse("Fri, 17 Jul 2026 01:00:26 GMT"));
  });

  it("returns the response etag, Date header, and reset flag on a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { events: [], reset: true },
          { etag: 'W/"fresh"', date: "Fri, 17 Jul 2026 01:00:26 GMT" }
        )
      )
    );

    const res = await fetchLiveEvents(123, {});
    expect(res.notModified).toBe(false);
    expect(res.etag).toBe('W/"fresh"');
    expect(res.reset).toBe(true);
    expect(res.serverDateMs).toBe(Date.parse("Fri, 17 Jul 2026 01:00:26 GMT"));
  });

  it("normalizes a bare [] body (match never opened by the scorer) into an empty events list", async () => {
    // Seen live 2026-07-17 (144743 pre-open): the endpoint answers `[]`
    // instead of {"events": [...]}, which used to crash the startup fetch.
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchLiveEvents(144743, { skipDelay: true });
    expect(res.events).toEqual([]);
    expect(res.notModified).toBe(false);
  });

  it("stays backward compatible: no new options → plain URL, plain events out", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ events: [], period: 1, team: 7 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchLiveEvents(456, {});
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/\/online\/456\/events$/);
    expect(res.period).toBe(1);
    expect(res.team).toBe(7);
  });
});
