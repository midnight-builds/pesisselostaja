/** YouTube-URLin jäsennys. Puhdas ja riippuvuudeton tarkoituksella: tämä
 *  ajetaan jokaisella lähteen tilan pollauskierroksella, eikä sillä ole mitään
 *  tekemistä verkon tai levyn kanssa. */

/** Isännät joista videoId ylipäätään voi tulla. `www.`-etuliite riisutaan
 *  ennen vertailua, joten myös `m.`- ja `music.`-muodot on lueteltava. */
const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"]);
const SHORT_HOSTS = new Set(["youtu.be"]);

/** YouTuben videoId on aina 11 merkkiä base64url-aakkostoa. Tarkistus on
 *  tässä siksi, että `/@kanava/live` ja muut polkumuodot eivät saa mennä läpi
 *  "id:nä" — väärä id kuluttaisi kiintiötä ja näyttäisi ohjaamossa siltä kuin
 *  lähetystä ei olisi olemassa. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function validId(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  return VIDEO_ID.test(candidate) ? candidate : null;
}

/** Kaivaa videoId:n YouTube-URLista. Lähde on `job.sourceUrl`, joka on joko
 *  ohjaamon itsensä luoma watch-URL tai operaattorin käsin liittämä. */
export function parseYouTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    // new URL heittää kaikesta mikä ei ole URL — se on halvempi ja
    // luotettavampi tarkistus kuin koko osoitteen regex.
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  const host = normalizeHost(parsed.hostname);

  if (SHORT_HOSTS.has(host)) {
    // https://youtu.be/ID — id on polun ensimmäinen osa, loput (?si=...) roskaa.
    return validId(parsed.pathname.split("/").filter(Boolean)[0]);
  }

  if (!YOUTUBE_HOSTS.has(host)) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);

  // https://www.youtube.com/watch?v=ID (myös m.youtube.com)
  if (segments[0] === "watch") return validId(parsed.searchParams.get("v"));

  // https://www.youtube.com/live/ID, /embed/ID, /shorts/ID — id on polussa.
  // Huom: /@kanava/live ei osu tähän, koska ensimmäinen osa on kanavakahva;
  // silloin videoId ei ole URL:ssa lainkaan ja oikea vastaus on null.
  if (segments.length >= 2 && (segments[0] === "live" || segments[0] === "embed" || segments[0] === "shorts")) {
    return validId(segments[1]);
  }

  return null;
}
