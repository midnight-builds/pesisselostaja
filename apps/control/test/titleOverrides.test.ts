/** Otsikon ohitusten validointi (#231).
 *
 *  Tämä on testi rajapinnan yli, ja se on olemassa nimenomaan siksi että
 *  selaintesti EI ylitä sitä rajaa: `test-ui/support/state.ts` fake-toteuttaa
 *  palvelimen, joten selaimesta katsottuna väärä avain menee aina läpi.
 *
 *  Vika, jota vastaan tämä on kirjoitettu, oli 6.8.2026 lähellä purra: #223
 *  nimesi `teamLabel`/`opponent` → `homeTeam`/`awayTeam`, ja jos vain toinen
 *  puoli olisi nimetty, mikään ei olisi huutanut. Kenttä olisi jäänyt hiljaa
 *  huomiotta ja otsikko syntynyt tulospalvelun raakanimillä — vika, joka näkyy
 *  vasta valmiissa YouTube-lähetyksessä, siinä vaiheessa kun linkki on jo
 *  jaettu. */

import { describe, expect, it } from "vitest";
import { TITLE_OVERRIDE_KEYS, validateTitleOverrides } from "../src/shared/api.js";

describe("kelvolliset ohitukset", () => {
  it("päästää läpi ne avaimet joita käyttöliittymä lähettää", () => {
    const result = validateTitleOverrides({
      homeTeam: "Pesä Ysit F-pojat",
      awayTeam: "IPV",
      shortVenue: "Naperoleiri Liperi",
    });
    expect(result).toEqual({
      ok: true,
      value: { homeTeam: "Pesä Ysit F-pojat", awayTeam: "IPV", shortVenue: "Naperoleiri Liperi" },
    });
  });

  /** Dokumentoitu varatie: ottelu voi olla listalla ilman kellonaikaa, jolloin
   *  tekstien muodostus kaatuu "alkuaika puuttuu" -virheeseen. Ilman näitä
   *  avaimia sitä ei voisi korjata mistään. */
  it("päästää läpi käsin annetun alkuajan", () => {
    expect(validateTitleOverrides({ localDate: "5.8.2026", localTime: "18:00" })).toMatchObject({ ok: true });
  });

  it("pitää puuttuvat ohitukset tyhjänä objektina", () => {
    expect(validateTitleOverrides(undefined)).toEqual({ ok: true, value: {} });
    expect(validateTitleOverrides(null)).toEqual({ ok: true, value: {} });
    expect(validateTitleOverrides({})).toEqual({ ok: true, value: {} });
  });

  /** Tyhjä kenttä on tyhjä kenttä, ei ohitus: läpi päästettynä otsikkoon
   *  jäisi joukkueen nimen paikalle tyhjä väli. */
  it("ohittaa tyhjän ja välilyönneistä koostuvan arvon", () => {
    expect(validateTitleOverrides({ homeTeam: "  ", awayTeam: "IPV" })).toEqual({
      ok: true,
      value: { awayTeam: "IPV" },
    });
  });

  it("siistii ympäröivät välilyönnit", () => {
    expect(validateTitleOverrides({ homeTeam: " IPV " })).toEqual({ ok: true, value: { homeTeam: "IPV" } });
  });
});

describe("torjutut ohitukset", () => {
  /** Juuri se tapaus, joka oli lähellä tapahtua #223:ssa. */
  it("torjuu uudelleennimeämisessä jälkeen jääneen vanhan avaimen", () => {
    const result = validateTitleOverrides({ teamLabel: "Pesä Ysit F-pojat", awayTeam: "IPV" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Virheilmoitus nimeää avaimen: sen kirjoittaja on toinen kehittäjä tai
      // curl, ei operaattori kentän laidalla.
      expect(result.error).toContain("teamLabel");
      expect(result.error).toContain("homeTeam");
    }
  });

  it("torjuu minkä tahansa tuntemattoman avaimen", () => {
    expect(validateTitleOverrides({ hashtags: ["#pesäpallo"] }).ok).toBe(false);
    expect(validateTitleOverrides({ playlistId: "PLjotain" }).ok).toBe(false);
  });

  it("torjuu väärän tyypin", () => {
    expect(validateTitleOverrides({ homeTeam: 42 }).ok).toBe(false);
    expect(validateTitleOverrides({ homeTeam: null }).ok).toBe(false);
    expect(validateTitleOverrides("Pesä Ysit").ok).toBe(false);
    expect(validateTitleOverrides(["Pesä Ysit"]).ok).toBe(false);
  });
});

/** Luettelo on sopimus, ei mukavuus: sen muuttaminen muuttaa sitä mitä
 *  palvelin ottaa vastaan, joten muutoksen pitää näkyä diffissä. */
it("luettelo on se, jonka molemmat puolet jakavat", () => {
  expect([...TITLE_OVERRIDE_KEYS]).toEqual(["homeTeam", "awayTeam", "shortVenue", "localDate", "localTime"]);
});
