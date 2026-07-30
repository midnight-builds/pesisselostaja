/** Kenttänimen siivousasetukset (issue #132).
 *
 *  Siivouksen säännöt ovat coressa (`venueDisplayName`, packages/core), koska
 *  ne ovat puhdasta domain-logiikkaa ja selostus käyttää samoja. Täällä on vain
 *  se, *ovatko ne päällä* — ja se on asetus eikä vakio, koska tulospalvelun
 *  merkinnät vaihtelevat sarjoittain: leirituotannon putkiliite ei ole sama
 *  asia kuin mestaruussarjan kenttänimi, ja väärään suuntaan siivottu nimi on
 *  katsojalle näkyvä virhe otsikossa.
 *
 *  Sama idiomi kuin jakoviestin pohjalla (`shareTemplate.ts`): JSON-tiedosto
 *  `run/`-hakemistossa, luettuna joka pyynnöllä, oletukset kirjoitettuna
 *  levylle käynnistyksessä. Asetusta jota ei voi nähdä ei käytännössä voi
 *  muuttaa. Käyttöliittymä sille tulee Asetukset-sivun mukana (#133); siihen
 *  asti tiedostoa muokataan tiedostoselaimesta, mikä on tämän ohjaamon
 *  vakiintunut tapa hoitaa harvoin muuttuvat arvot. */

import { createStore } from "./store.js";
import type { VenueNameOptions } from "@pesisselostaja/core";

/** Molemmat päällä: 30.7.2026 luotujen lähetysten otsikoissa luki
 *  `01 - Viinijärven pallokenttä, tekonurmi 1|` — kenttänumero ja katkennut
 *  tuotantomerkintä mukana. Oletus on se, mikä on oikein katsojalle. */
export const DEFAULT_VENUE_SETTINGS: Required<VenueNameOptions> = {
  stripFieldNumber: true,
  stripQualifier: true,
};

/** Vain kirjaimellinen `false` sammuttaa säännön. Käsin muokattu tiedosto,
 *  jossa lukee `"false"` (merkkijono) tai roskaa, ei saa hiljaa muuttaa
 *  käytöstä — tuntematon arvo tarkoittaa oletusta. */
export function normalizeVenueSettings(raw: unknown): Required<VenueNameOptions> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    stripFieldNumber: obj.stripFieldNumber === false ? false : DEFAULT_VENUE_SETTINGS.stripFieldNumber,
    stripQualifier: obj.stripQualifier === false ? false : DEFAULT_VENUE_SETTINGS.stripQualifier,
  };
}

const store = createStore<Required<VenueNameOptions>>("venue-cleanup.json", DEFAULT_VENUE_SETTINGS);

export async function readVenueSettings(): Promise<Required<VenueNameOptions>> {
  return normalizeVenueSettings(await store.read());
}

export async function ensureVenueSettingsFile(): Promise<Required<VenueNameOptions>> {
  return await store.update((current) => normalizeVenueSettings(current));
}
