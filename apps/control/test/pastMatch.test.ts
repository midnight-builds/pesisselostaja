import { describe, it, expect } from "vitest";
import { isPastMatch, PAST_MATCH_GRACE_MS } from "../src/client/format.js";

/** Issue #128: Ottelut-lista näytti leiripäivänä kaikki ~200 ottelua, myös jo
 *  pelatut, ja ajastettava hukkui joukkoon. Raja on karkea tarkoituksella —
 *  siksi sen reunat kannattaa naulata testillä. */

// Suomen kesäaika on +03:00, ja tulospalvelun startsAt kantaa sen mukanaan.
const KICKOFF = "2026-07-30T12:30:00+03:00";
const kickoffMs = Date.parse(KICKOFF);

describe("isPastMatch (#128)", () => {
  it("tuleva ottelu ei ole mennyt", () => {
    expect(isPastMatch(KICKOFF, kickoffMs - 5 * 60_000)).toBe(false);
  });

  it("juuri alkanut ei ole mennyt", () => {
    expect(isPastMatch(KICKOFF, kickoffMs + 60_000)).toBe(false);
  });

  it("tasan armonajan päässä ei ole vielä mennyt, sekuntia myöhemmin on", () => {
    expect(isPastMatch(KICKOFF, kickoffMs + PAST_MATCH_GRACE_MS)).toBe(false);
    expect(isPastMatch(KICKOFF, kickoffMs + PAST_MATCH_GRACE_MS + 1000)).toBe(true);
  });

  it("tunnistaa vyöhykkeen eikä lue aikaa paikallisena", () => {
    // Palvelin on UTC:ssä. Jos +03:00 jätettäisiin huomiotta, tämä ottelu
    // näyttäisi alkaneen kolme tuntia myöhemmin ja jäisi listalle liian pitkäksi
    // aikaa — tai päinvastoin piiloutuisi ennen aikojaan.
    expect(Date.parse(KICKOFF)).toBe(Date.parse("2026-07-30T09:30:00Z"));
    expect(isPastMatch(KICKOFF, Date.parse("2026-07-30T10:31:00Z"))).toBe(true);
    expect(isPastMatch(KICKOFF, Date.parse("2026-07-30T10:29:00Z"))).toBe(false);
  });

  it("tuntematon tai kelvoton alkuaika ei ole koskaan mennyt", () => {
    // Piilottaminen tiedon puutteen takia on pahempi virhe kuin liian pitkä
    // lista: piilotettua ei osaa etsiä.
    const farFuture = Date.parse("2030-01-01T00:00:00Z");
    expect(isPastMatch(null, farFuture)).toBe(false);
    expect(isPastMatch(undefined, farFuture)).toBe(false);
    expect(isPastMatch("", farFuture)).toBe(false);
    expect(isPastMatch("ei-aika", farFuture)).toBe(false);
  });

  it("armonaika on säädettävissä", () => {
    expect(isPastMatch(KICKOFF, kickoffMs + 10 * 60_000, 5 * 60_000)).toBe(true);
    expect(isPastMatch(KICKOFF, kickoffMs + 10 * 60_000, 30 * 60_000)).toBe(false);
  });

  it("armonaika on tunti", () => {
    // Ottelun kesto vaihtelee muodoittain (leirissä 1 jakso, sarjassa 2), eikä
    // tulospalvelu kerro päättymistä etukäteen — liian lyhyt raja piilottaisi
    // ottelun jota vielä ajetaan.
    expect(PAST_MATCH_GRACE_MS).toBe(60 * 60 * 1000);
  });
});
