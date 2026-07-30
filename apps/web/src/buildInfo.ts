/** Mistä tarjoiltu build on peräisin (issue #71).
 *
 *  `pesisselostaja.service` tarjoilee `apps/web/dist`-hakemistoa, eikä siinä
 *  ollut mitään merkintää siitä mistä commitista se on rakennettu. Kerran
 *  palvelu jäi pyörittämään haaralta siirrettyä buildia, eikä sitä voinut
 *  todeta käyttöliittymästä — vasta uudelleenbuildaus paljasti sen.
 *
 *  Arvot leivotaan sisään käännösaikana (`vite.config.ts`), joten ne kuvaavat
 *  **buildia eivätkä työpuun nykytilaa**. Juuri se on pointti: työpuun voi
 *  vaihtaa haaralta toiselle ilman että tarjoiltu build muuttuu, ja tämä
 *  merkintä kertoo kumpaa katsotaan. */

export interface BuildInfo {
  /** Lyhyt commit-SHA, tai "unknown" jos gitiä ei ollut käytettävissä. */
  sha: string;
  branch: string;
  /** Oliko työpuussa committaamattomia muutoksia buildin hetkellä. Tämä on se
   *  kenttä joka erottaa "tämä on origin/main" väittämästä "tämä on jotain
   *  mitä ei ole missään". */
  dirty: boolean;
  /** ISO-hetki, jolloin build ajettiin. */
  builtAt: string;
}

export const UNKNOWN_BUILD: BuildInfo = {
  sha: "unknown",
  branch: "unknown",
  dirty: false,
  builtAt: "",
};

// Vite korvaa tämän tunnisteen tekstuaalisesti käännösaikana. `typeof`-vartio
// on siksi, että testit ja mahdollinen käännösvapaa ajo eivät kaatuisi
// ReferenceErroriin: korvaamattomana `typeof` tuntemattomasta tunnisteesta on
// laillinen ja palauttaa "undefined".
declare const __BUILD_INFO__: BuildInfo;

export const BUILD_INFO: BuildInfo =
  typeof __BUILD_INFO__ === "undefined" ? UNKNOWN_BUILD : __BUILD_INFO__;

/** Yhden rivin merkintä käyttöliittymään.
 *
 *  Haara mukaan aina, myös kun se on `main`: koko vian ydin oli se, että
 *  tarjolla oli haaralta siirretty build eikä sitä voinut erottaa mainista.
 *  Pelkkä SHA vaatisi gitin käyttöä sen tulkitsemiseen, mikä ei onnistu
 *  puhelimella kentän laidalla. */
export function formatBuildInfo(info: BuildInfo = BUILD_INFO): string {
  if (info.sha === "unknown") return "versio tuntematon";
  const dirty = info.dirty ? " + muokattu" : "";
  const date = formatBuildDate(info.builtAt);
  return `${info.branch} ${info.sha}${dirty}${date ? ` · ${date}` : ""}`;
}

/** `2026-07-31T00:12:00Z` → `31.7.2026`. Tyhjä tai kelvoton → tyhjä merkkijono,
 *  jolloin merkinnästä jää pois koko päiväysosa eikä siihen tule "Invalid
 *  Date". */
function formatBuildDate(iso: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}
