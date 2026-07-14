// Node file-based persistence adapter for v2's pronunciation rules.
//
// The substitution/ordinal logic is canonical in v2 and reused verbatim
// (applyPronunciations/preventOrdinalReading/sanitize). v2's own load/save go
// to localStorage; the relay reads its rules from a JSON file instead.
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_PRONUNCIATIONS, sanitize, type PronunciationRule } from "../../v2/src/pronunciation.js";

export {
  applyPronunciations,
  preventOrdinalReading,
  type PronunciationRule,
} from "../../v2/src/pronunciation.js";

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
