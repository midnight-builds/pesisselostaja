/** The share message's shape, as data rather than as a string literal in
 *  templates.ts (issue #95).
 *
 *  This text is pasted straight into WhatsApp groups, so it is the operator's
 *  own voice — not the app's. Wanting to reword it must not mean editing
 *  TypeScript, redeploying and restarting the service in the middle of a
 *  tournament day. It lives in `run/share-template.json`, the same idiom as
 *  every other piece of control-plane state (DESIGN.md: JSON files an operator
 *  can read and hand-fix from the file browser).
 *
 *  The file is read per request, so an edit takes effect on the next preview
 *  with no restart. A missing or broken file falls back to the canonical
 *  format below rather than failing the request — the message going out in the
 *  default wording is survivable, no message at all is not. */

import { createStore } from "./store.js";

export interface ShareTemplate {
  /** First line. Placeholders: {time}, {matchup}. */
  opening: string;
  /** One line per link. Placeholders: {watchUrl}, {narratedWatchUrl},
   *  {matchUrl}. A line whose only placeholder is unavailable is still shown
   *  with the placeholder text visible — a silently missing link would be
   *  noticed only by the people who did not get it. */
  lines: string[];
}

/** The wording confirmed in use on 29.7.2026 (issue #95). Anything the file
 *  does not override keeps these. */
export const DEFAULT_SHARE_TEMPLATE: ShareTemplate = {
  opening: "Seuraava live on klo {time}: {matchup}. Alla linkit:",
  lines: [
    "YouTube: {watchUrl}",
    "YouTube selostettu: {narratedWatchUrl}",
    "Tulospalvelu: {matchUrl}",
  ],
};

const store = createStore<ShareTemplate>("share-template.json", DEFAULT_SHARE_TEMPLATE);

/** Field by field, because a hand-edited file is expected: an operator who
 *  rewrites `opening` and deletes `lines` gets their opening plus the default
 *  links, not a crash and not an empty message. */
export function normalizeShareTemplate(raw: unknown): ShareTemplate {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const opening =
    typeof obj.opening === "string" && obj.opening.trim() !== ""
      ? obj.opening
      : DEFAULT_SHARE_TEMPLATE.opening;
  const lines =
    Array.isArray(obj.lines) && obj.lines.every((l) => typeof l === "string") && obj.lines.length > 0
      ? (obj.lines as string[])
      : DEFAULT_SHARE_TEMPLATE.lines;
  return { opening, lines };
}

export async function readShareTemplate(): Promise<ShareTemplate> {
  return normalizeShareTemplate(await store.read());
}

/** Writes the current template back to disk, defaults included, so the file
 *  exists to be found and edited. Called once at startup: a configurable thing
 *  nobody can see is not configurable in practice. */
export async function ensureShareTemplateFile(): Promise<ShareTemplate> {
  return await store.update((current) => normalizeShareTemplate(current));
}

/** Substitutes {name} placeholders. An unknown placeholder is left standing on
 *  purpose — it shows up in the preview, which is where a typo in the template
 *  should be caught, rather than vanishing into a blank spot in a message that
 *  has already been sent. */
export function renderShareTemplate(
  template: ShareTemplate,
  values: Record<string, string>
): string {
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
  return [template.opening, ...template.lines].map(fill).join("\n");
}
