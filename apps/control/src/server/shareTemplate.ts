/** Where the share message's wording lives (issue #95).
 *
 *  The text is pasted straight into WhatsApp groups, so it is the operator's
 *  own voice — not the app's. Rewording it must not mean editing TypeScript,
 *  rebuilding and restarting the service in the middle of a tournament day. So
 *  it is a JSON file in `run/`, the same idiom as every other piece of
 *  control-plane state (DESIGN.md: files an operator can read and hand-fix from
 *  the file browser).
 *
 *  Read per request: an edit takes effect on the next preview, no restart. A
 *  missing or broken file falls back to the canonical default rather than
 *  failing the request — going out in the default wording is survivable, no
 *  message at all is not. The pure type/default/renderer live in templates.ts,
 *  which must stay free of disk access. */

import { createStore } from "./store.js";
import { DEFAULT_SHARE_TEMPLATE, normalizeShareTemplate, type ShareTemplate } from "./templates.js";

const store = createStore<ShareTemplate>("share-template.json", DEFAULT_SHARE_TEMPLATE);

export async function readShareTemplate(): Promise<ShareTemplate> {
  return normalizeShareTemplate(await store.read());
}

/** Writes the template back to disk, defaults included, so the file exists to
 *  be found and edited. Called once at startup: a configurable thing nobody can
 *  see is not configurable in practice. */
export async function ensureShareTemplateFile(): Promise<ShareTemplate> {
  return await store.update((current) => normalizeShareTemplate(current));
}

/** Korvaa pohjan Asetukset-sivulta tulevalla arvolla (#133). Normalisointi
 *  ajetaan kirjoitettavaan arvoon: käyttöliittymä lähettää tekstikenttiä, ja
 *  tyhjä `lines` tai puuttuva `opening` palautuu kanoniseen oletukseen sen
 *  sijaan että jakoviesti hajoaisi kesken leiripäivän. */
export async function writeShareTemplate(next: unknown): Promise<ShareTemplate> {
  return await store.update(() => normalizeShareTemplate(next));
}
