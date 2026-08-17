import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ELEVENLABS_DEFAULT_VOICE_ID,
  elevenLabsSynthesize,
  resolveElevenLabsVoiceId,
} from "../src/elevenlabs.js";

/** Issue #63: web-puolen ElevenLabs-ääni oli kovakoodattu vakio, joten äänen
 *  vaihtaminen vaati src-muokkauksen, buildin ja palvelun restartin. Ääni on
 *  nyt asetus (localStorage) — nämä testit varmistavat, että asetus todella
 *  päätyy pyyntöön ja että tyhjä asetus tarkoittaa oletusta. */

const okResponse = () => ({ ok: true, blob: async () => new Blob(["x"]) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveElevenLabsVoiceId (#63)", () => {
  it("tyhjä asetus tarkoittaa oletusääntä", () => {
    // Kentän tyhjentäminen ei saa jättää selostusta ilman ääntä; oletus on
    // aina toimiva paluutila.
    expect(resolveElevenLabsVoiceId("")).toBe(ELEVENLABS_DEFAULT_VOICE_ID);
    expect(resolveElevenLabsVoiceId(undefined)).toBe(ELEVENLABS_DEFAULT_VOICE_ID);
    expect(resolveElevenLabsVoiceId(null)).toBe(ELEVENLABS_DEFAULT_VOICE_ID);
  });

  it("pelkkä tyhjämerkki on sama kuin tyhjä", () => {
    // Kopioi-liitä ID:stä jää helposti välilyönti; se ei saa tuottaa
    // 404:ää ElevenLabsilta vaan käyttäytyä kuin tyhjä kenttä.
    expect(resolveElevenLabsVoiceId("   ")).toBe(ELEVENLABS_DEFAULT_VOICE_ID);
  });

  it("annettu ID voittaa oletuksen ja siistitään", () => {
    expect(resolveElevenLabsVoiceId("abc123")).toBe("abc123");
    expect(resolveElevenLabsVoiceId("  abc123  ")).toBe("abc123");
  });

  it("oletus on Daniel — tuotantoääntä ei vaihdettu tässä muutoksessa", () => {
    // Vahti: äänen vaihtaminen on kuuntelupäätös (vrt. PR #26), ei sivuvaikutus
    // asetuksen lisäämisestä.
    expect(ELEVENLABS_DEFAULT_VOICE_ID).toBe("onwK4e9ZLuTAKqWW03F9");
  });
});

describe("elevenLabsSynthesize käyttää asetettua ääntä (#63)", () => {
  it("kutsuu asetuksen ääni-ID:llä", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await elevenLabsSynthesize("Juoksu", "sk_test", "oma-aani-id");

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/text-to-speech/oma-aani-id?");
    expect(url).not.toContain(ELEVENLABS_DEFAULT_VOICE_ID);
  });

  it("ilman asetusta kutsuu oletusäänellä", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await elevenLabsSynthesize("Juoksu", "sk_test", "");

    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      `/text-to-speech/${ELEVENLABS_DEFAULT_VOICE_ID}?`,
    );
  });

  it("koodaa ID:n URLiin — roskasyöte ei riko polkua", async () => {
    // Käyttäjä liittää kentän itse, joten se voi sisältää mitä tahansa. Ilman
    // koodausta esim. "/" muuttaisi pyynnön osoitetta.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await elevenLabsSynthesize("Juoksu", "sk_test", "a/b?c");

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/text-to-speech/a%2Fb%3Fc?");
  });
});
