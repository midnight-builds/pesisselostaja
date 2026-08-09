import { execFileSync } from "node:child_process";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Leipoo buildiin tiedon siitä mistä se on peräisin (issue #71).
 *
 *  Kaksi ulostuloa samasta tiedosta:
 *  - `__BUILD_INFO__`, jonka käyttöliittymä näyttää asetuspaneelin
 *    alatunnisteessa — se on se paikka jossa vian olisi voinut todeta
 *    operaattorin puhelimella,
 *  - `dist/version.json`, joka on samalla `/version.json`-osoite ilman yhtään
 *    palvelinmuutosta, koska `apps/server` tarjoilee `dist`-hakemistoa
 *    sellaisenaan.
 *
 *  Git luetaan try/catchin sisällä: buildin on onnistuttava myös ilman gitiä
 *  (tarball, irrotettu ajokopio). Silloin merkintä lukee "versio tuntematon",
 *  mikä on rehellisempi kuin puuttuva merkintä — se erottaa "ei tietoa"
 *  tilanteesta "tätä ei ole merkitty". */
function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function buildInfo(): Plugin {
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  // `--porcelain` on tyhjä täsmälleen silloin kun työpuu on siisti.
  const status = git(["status", "--porcelain"]);
  const info = {
    sha: sha ?? "unknown",
    branch: branch ?? "unknown",
    dirty: status !== null && status.length > 0,
    builtAt: new Date().toISOString(),
  };
  return {
    name: "pesisselostaja-build-info",
    config() {
      return { define: { __BUILD_INFO__: JSON.stringify(info) } };
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify(info, null, 2) + "\n",
      });
    },
  };
}

/** Lisää GoatCounter-merkin `index.html`:ään kun `PUBLIC_GOATCOUNTER_URL` on
 *  asetettu. Ilman muuttujaa buildiin ei tule riviäkään — kehitysajo ja
 *  paikallinen :3000 eivät siis kirjaa käyntejä analytiikkaan.
 *
 *  Käyntien laskuri on evästeetön eikä tunnista käyttäjää, joten selain saa
 *  ladata skriptin `async`-tilassa: sen puuttuminen ei riko mitään. */
function goatcounter(url: string | undefined): Plugin {
  return {
    name: "pesisselostaja-goatcounter",
    transformIndexHtml() {
      if (!url) return [];
      return [
        {
          tag: "script",
          attrs: { async: true, "data-goatcounter": url, src: `${url}.js` },
          injectTo: "head",
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [buildInfo(), goatcounter(loadEnv(mode, process.cwd(), "PUBLIC_").PUBLIC_GOATCOUNTER_URL)],
  build: {
    outDir: "dist",
    target: "es2022",
  },
}));
