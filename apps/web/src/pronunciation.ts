// localStorage adapter for core's pronunciation rules (PronunciationStore
// port). The substitution/ordinal logic lives in @pesisselostaja/core.
import { DEFAULT_PRONUNCIATIONS, sanitize, type PronunciationRule } from "@pesisselostaja/core";

export {
  applyPronunciations,
  preventOrdinalReading,
  sanitize,
  DEFAULT_PRONUNCIATIONS,
  type PronunciationRule,
} from "@pesisselostaja/core";

const LS_KEY = "pesisselostaja-v2-pronunciations";

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
