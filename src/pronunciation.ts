import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface PronunciationRule {
  /** Term as it appears in the generated speech text (matched whole-word). */
  from: string;
  /** Spoken replacement, e.g. "Koo Pee Äl". */
  to: string;
}

/** Terms TTS mispronounces by default. Most abbreviations (IPV etc.) read fine
 *  and must NOT be listed — only add terms that are actually misread. */
export const DEFAULT_PRONUNCIATIONS: PronunciationRule[] = [
  { from: "KPL", to: "Koo Pee Äl" },
];

export function loadPronunciations(filePath: string): PronunciationRule[] {
  if (!existsSync(filePath)) return [...DEFAULT_PRONUNCIATIONS];
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!Array.isArray(raw)) return [...DEFAULT_PRONUNCIATIONS];
    return sanitize(raw);
  } catch {
    return [...DEFAULT_PRONUNCIATIONS];
  }
}

export function savePronunciations(filePath: string, rules: PronunciationRule[]): void {
  writeFileSync(filePath, JSON.stringify(sanitize(rules), null, 2));
}

/** Keep only well-formed rules with a non-empty `from`. */
export function sanitize(raw: unknown[]): PronunciationRule[] {
  const out: PronunciationRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rule = r as Record<string, unknown>;
    if (typeof rule.from !== "string" || typeof rule.to !== "string") continue;
    const from = rule.from.trim();
    if (!from) continue;
    out.push({ from, to: rule.to });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finnish TTS reads a digit glued to a period ("6.") as an ordinal ("kuudes").
 *  Every number we speak is a score (a cardinal), so detach a sentence-final
 *  period from the preceding digit to force cardinal reading ("kuusi"). Decimals
 *  ("6.5") are left untouched since the period is followed by another digit. */
export function preventOrdinalReading(text: string): string {
  return text.replace(/(\d)\.(?=\s|$)/g, "$1 .");
}

/** Replace each rule's term with its spoken form. Matching is case-sensitive.
 *  Alphanumeric terms match whole-word only (so "KPL" won't touch "KPLX"); terms
 *  with punctuation/spaces match literally. Later rules see earlier rules' output. */
export function applyPronunciations(text: string, rules: PronunciationRule[]): string {
  let out = text;
  for (const rule of rules) {
    const term = rule.from.trim();
    if (!term) continue;
    const isWord = /^[\p{L}\p{N}]+$/u.test(term);
    const pattern = isWord
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "gu")
      : new RegExp(escapeRegExp(term), "g");
    out = out.replace(pattern, rule.to);
  }
  return out;
}
