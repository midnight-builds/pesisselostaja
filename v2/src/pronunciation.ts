const LS_KEY = "pesisselostaja-v2-pronunciations";

export interface PronunciationRule {
  from: string;
  to: string;
}

export const DEFAULT_PRONUNCIATIONS: PronunciationRule[] = [
  { from: "KPL", to: "Koo Pee Äl" },
];

export function loadPronunciations(): PronunciationRule[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [...DEFAULT_PRONUNCIATIONS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_PRONUNCIATIONS];
    return sanitize(parsed);
  } catch {
    return [...DEFAULT_PRONUNCIATIONS];
  }
}

export function savePronunciations(rules: PronunciationRule[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(sanitize(rules)));
}

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
