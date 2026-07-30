import { describe, it, expect } from "vitest";
import { buildJobShareMessage } from "../src/server/templates.js";

/** Issue #131: jakoviesti näkyi vain luontivastauksessa, joten se katosi jos
 *  operaattori ei kopioinut sitä heti tai sivu latautui uudelleen. Viesti on
 *  nyt muodostettava uudelleen työn tiedoista milloin tahansa. */

const TEXTS = {
  localTime: "12:30",
  matchup: "Pesä Ysit - LaJy",
  matchUrl: "https://www.pesistulokset.fi/ottelu/145905",
};

describe("buildJobShareMessage (#131)", () => {
  it("rakentaa viestin työn linkeistä ja merkitsee ne valmiiksi", () => {
    const out = buildJobShareMessage(
      { sourceUrl: "https://www.youtube.com/watch?v=LzgGjMO7BtE", targetVideoId: "F7AGKAHKeUQ" },
      TEXTS
    );

    expect(out.linksReady).toBe(true);
    // Kaikki kolme linkkiä, jotka jakoviestissä pitää olla (CONTEXT.md).
    expect(out.shareMessage).toContain("https://www.youtube.com/watch?v=LzgGjMO7BtE");
    expect(out.shareMessage).toContain("https://www.youtube.com/watch?v=F7AGKAHKeUQ");
    expect(out.shareMessage).toContain(TEXTS.matchUrl);
    expect(out.shareMessage).not.toContain("<youtube-linkki>");
  });

  it("antaa viestin myös ennen lähetysten luontia, mutta ei väitä sitä valmiiksi", () => {
    // Työ luodaan usein ennen lähetyksiä. Viestin näkeminen on silloinkin
    // hyödyllistä ("mitä puuttuu"), mutta jos linksReady valehtelisi, ryhmään
    // jaettaisiin teksti jossa lukee "<youtube-linkki>".
    const out = buildJobShareMessage({ sourceUrl: null, targetVideoId: null }, TEXTS);

    expect(out.linksReady).toBe(false);
    expect(out.shareMessage).toContain("<youtube-linkki>");
    expect(out.shareMessage).toContain("<selostettu-youtube-linkki>");
    // Ottelusivu on tiedossa heti, joten se ei ole paikkamerkki.
    expect(out.shareMessage).toContain(TEXTS.matchUrl);
  });

  it("puolikas linkkipari ei ole valmis", () => {
    // Raakalähetys luotu mutta selostettu ei (tai päinvastoin): viestistä
    // puuttuu toinen kanava, eikä sitä saa esittää jakokelpoisena.
    expect(
      buildJobShareMessage({ sourceUrl: "https://www.youtube.com/watch?v=LzgGjMO7BtE", targetVideoId: null }, TEXTS)
        .linksReady
    ).toBe(false);
    expect(
      buildJobShareMessage({ sourceUrl: null, targetVideoId: "F7AGKAHKeUQ" }, TEXTS).linksReady
    ).toBe(false);
  });

  it("noudattaa operaattorin omaa mallia", () => {
    // Sanamuoto tulee run/share-template.jsonista (#95), jotta sen voi vaihtaa
    // kesken leiripäivän ilman koodimuutosta — myös tällä polulla.
    const out = buildJobShareMessage(
      { sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", targetVideoId: "bbbbbbbbbbb" },
      TEXTS,
      { opening: "Oma malli {time}: {matchup}", lines: ["{watchUrl} / {narratedWatchUrl} / {matchUrl}"] }
    );
    expect(out.shareMessage).toContain("Oma malli 12:30: Pesä Ysit - LaJy");
    expect(out.shareMessage).toContain(
      "https://www.youtube.com/watch?v=aaaaaaaaaaa / https://www.youtube.com/watch?v=bbbbbbbbbbb / https://www.pesistulokset.fi/ottelu/145905"
    );
  });
});
