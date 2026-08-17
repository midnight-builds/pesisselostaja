// Vartija rinnakkaisia git-worktreitä vastaan (issue #259).
//
// Repon workspace-linkitys nojaa `node_modules/@pesisselostaja/*`-symlinkkeihin,
// joita `git worktree add` ei luo — `node_modules` on gitignorattu. Kun
// worktree on päächeckoutin SISÄLLÄ (agentit luodaan `.claude/worktrees/`:iin),
// Node kävelee hakemistopuuta ylös ja löytää päächeckoutin `node_modules`in.
// Testit ajavat silloin eri `packages/core`a kuin sitä, jota worktreessä
// muokataan: sarja on vihreä, testimäärä täsmää, eikä se ole koskaan nähnyt
// muutosta.
//
// Vika ei näy virheenä, joten se on tehtävä äänekkääksi. Tämä tiedosto
// tarkistaa ennen jokaista testitiedostoa, että jokainen workspace-paketti
// resolvoituu TÄMÄN työpuun sisään, ja kaataa ajon jos ei.

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_PAKETIT = [
  "@pesisselostaja/core",
  "@pesisselostaja/web",
  "@pesisselostaja/broadcast",
  "@pesisselostaja/control",
  "@pesisselostaja/server",
] as const;

// Tämä tiedosto on repon juuressa, joten sen oma sijainti ON se työpuu, jota
// ollaan testaamassa — riippumatta siitä mikä `process.cwd()` sattuu olemaan.
const tyopuu = realpathSync(dirname(fileURLToPath(import.meta.url)));

// Resolvointi juuresta jäljittelee sitä mitä testitiedostot tekevät: ylöspäin
// kävely päättyy juuren `node_modules`iin — tai jatkuu sen ohi, mikä on juuri
// se tilanne jonka haluamme napata.
const resolvoi = createRequire(import.meta.url);

function onSisalla(juuri: string, polku: string): boolean {
  const suhteellinen = relative(juuri, polku);
  return (
    suhteellinen !== "" &&
    !suhteellinen.startsWith("..") &&
    !isAbsolute(suhteellinen)
  );
}

const ulkopuolella: string[] = [];
const puuttuvat: string[] = [];

for (const paketti of WORKSPACE_PAKETIT) {
  let ratkaistu: string;
  try {
    // `pkg/package.json` toimii kaikille viidelle; pelkkä `pkg` ei, koska
    // sovelluspaketeilla ei ole importattavaa sisääntuloa.
    ratkaistu = realpathSync(resolvoi.resolve(`${paketti}/package.json`));
  } catch {
    puuttuvat.push(paketti);
    continue;
  }
  if (!onSisalla(tyopuu, ratkaistu)) {
    ulkopuolella.push(`  ${paketti} -> ${ratkaistu}`);
  }
}

if (ulkopuolella.length > 0 || puuttuvat.length > 0) {
  const rivit = [
    "",
    "VÄÄRÄ WORKSPACE-KOPIO — testit eivät testaa tätä työpuuta (issue #259).",
    "",
    `Työpuu: ${tyopuu}`,
  ];

  if (ulkopuolella.length > 0) {
    rivit.push(
      "",
      "Nämä @pesisselostaja-paketit resolvoituvat työpuun ULKOPUOLELLE:",
      ...ulkopuolella,
      "",
      "Testit ajaisivat siis eri koodia kuin se, jota tässä hakemistossa on",
      "muokattu. Vihreä tulos ei todistaisi mitään.",
    );
  }

  if (puuttuvat.length > 0) {
    rivit.push(
      "",
      "Nämä @pesisselostaja-paketit eivät resolvoidu lainkaan:",
      ...puuttuvat.map((p) => `  ${p}`),
      "",
      "Työpuusta puuttuu node_modules eikä ylempääkään löydy workspace-linkkejä.",
    );
  }

  rivit.push(
    "",
    "KORJAUS: aja `npm install` TÄSSÄ hakemistossa:",
    `  cd ${tyopuu} && npm install`,
    "",
    "Tarkista sen jälkeen, että linkki osoittaa tänne:",
    "  readlink -f node_modules/@pesisselostaja/core",
    "",
  );

  throw new Error(rivit.join("\n"));
}
