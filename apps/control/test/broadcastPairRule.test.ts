/** "Onko työllä lähetyspari" on YKSI sääntö, jota lukee kaksi puolta:
 *  `PrepCard` päättää siitä näkyykö luontipainike (#203), ja
 *  `POST /api/youtube/broadcasts` päättää siitä syntyykö toinen pari (#204).
 *
 *  Kaksi eri rajaa tuottaisi juuri sen umpikujan, jota molemmat issuet
 *  kuvaavat: kortti tarjoaa luontia jonka palvelin torjuu, tai kortti piilottaa
 *  luonnin työltä jolla ei ole toimivaa paria. Siksi sääntö asuu
 *  `shared/`:ssa ja on testattu erikseen. */

import { describe, expect, it } from "vitest";
import { hasBroadcastPair } from "../src/shared/jobState.js";

describe("onko työllä lähetyspari", () => {
  it("video ja avain: pari on olemassa", () => {
    expect(hasBroadcastPair({ targetVideoId: "VIDEO", targetStreamKey: "avain" })).toBe(true);
  });

  // #203: tämä oli se hiljainen null. Pelkkä videoId luki "pari on olemassa",
  // ja luontipainike katosi työltä jota relay ei voi käynnistää.
  it("video ilman avainta EI ole pari", () => {
    expect(hasBroadcastPair({ targetVideoId: "VIDEO", targetStreamKey: null })).toBe(false);
  });

  it("avain ilman videota EI ole pari", () => {
    expect(hasBroadcastPair({ targetVideoId: null, targetStreamKey: "avain" })).toBe(false);
  });

  it("tyhjä työ ei ole pari", () => {
    expect(hasBroadcastPair({ targetVideoId: null, targetStreamKey: null })).toBe(false);
  });
});
