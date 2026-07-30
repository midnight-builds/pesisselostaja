import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadPairThumbnails } from "../src/server/broadcastThumbnails.js";
import type { BroadcastPair } from "../src/server/youtube.js";
import type { BroadcastTexts } from "../src/server/templates.js";
import type { ThumbnailOptions } from "../src/server/thumbnail.js";

/** Issue #130: ajastetut lähetykset jäivät ilman thumbnailia, vaikka
 *  renderöijä, latausfunktio ja reitti olivat kaikki olemassa — luontipolku ei
 *  vain kutsunut niitä. Nämä testit kattavat sekä kutsumisen että sen, mitä
 *  tapahtuu kun kutsu epäonnistuu. */

const PAIR = {
  normal: { videoId: "vid-normal" },
  narrated: { videoId: "vid-narrated" },
} as unknown as BroadcastPair;

const TEXTS = {
  thumbnailHeadline: "Pesä Ysit - LaJy",
  thumbnailDatetime: "30.7.2026 klo 12:30",
  thumbnailVenue: "Viinijärvi",
} as unknown as BroadcastTexts;

beforeEach(() => {
  // uploadPairThumbnails lokittaa epäonnistumisen; testin ei tarvitse nähdä sitä.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("uploadPairThumbnails (#130)", () => {
  it("renderöi ja lataa molemmille lähetyksille, selostetulle narrated-lipulla", async () => {
    const render = vi.fn(async (_opts: ThumbnailOptions) => Buffer.from("png"));
    const upload = vi.fn(async (_videoId: string, _image: Buffer, _type: string) => ({}));

    const out = await uploadPairThumbnails(PAIR, TEXTS, { render, upload });

    expect(out).toEqual({ normal: { ok: true }, narrated: { ok: true } });
    // Sama teksti kummallekin — vain narrated eroaa, koska juuri se erottaa
    // esikatselun kaksi kuvaa toisistaan.
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[0]![0]).toMatchObject({
      headline: "Pesä Ysit - LaJy",
      datetime: "30.7.2026 klo 12:30",
      venue: "Viinijärvi",
      narrated: false,
    });
    expect(render.mock.calls[1]![0]).toMatchObject({ narrated: true });
    expect(upload.mock.calls.map((c) => c[0])).toEqual(["vid-normal", "vid-narrated"]);
  });

  it("ei heitä kun renderöinti epäonnistuu — ja yrittää toisen silti", async () => {
    // Tämä on moduulin koko olemassaolon syy. Lähetykset ovat jo YouTubessa
    // kun tätä kutsutaan: heitetty poikkeus näyttäisi operaattorille punaisen
    // virheen onnistuneesta luonnista, ja seuraava klikkaus loisi TOISEN parin
    // (niin kävi ottelulle 145905 30.7.2026).
    const render = vi.fn(async (opts: ThumbnailOptions) => {
      if (!opts.narrated) throw new Error("komposiitti kaatui");
      return Buffer.from("png");
    });
    const upload = vi.fn(async (_videoId: string, _image: Buffer, _type: string) => ({}));

    const out = await uploadPairThumbnails(PAIR, TEXTS, { render, upload });

    expect(out.normal).toEqual({ ok: false, error: "komposiitti kaatui" });
    expect(out.narrated).toEqual({ ok: true });
    // Puolikas on parempi kuin ei mitään: toisen kaatuminen ei saa viedä toista.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toBe("vid-narrated");
  });

  it("ei heitä kun lataus epäonnistuu, ja kertoo kumpi kaatui", async () => {
    const render = vi.fn(async (_opts: ThumbnailOptions) => Buffer.from("png"));
    const upload = vi.fn(async (videoId: string, _image: Buffer, _type: string) => {
      if (videoId === "vid-narrated") throw new Error("HTTP 403 quotaExceeded");
      return {};
    });

    const out = await uploadPairThumbnails(PAIR, TEXTS, { render, upload });

    expect(out.normal).toEqual({ ok: true });
    expect(out.narrated).toEqual({ ok: false, error: "HTTP 403 quotaExceeded" });
  });

  it("selviää myös siitä, että virhe ei ole Error-olio", async () => {
    const render = vi.fn(async () => {
      throw "räjähti";
    });
    const out = await uploadPairThumbnails(PAIR, TEXTS, { render, upload: vi.fn() });
    expect(out).toEqual({
      normal: { ok: false, error: "räjähti" },
      narrated: { ok: false, error: "räjähti" },
    });
  });
});
