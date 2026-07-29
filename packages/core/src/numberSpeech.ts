/** Number → Finnish-word helpers: spoken ordinals (see {@link finnishOrdinal},
 *  used by speech.ts for palo ordinals) and digit normalization for the
 *  ElevenLabs path.
 *
 *  ElevenLabs multilingual v2 reads bare digits in short Finnish phrases
 *  unclearly ("4, 3", "3 paloa"), while the same numbers
 *  written out as words are read fine. Piper reads digits correctly, so this
 *  is applied only inside the EL adapters (broadcast elevenLabsTts.ts, web
 *  elevenlabs.ts) — never to the readable text shown in logs/feed, and not a
 *  pronunciation-substitution rule (it is deterministic, not configurable). */

const UNITS = [
  "nolla",
  "yksi",
  "kaksi",
  "kolme",
  "neljä",
  "viisi",
  "kuusi",
  "seitsemän",
  "kahdeksan",
  "yhdeksän",
];

/** Finnish cardinal (nominative) for 0–9999; written together per Finnish
 *  orthography ("kaksikymmentäyksi", "satakaksitoista"). */
export function finnishCardinal(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new RangeError(`finnishCardinal: ${n}`);
  if (n < 10) return UNITS[n];
  if (n === 10) return "kymmenen";
  if (n < 20) return `${UNITS[n - 10]}toista`;
  if (n < 100) {
    const rest = n % 10;
    return `${UNITS[Math.floor(n / 10)]}kymmentä${rest ? UNITS[rest] : ""}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return `${hundreds === 1 ? "sata" : `${UNITS[hundreds]}sataa`}${rest ? finnishCardinal(rest) : ""}`;
  }
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  return `${thousands === 1 ? "tuhat" : `${UNITS[thousands]}tuhatta`}${rest ? finnishCardinal(rest) : ""}`;
}

const ORDINAL_UNITS = [
  "",
  "ensimmäinen",
  "toinen",
  "kolmas",
  "neljäs",
  "viides",
  "kuudes",
  "seitsemäs",
  "kahdeksas",
  "yhdeksäs",
];

/** Ordinal stem used inside compounds — 1 is "yhdes" there, not "ensimmäinen"
 *  ("yhdestoista", "yhdeksäskymmenes"). */
const ORDINAL_STEMS = [
  "",
  "yhdes",
  "kahdes",
  "kolmas",
  "neljäs",
  "viides",
  "kuudes",
  "seitsemäs",
  "kahdeksas",
  "yhdeksäs",
];

/** Finnish ordinal (nominative) for 1–99, written together per Finnish
 *  orthography ("kolmastoista", "kahdeskymmenesensimmäinen"). Used for spoken
 *  palo ordinals, which have no fixed ceiling: camp-format turns continue until
 *  three palot *and* everyone has batted, so a single turn can rack up well over
 *  ten palot (issue #50). 99 is far beyond any possible turn — a lineup is
 *  ~11 players. */
export function finnishOrdinal(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new RangeError(`finnishOrdinal: ${n}`);
  if (n < 10) return ORDINAL_UNITS[n];
  if (n === 10) return "kymmenes";
  if (n < 20) return `${ORDINAL_STEMS[n - 10]}toista`;
  const rest = n % 10;
  return `${ORDINAL_STEMS[Math.floor(n / 10)]}kymmenes${rest ? ORDINAL_UNITS[rest] : ""}`;
}

/** Replaces standalone digit runs with Finnish cardinals: "Tasan 4, 4." →
 *  "Tasan neljä, neljä." Leaves runs above 9999 (none occur in speech texts)
 *  untouched rather than guessing. */
export function spellOutNumbers(text: string): string {
  return text.replace(/\d+/g, (digits) => {
    const n = parseInt(digits, 10);
    return n <= 9999 ? finnishCardinal(n) : digits;
  });
}
