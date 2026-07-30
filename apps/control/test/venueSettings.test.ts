import { describe, it, expect } from "vitest";
import {
  DEFAULT_VENUE_SETTINGS,
  normalizeVenueSettings,
} from "../src/server/venueSettings.js";

/** Kenttänimen siivousasetukset (#132), joita Asetukset-sivu kirjoittaa (#133).
 *
 *  Normalisointi on koko turvaverkko: tiedosto on operaattorin käsin
 *  muokattavissa, ja Asetukset-sivu kirjoittaa sen käyttöliittymästä. Väärin
 *  tulkittu arvo ei kaadu mihinkään — se vain vaihtaa hiljaa katsojille
 *  näkyvän otsikon muotoa, mikä on paljon vaikeampi huomata kuin virhe. */

describe("normalizeVenueSettings (#132, #133)", () => {
  it("oletuksena molemmat säännöt päällä", () => {
    // Oletus on se, mikä on oikein katsojalle: 30.7.2026 luotujen lähetysten
    // otsikoissa luki "01 - Viinijärven pallokenttä, tekonurmi 1|".
    expect(DEFAULT_VENUE_SETTINGS).toEqual({ stripFieldNumber: true, stripQualifier: true });
    expect(normalizeVenueSettings({})).toEqual(DEFAULT_VENUE_SETTINGS);
    expect(normalizeVenueSettings(null)).toEqual(DEFAULT_VENUE_SETTINGS);
    expect(normalizeVenueSettings(undefined)).toEqual(DEFAULT_VENUE_SETTINGS);
  });

  it("vain kirjaimellinen false sammuttaa säännön", () => {
    expect(normalizeVenueSettings({ stripFieldNumber: false })).toEqual({
      stripFieldNumber: false,
      stripQualifier: true,
    });
    expect(normalizeVenueSettings({ stripQualifier: false })).toEqual({
      stripFieldNumber: true,
      stripQualifier: false,
    });
    expect(normalizeVenueSettings({ stripFieldNumber: false, stripQualifier: false })).toEqual({
      stripFieldNumber: false,
      stripQualifier: false,
    });
  });

  it("merkkijono \"false\" tai roska tarkoittaa oletusta, ei poiskytkentää", () => {
    // Käsin muokattu tiedosto on tämän asetuksen tarkoitettu hätäpolku, ja
    // JSONissa lainausmerkit unohtuvat helposti. Hiljainen poiskytkentä
    // näkyisi vasta katsojalle päätyneessä otsikossa.
    expect(normalizeVenueSettings({ stripFieldNumber: "false" })).toEqual(DEFAULT_VENUE_SETTINGS);
    expect(normalizeVenueSettings({ stripQualifier: 0 })).toEqual(DEFAULT_VENUE_SETTINGS);
    expect(normalizeVenueSettings({ stripQualifier: "ei" })).toEqual(DEFAULT_VENUE_SETTINGS);
    expect(normalizeVenueSettings("roskaa")).toEqual(DEFAULT_VENUE_SETTINGS);
    expect(normalizeVenueSettings([1, 2, 3])).toEqual(DEFAULT_VENUE_SETTINGS);
  });

  it("tuntemattomat avaimet eivät päädy tulokseen", () => {
    // Vastaus on sitova sopimus clientille; ylimääräinen avain vanhasta
    // tiedostoversiosta ei saa vuotaa läpi.
    expect(normalizeVenueSettings({ stripFieldNumber: true, vanhaAvain: "x" })).toEqual(
      DEFAULT_VENUE_SETTINGS,
    );
  });
});
