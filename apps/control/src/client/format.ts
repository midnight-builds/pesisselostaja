/** Display helpers. The server runs in UTC; the operator thinks in Finnish
 *  time — every clock we render goes through here so that conversion can
 *  never be forgotten at one call site. */

const TZ = "Europe/Helsinki";

const timeFmt = new Intl.DateTimeFormat("fi-FI", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
});

const timeSecFmt = new Intl.DateTimeFormat("fi-FI", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const dateFmt = new Intl.DateTimeFormat("fi-FI", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "numeric",
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fiTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? timeFmt.format(d) : "–";
}

export function fiTimeSec(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? timeSecFmt.format(d) : "–";
}

export function fiDate(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? dateFmt.format(d) : "–";
}

/** ISO date (YYYY-MM-DD) for "today" in Finland, not in the browser's zone —
 *  the phone could be anywhere, the matches are always Finnish. */
export function todayInFinland(): string {
  // sv-SE happens to format exactly as ISO, which keeps this a one-liner.
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());
}

export function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`); // midday avoids DST edges
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "3 min sitten" — relative to the server's clock, which the payload carries. */
export function since(iso: string | null | undefined, now: string): string {
  const then = parse(iso);
  const ref = parse(now) ?? new Date();
  if (!then) return "–";
  const sec = Math.max(0, Math.round((ref.getTime() - then.getTime()) / 1000));
  if (sec < 10) return "juuri nyt";
  if (sec < 60) return `${sec} s sitten`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min sitten`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min sitten`;
}

/** "42 min kuluttua" / "alkoi 5 min sitten" — sama kello kuin `since`, toiseen
 *  suuntaan. Ajastettu-tila tarvitsee tämän: kellonaika yksin ei kerro onko
 *  odotus vielä pitkä, ja ottelun alku valuu rutiininomaisesti kymmenisen
 *  minuuttia ilmoitetusta (#170). */
export function untilOrSince(iso: string | null | undefined, now: string): string | null {
  const then = parse(iso);
  const ref = parse(now) ?? new Date();
  if (!then) return null;
  const sec = Math.round((then.getTime() - ref.getTime()) / 1000);
  if (sec <= 0) return `alkoi ${since(iso, now)}`;
  if (sec < 60) return "alkaa hetkenä minä hyvänsä";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min kuluttua`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} h kuluttua` : `${h} h ${rest} min kuluttua`;
}

export function duration(sec: number | null): string {
  if (sec == null) return "–";
  if (sec < 60) return `${Math.round(sec)} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Millisekunnit sekunteina, suomalaisittain: "4,0 s".
 *
 *  Selostusviive on ainoa luku, jota ottelun aikana säädetään, ja se luetaan
 *  kentällä yhdellä vilkaisulla. Millisekunnit ovat koneen yksikkö — neljä
 *  numeroa, jotka on luettava ajatuksella — eikä koneen kieltä näytetä
 *  ottelupäivän polulla (#176). */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} Gt`;
  return `${Math.round(n / 1024 ** 2)} Mt`;
}

/** 0 = 1. jakso, 1 = 2. jakso, 2 = supervuoro, 3 = kotiutuslyöntikilpailu. */
export function periodName(period: number | null): string {
  switch (period) {
    case 0:
      return "1. jakso";
    case 1:
      return "2. jakso";
    case 2:
      return "supervuoro";
    case 3:
      return "kotiutuslyöntikilpailu";
    default:
      return "–";
  }
}

export function periodShort(index: number): string {
  switch (index) {
    case 0:
      return "1. j";
    case 1:
      return "2. j";
    case 2:
      return "SV";
    case 3:
      return "KLK";
    default:
      return `${index + 1}.`;
  }
}

/** Accepts a bare id or any pesistulokset URL and digs out the match id. */
export function parseMatchId(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const matches = trimmed.match(/\d{3,}/g);
  if (!matches || matches.length === 0) return null;
  // URLs put the id last (…/ottelu/146210, ?matchId=146210).
  return Number(matches[matches.length - 1]);
}

/** Kuinka kauan ottelu pysyy listalla suunnitellun alkuajan jälkeen (#128).
 *
 *  Tunti on tarkoituksella karkea: raja ei voi olla tarkka, koska ottelun kesto
 *  vaihtelee muodoittain (leirimuodossa yksi jakso, mestaruussarjassa kaksi),
 *  eikä tulospalvelu kerro päättymistä etukäteen. Liian lyhyt raja piilottaisi
 *  ottelun jota vielä ajetaan. */
export const PAST_MATCH_GRACE_MS = 60 * 60 * 1000;

/** Onko ottelun suunniteltu alkuaika mennyt niin kauan sitten, ettei se enää
 *  kuulu ottelupäivän työlistalle.
 *
 *  Tuntematon tai kelvoton alkuaika EI ole mennyt: ottelun piilottaminen tiedon
 *  puutteen takia on pahempi virhe kuin liian pitkä lista, koska piilotettua
 *  ei osaa etsiä. `startsAt` kantaa oman vyöhykkeensä (`+03:00`), joten
 *  `Date.parse` riittää vaikka palvelin on UTC:ssä. */
export function isPastMatch(
  startsAt: string | null | undefined,
  nowMs: number,
  graceMs: number = PAST_MATCH_GRACE_MS,
): boolean {
  if (!startsAt) return false;
  const startedMs = Date.parse(startsAt);
  if (!Number.isFinite(startedMs)) return false;
  return nowMs - startedMs > graceMs;
}
