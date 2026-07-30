import { execFileSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";

/** Leipoo buildiin tiedon siitä mistä se on peräisin (issue #71).
 *
 *  Kaksi ulostuloa samasta tiedosta:
 *  - `__BUILD_INFO__`, jonka käyttöliittymä näyttää asetuspaneelin
 *    alatunnisteessa — se on se paikka jossa vian olisi voinut todeta
 *    puhelimella,
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

export default defineConfig({
  base: "./",
  plugins: [buildInfo()],
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
