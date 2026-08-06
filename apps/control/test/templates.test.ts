// templates.ts on koko YouTube-ketjun tekstipuoli: otsikko, kuvaus ja
// jaettava viesti. Kaavat on tarkistettu docs/youtube-runbook.md:n omia
// esimerkkejä vasten — jos runbook muuttuu, näiden testien on muututtava
// ensin. Verkkoa ei tarvita: tiedosto on puhdas funktiokokoelma.
import { describe, expect, it } from "vitest";
import {
  PLAYLISTS_2026,
  SHARE_MESSAGE_OPENING,
  THUMBNAIL_HEADLINE_MAX_LENGTH,
  buildBroadcastSummary,
  buildBroadcastTexts,
  buildDescription,
  buildShareMessage,
  normalizeShareTemplate,
  DEFAULT_SHARE_TEMPLATE,
  buildThumbnailHeadline,
  buildTitle,
  formatIsoInZone,
  formatScheduledLocal,
  resolveAgeGroup,
  scheduledStartTimeFromLocal,
  templateInputFromMatch,
  type MatchTemplateInput,
} from "../src/server/templates.js";

/** Runbookin oma esimerkkiottelu: oma joukkue on vieraana, jotta otsikon
 *  "oma joukkue ensin" -sääntö tulee samalla testatuksi. */
function campMatch(overrides: Partial<MatchTemplateInput> = {}): MatchTemplateInput {
  return {
    matchId: 146210,
    home: "Hyvinkään Tahko",
    away: "Pesä Ysit E-tytöt kilpa",
    localDate: "15.7.2026",
    localTime: "13:30",
    venue: "Kempeleen Sarkkirannan kenttä 2",
    city: "Kempele",
    shortVenue: "Tenavaleiri Kempele",
    event: "Tenavaleiri 2026",
    stage: "Alkulohko",
    ...overrides,
  };
}

describe("otsikko", () => {
  it("noudattaa runbookin kaavaa <joukkue> - <vastustaja>, <pvm> <lyhyt paikka>", () => {
    expect(buildTitle(campMatch())).toBe(
      "Pesä Ysit E-tytöt kilpa - Hyvinkään Tahko, 15.7.2026 Tenavaleiri Kempele"
    );
  });

  it("ei koskaan sisällä lopputulosta — spoileri on käyttäjän nimenomainen kielto", () => {
    // resultString ei ole edes syötetyypissä; tämä testi vartioi sitä ettei
    // sitä lisätä myöhemmin "kätevyyssyistä".
    const title = buildTitle(campMatch());
    expect(title).not.toMatch(/\d+\s*[-–]\s*\d+/);
  });

  it("selostetun version otsikko on sama etuliitteellä 'Selostettu '", () => {
    const texts = buildBroadcastTexts(campMatch());
    expect(texts.narratedTitle).toBe(`Selostettu ${texts.title}`);
  });

  it("pudottaa nimet lyhyempiin muotoihin vasta kun otsikko ei mahdu", () => {
    const long = campMatch({
      home: "Jyväskylän Kiri & Kirittäret Juniorit Rautiainen",
      homeShort: "Kiri Juniorit Rautiainen",
      homeCode: "KIR",
      away: "Joensuun Maila Punainen",
      awayShort: "Joma Punainen",
      awayCode: "JOM",
      shortVenue: "Joensuu",
    });
    // Väljällä budjetilla täydet nimet säilyvät.
    expect(buildTitle(long)).toBe(
      "Jyväskylän Kiri & Kirittäret Juniorit Rautiainen - Joensuun Maila Punainen, 15.7.2026 Joensuu"
    );
    // Tiukemmalla budjetilla pudotaan API:n shorthandeihin — ei katkaista.
    const tight = buildTitle(long, 60);
    expect(tight).toBe("Kiri Juniorit Rautiainen - Joma Punainen, 15.7.2026 Joensuu");
    expect(tight).not.toContain("…");
  });

  // #221: käyttöliittymä tarvitsee parin ERIKSEEN, ei pelkkänä "A - B"
  // -merkkijonona. "Muokkaa otsikkoa" -kentät näyttivät kovakoodattua
  // esimerkkiä toisesta ottelusta, ja korjaus on että placeholder tulee tästä
  // ottelusta — samalla päättelyllä jolla otsikkokin syntyy.
  it("kertoo oman joukkueen ja vastustajan erikseen, otsikon päättelyllä", () => {
    // Oma joukkue vieraana: pari ei saa mennä koti/vieras-järjestykseen.
    const away = buildBroadcastTexts(campMatch());
    expect(away.ownTeam).toBe("Pesä Ysit E-tytöt kilpa");
    expect(away.opponentTeam).toBe("Hyvinkään Tahko");

    // ...eikä kotijoukkueenakaan.
    const home = buildBroadcastTexts(campMatch({ home: "Pesä Ysit F-pojat", away: "IPV" }));
    expect(home.ownTeam).toBe("Pesä Ysit F-pojat");
    expect(home.opponentTeam).toBe("IPV");

    // Operaattorin oma muokkaus voittaa päättelyn, kuten otsikossakin.
    const edited = buildBroadcastTexts(campMatch({ teamLabel: "Pesä Ysit E kilpa", opponent: "Tahko" }));
    expect(edited.ownTeam).toBe("Pesä Ysit E kilpa");
    expect(edited.opponentTeam).toBe("Tahko");

    // Ja pari on sama kuin otsikossa — kaksi lähdettä eriytyisi ennen pitkää.
    expect(`${away.ownTeam} - ${away.opponentTeam}`).toBe(away.matchup);
  });
});

describe("thumbnailin otsikkorivi", () => {
  it("lyhentää pitkän ottelupparin niin ettei renderöijä katkaise sitä", () => {
    // Tämä on se oikea tapaus joka katkesi renderöinnissä muotoon
    // "Jyväskylän Kiri & / Kirittäret Juniorit Ra…" — vastustaja katosi.
    const headline = buildThumbnailHeadline(
      campMatch({
        home: "Jyväskylän Kiri & Kirittäret Juniorit Rautiainen",
        homeShort: "Kiri Juniorit Rautiainen",
        homeCode: "KIR",
        away: "Joensuun Maila Punainen",
        awayShort: "Joma Punainen",
        awayCode: "JOM",
      })
    );
    expect(headline.length).toBeLessThanOrEqual(THUMBNAIL_HEADLINE_MAX_LENGTH);
    expect(headline).not.toContain("…");
    // Molemmat joukkueet on yhä tunnistettavissa.
    expect(headline).toBe("KIR - JOM");
  });

  it("jättää mahtuvan ottelupparin rauhaan", () => {
    expect(buildThumbnailHeadline(campMatch({ home: "Tahko" }))).toBe("Pesä Ysit E-tytöt kilpa - Tahko");
  });

  it("käyttää runbookin tunnettua lyhennystä kun täysi seuranimi ei mahdu", () => {
    // "Pesä Ysit E-tytöt kilpa - Hyvinkään Tahko" on 41 merkkiä eli yli
    // thumbnailin budjetin; runbookin oma esimerkki lyhentää juuri tämän
    // seuran muotoon "Tahko".
    expect(buildThumbnailHeadline(campMatch())).toBe("Pesä Ysit E-tytöt kilpa - Tahko");
  });

  it("kuvauksessa säilyvät täydet nimet vaikka otsikko lyhennettäisiin", () => {
    const long = campMatch({
      home: "Jyväskylän Kiri & Kirittäret Juniorit Rautiainen",
      homeShort: "Kiri Juniorit Rautiainen",
      away: "Joensuun Maila Punainen",
      awayShort: "Joma Punainen",
    });
    expect(buildDescription(long)).toContain(
      "Ottelu: Jyväskylän Kiri & Kirittäret Juniorit Rautiainen - Joensuun Maila Punainen"
    );
  });
});

describe("kuvaus", () => {
  it("noudattaa runbookin rakennetta ja sisältää tulospalvelulinkin", () => {
    expect(buildDescription(campMatch())).toBe(
      [
        "Ottelu: Hyvinkään Tahko - Pesä Ysit E-tytöt kilpa",
        "Päivä: 15.7.2026 klo 13:30",
        "Paikka: Kempeleen Sarkkirannan kenttä 2, Kempele",
        "Tapahtuma: Tenavaleiri 2026",
        "Vaihe: Alkulohko",
        "Tulospalvelu: https://www.pesistulokset.fi/ottelut/146210",
        "",
        "#pesäpallo #pesäysit #live #livestream",
      ].join("\n")
    );
  });

  it("jättää tuntemattomat kentät pois sen sijaan että kirjoittaisi tyhjän rivin", () => {
    const description = buildDescription(campMatch({ event: null, stage: null, city: null }));
    expect(description).not.toMatch(/Tapahtuma:/);
    expect(description).not.toMatch(/Vaihe:/);
    expect(description).toContain("Paikka: Kempeleen Sarkkirannan kenttä 2");
  });
});

describe("jaettava viesti", () => {
  // #95: viesti käyttää samoja joukkuenimiä kuin otsikko. Ensimmäinen oikea
  // lähetyspari (144980, 29.7.2026) jakoi tulospalvelun raa'at nimet, vaikka
  // otsikossa luki jo vakiintunut muoto.
  it("käyttää otsikon joukkuenimiä, ei tulospalvelun raakoja nimiä", () => {
    const texts = buildBroadcastTexts(
      campMatch({ teamLabel: "Pesä Ysit F-pojat", opponent: "IPV" })
    );
    expect(texts.shareMessage).toContain("Pesä Ysit F-pojat - IPV");
    expect(texts.shareMessage).not.toContain("Hyvinkään Tahko");
  });

  it("ilman ohituksia pari on edelleen täydet nimet", () => {
    const texts = buildBroadcastTexts(campMatch());
    expect(texts.shareMessage).toContain("Hyvinkään Tahko");
  });

  it("noudattaa run/share-template.jsonin muotoa kun sellainen on annettu", () => {
    const texts = buildBroadcastTexts(campMatch(), {
      opening: "Tänään klo {time} pelataan {matchup}!",
      lines: ["Katso: {watchUrl}", "Tulokset: {matchUrl}"],
    });
    expect(texts.shareMessage.split("\n")).toEqual([
      // Oma joukkue ensin, kuten otsikossa — sama pari molemmissa (#95).
      "Tänään klo 13:30 pelataan Pesä Ysit E-tytöt kilpa - Hyvinkään Tahko!",
      "Katso: <youtube-linkki>",
      "Tulokset: https://www.pesistulokset.fi/ottelut/146210",
    ]);
  });

  it("jättää tuntemattoman paikkamerkin näkyviin — kirjoitusvirhe kuuluu huomata esikatselusta", () => {
    const message = buildShareMessage(
      { localTime: "13:30", matchup: "A - B" },
      { matchUrl: "https://www.pesistulokset.fi/ottelut/1" },
      { opening: "Klo {aika}: {matchup}", lines: ["{matchUrl}"] }
    );
    expect(message).toContain("{aika}");
  });

  it("rikkinäinen tiedosto palautuu oletukseen sen sijaan että viesti jäisi tyhjäksi", () => {
    expect(normalizeShareTemplate({ opening: "", lines: [] })).toEqual(DEFAULT_SHARE_TEMPLATE);
    expect(normalizeShareTemplate(null)).toEqual(DEFAULT_SHARE_TEMPLATE);
    expect(normalizeShareTemplate({ opening: "Oma {matchup}" })).toEqual({
      opening: "Oma {matchup}",
      lines: DEFAULT_SHARE_TEMPLATE.lines,
    });
  });

  it("alkaa aina tarkalleen fraasilla 'Seuraava live on '", () => {
    const texts = buildBroadcastTexts(campMatch());
    expect(texts.shareMessage.startsWith(SHARE_MESSAGE_OPENING)).toBe(true);
  });

  it("listaa linkit runbookin järjestyksessä, ottelupari koti - vieras", () => {
    const message = buildShareMessage(
      { localTime: "13:30", matchup: "Hyvinkään Tahko - Pesä Ysit E-tytöt kilpa" },
      {
        watchUrl: "https://www.youtube.com/watch?v=aaa",
        narratedWatchUrl: "https://www.youtube.com/watch?v=bbb",
        matchUrl: "https://www.pesistulokset.fi/ottelut/146210",
      }
    );
    expect(message).toBe(
      [
        "Seuraava live on klo 13:30: Hyvinkään Tahko - Pesä Ysit E-tytöt kilpa. Alla linkit:",
        "YouTube: https://www.youtube.com/watch?v=aaa",
        "YouTube selostettu: https://www.youtube.com/watch?v=bbb",
        "Tulospalvelu: https://www.pesistulokset.fi/ottelut/146210",
      ].join("\n")
    );
  });

  it("ei koskaan sisällä stream keytä — se kuuluu vain operaattorin koosteeseen", () => {
    const texts = buildBroadcastTexts(campMatch());
    expect(texts.shareMessage).not.toMatch(/Stream Key/i);
    const summary = buildBroadcastSummary({
      watchUrl: "https://www.youtube.com/watch?v=aaa",
      narratedWatchUrl: "https://www.youtube.com/watch?v=bbb",
      matchUrl: texts.matchUrl,
      narratedTitle: texts.narratedTitle,
      rtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
      backupUrl: "rtmp://b.rtmp.youtube.com/live2?backup=1",
      videoId: "bbb",
      streamKey: "abcd-efgh",
    });
    // Runbookin neljä pakollista kenttää.
    expect(summary).toContain("RTMP URL: rtmp://a.rtmp.youtube.com/live2");
    expect(summary).toContain("Backup URL: rtmp://b.rtmp.youtube.com/live2?backup=1");
    expect(summary).toContain("Video ID: bbb");
    expect(summary).toContain("Stream Key: abcd-efgh");
  });
});

describe("aikavyöhyke", () => {
  it("lukee API:n UTC-ajan Suomen paikallisajaksi (kesäaika)", () => {
    const texts = buildBroadcastTexts(
      templateInputFromMatch({
        id: 1,
        home: "Koti",
        away: "Vieras",
        startsAt: "2026-07-15T10:30:00.000Z",
        seriesName: null,
        stadium: "Kenttä",
      })
    );
    expect(texts.localDate).toBe("15.7.2026");
    expect(texts.localTime).toBe("13:30");
    expect(texts.scheduledLocal).toBe("15.7.2026 klo 13:30");
  });

  it("lukee talviajan oikein (+2 h, ei kiinteää +3)", () => {
    expect(formatIsoInZone("2026-03-21T08:00:00.000Z")).toEqual({ date: "21.3.2026", time: "10:00" });
  });

  it("muuntaa paikallisajan ISO:ksi ja tarkistaa muunnoksen kääntämällä sen takaisin", () => {
    expect(scheduledStartTimeFromLocal("15.7.2026", "13:30")).toBe("2026-07-15T10:30:00.000Z");
    expect(scheduledStartTimeFromLocal("21.3.2026", "10:00")).toBe("2026-03-21T08:00:00.000Z");
  });

  it("hylkää virheellisen päivämäärän tai kellonajan sen sijaan että arvaisi", () => {
    expect(() => scheduledStartTimeFromLocal("2026-07-15", "13:30")).toThrow(/päivämäärä/i);
    expect(() => scheduledStartTimeFromLocal("15.7.2026", "1330")).toThrow(/kellonaika/i);
  });

  it("näyttää ajan aina muodossa 15.7.2026 klo 13:30", () => {
    expect(formatScheduledLocal("15.7.2026", "13:30")).toBe("15.7.2026 klo 13:30");
  });
});

describe("soittolistan valinta", () => {
  it("valitsee ikäluokan mukaisen 2026-soittolistan", () => {
    expect(buildBroadcastTexts(campMatch()).playlistId).toBe(PLAYLISTS_2026.E.id);
    expect(buildBroadcastTexts(campMatch({ away: "Pesä Ysit G", home: "SuPo G mustat" })).playlistId).toBe(
      PLAYLISTS_2026.G.id
    );
    expect(buildBroadcastTexts(campMatch({ away: "Pesä Ysit F-pojat", home: "Tahko" })).playlistId).toBe(
      PLAYLISTS_2026.F.id
    );
    expect(buildBroadcastTexts(campMatch({ away: "Pesä Ysit D-tytöt", home: "Tahko" })).playlistId).toBe(
      PLAYLISTS_2026.D.id
    );
  });

  it("lukee ikäluokan omasta joukkueesta, ei vastustajan nimestä", () => {
    const texts = buildBroadcastTexts(campMatch({ away: "Pesä Ysit E-tytöt kilpa", home: "SuPo G mustat" }));
    expect(texts.ageGroup).toBe("E");
    expect(texts.playlistId).toBe(PLAYLISTS_2026.E.id);
  });

  it("ei erehdy tavallisesta sanasta joka alkaa ikäluokan kirjaimella", () => {
    expect(resolveAgeGroup("Kempele Esikko")).toBeNull();
    expect(resolveAgeGroup("Pesä Ysit E-tytöt")).toBe("E");
  });

  it("kutsujan antama soittolista ohittaa automaattivalinnan", () => {
    expect(buildBroadcastTexts(campMatch({ playlistId: "PLoma" })).playlistId).toBe("PLoma");
  });
});

describe("thumbnailin syötteet", () => {
  it("antaa renderThumbnailille valmiit rivit: lyhyt paikka, ei tarkkaa kenttää", () => {
    const texts = buildBroadcastTexts(campMatch());
    expect(texts.thumbnailDatetime).toBe("15.7.2026 klo 13:30");
    expect(texts.thumbnailVenue).toBe("Tenavaleiri Kempele");
    // Tarkka kenttä jää videon sijaintitiedoksi ja kuvaukseen.
    expect(texts.venue).toBe("Kempeleen Sarkkirannan kenttä 2, Kempele");
  });
});
