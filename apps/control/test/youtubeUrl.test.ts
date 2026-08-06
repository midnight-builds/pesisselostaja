// parseYouTubeVideoId on ohjaamon ainoa tapa päätellä työn sourceUrlista, MIKÄ
// video YouTubesta pitää kysyä. Väärä id kuluttaa kiintiötä ja näyttää
// ohjaamossa siltä kuin lähetystä ei olisi olemassa, joten hylkäystapaukset
// ovat tässä yhtä tärkeitä kuin osumat.
import { describe, expect, it } from "vitest";
import { parseYouTubeVideoId } from "../src/shared/youtubeUrl.js";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeVideoId — tunnistetut muodot", () => {
  const accepted: Array<[string, string]> = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", ID],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ", ID],
    ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", ID],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", ID],
    ["https://youtu.be/dQw4w9WgXcQ", ID],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", ID],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", ID],
    // Lisäparametrit ovat tavallisia jaettaessa: ajankohta, jakolähde.
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", ID],
    ["https://youtu.be/dQw4w9WgXcQ?si=AbCdEfGh", ID],
    ["https://www.youtube.com/live/dQw4w9WgXcQ?feature=share", ID],
    ["https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ", ID],
    // Ohjaamon oma watchUrl on täsmälleen tässä muodossa.
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    // Välilyönnit leikepöydältä eivät saa kaataa jäsennystä.
    ["  https://youtu.be/dQw4w9WgXcQ  ", ID],
    ["https://WWW.YouTube.com/watch?v=dQw4w9WgXcQ", ID],
  ];

  it.each(accepted)("%s -> %s", (url, expected) => {
    expect(parseYouTubeVideoId(url)).toBe(expected);
  });
});

describe("parseYouTubeVideoId — hylätyt syötteet", () => {
  const rejected: Array<[string, string | null | undefined]> = [
    ["null", null],
    ["undefined", undefined],
    ["tyhjä merkkijono", ""],
    ["pelkkää tyhjää", "   "],
    ["ei URL lainkaan", "dQw4w9WgXcQ"],
    ["vapaa teksti", "katso youtube kanavalta"],
    ["muu isäntä", "https://vimeo.com/watch?v=dQw4w9WgXcQ"],
    ["huijaava aliverkkotunnus", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"],
    // Kanavakahvan live-osoitteessa videoId:tä ei ole URL:ssa lainkaan; sitä
    // ei saa arvata polusta.
    ["@kahva/live", "https://www.youtube.com/@pesisselostaja/live"],
    ["kanavan etusivu", "https://www.youtube.com/@pesisselostaja"],
    ["pelkkä /live ilman id:tä", "https://www.youtube.com/live"],
    ["watch ilman v-parametria", "https://www.youtube.com/watch?t=30"],
    ["liian lyhyt id", "https://www.youtube.com/watch?v=dQw4w9WgX"],
    ["liian pitkä id", "https://www.youtube.com/watch?v=dQw4w9WgXcQ12"],
    ["kelpaamaton merkki id:ssä", "https://www.youtube.com/watch?v=dQw4w9WgXc!"],
    ["pistettä ei hyväksytä id:ksi", "https://youtu.be/dQw4w9WgXc."],
    ["tyhjä polku lyhytosoitteessa", "https://youtu.be/"],
  ];

  it.each(rejected)("%s -> null", (_name, url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
  });
});
