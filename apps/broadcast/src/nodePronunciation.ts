// File adapter for core's pronunciation rules (PronunciationStore port):
// the relay reads its rules from a JSON file. The substitution/ordinal logic
// lives in @pesisselostaja/core.
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_PRONUNCIATIONS, sanitize, type PronunciationRule } from "@pesisselostaja/core";

export {
  applyPronunciations,
  preventOrdinalReading,
  type PronunciationRule,
} from "@pesisselostaja/core";

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
