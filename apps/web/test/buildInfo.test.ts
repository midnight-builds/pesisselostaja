import { describe, it, expect } from "vitest";
import { BUILD_INFO, UNKNOWN_BUILD, formatBuildInfo, type BuildInfo } from "../src/buildInfo.js";

/** Issue #71: tarjoiltu build ei kertonut mistä se on peräisin, ja kerran
 *  palvelu jäi pyörittämään haaralta siirrettyä buildia ilman että sitä voi
 *  todeta käyttöliittymästä.
 *
 *  Nämä ovat apps/web:n ensimmäiset testit (#86 koskee sitä laajemmin). Ne
 *  ajetaan ilman viten `define`-korvausta, mikä on samalla tämän moduulin
 *  toinen tarkistus: sen on selvittävä myös silloin kun `__BUILD_INFO__` ei
 *  ole olemassa. */

const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  sha: "abc1234",
  branch: "main",
  dirty: false,
  builtAt: "2026-07-31T00:12:00Z",
  ...over,
});

describe("formatBuildInfo (#71)", () => {
  it("näyttää haaran, SHA:n ja päiväyksen", () => {
    expect(formatBuildInfo(info())).toBe("main abc1234 · 31.7.2026");
  });

  it("näyttää haaran myös kun se on main", () => {
    // Koko vian ydin oli, ettei haaralta siirrettyä buildia voinut erottaa
    // mainista. Haaran jättäminen pois "koska se on yleensä main" palauttaisi
    // täsmälleen saman sokean pisteen.
    expect(formatBuildInfo(info({ branch: "feat/jokin-haara" }))).toContain("feat/jokin-haara");
    expect(formatBuildInfo(info())).toContain("main");
  });

  it("merkitsee committaamattomat muutokset", () => {
    // Tämä erottaa "tämä on origin/main" väittämästä "tämä on jotain mitä ei
    // ole missään" — jälkimmäistä ei voi jäljittää commitista.
    expect(formatBuildInfo(info({ dirty: true }))).toBe("main abc1234 + muokattu · 31.7.2026");
  });

  it("sanoo suoraan kun tietoa ei ole", () => {
    // Build ilman gitiä (tarball, irrotettu ajokopio). "Versio tuntematon" on
    // rehellisempi kuin puuttuva merkintä: se erottaa "ei tietoa" tilanteesta
    // "tätä ei ole merkitty lainkaan".
    expect(formatBuildInfo(UNKNOWN_BUILD)).toBe("versio tuntematon");
    expect(formatBuildInfo(info({ sha: "unknown" }))).toBe("versio tuntematon");
  });

  it("jättää päiväyksen pois jos se puuttuu tai on kelvoton", () => {
    // Ilman tätä merkinnässä lukisi "Invalid Date" — mikä näyttäisi vialta
    // juuri siinä rivissä jonka tehtävä on kertoa ettei mikään ole vialla.
    expect(formatBuildInfo(info({ builtAt: "" }))).toBe("main abc1234");
    expect(formatBuildInfo(info({ builtAt: "eilen" }))).toBe("main abc1234");
  });

  it("ilman viten korvausta BUILD_INFO on tuntematon eikä kaadu", () => {
    // `typeof`-vartio moduulissa: korvaamaton tunniste ei saa heittää
    // ReferenceErroria.
    expect(BUILD_INFO).toEqual(UNKNOWN_BUILD);
    expect(formatBuildInfo()).toBe("versio tuntematon");
  });
});
