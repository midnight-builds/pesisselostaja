import { execFile } from "node:child_process";
import { renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn } from "./log.js";

/** Katvekuvan ("EI SIGNAALIA") elinkaari: taustakuvan renderöinti kerran per
 *  ajo, ja kaksi tekstitiedostoa joita ffmpeg lukee `drawtext ... reload=1`
 *  -filtterillä.
 *
 *  Tämä moduuli ei tiedä ffmpegistä mitään — se omistaa tiedostot ja
 *  layout-metriikat, ja ffmpeg-argumenttien rakentaja (ffmpegMixer.ts) lukee
 *  ne täältä. Jako on tarkoituksellinen: kuvan tuottaminen saa epäonnistua
 *  ilman että mikserin respawn-silmukka muuttuu miksikään.
 *
 *  Miksi teksti tulee TIEDOSTOSTA eikä filtterimerkkijonosta: `-loop 1 -i
 *  kuva.png` -syötteen vaihtaminen vaatisi ffmpegin uudelleenkäynnistyksen,
 *  eli näkyvän katkon jokaisesta pistemuutoksesta. `reload=1` lukee tiedoston
 *  uudelleen joka kehyksellä, joten pisterivi ja tilannerivi päivittyvät
 *  ilman respawnia. Siksi kirjoitus on myös atominen (tmp + rename): puoliksi
 *  kirjoitettu tiedosto vilkkuisi suorassa lähetyksessä. */

/** Yhden tekstirivin sijoittelu ja tyyli, sellaisena kuin generaattori sen
 *  raportoi. Arvot menevät sellaisinaan drawtext-filtterille. */
export interface SlateTextStyle {
  /** Tekstilaatikon YLÄREUNAN y-koordinaatti pikseleinä. */
  y: number;
  /** Kirjasinkoko pikseleinä. */
  size: number;
  /** ffmpeg-yhteensopiva väri, esim. `white` tai `0xB0B0B0`. */
  color: string;
}

/** Generaattorin stdoutiin tulostama yhden rivin JSON. Sopimus toisen agentin
 *  kirjoittaman `tools/no-signal-slate.py`:n kanssa — älä muuta kenttiä
 *  yksipuolisesti. */
export interface SlateLayout {
  width: number;
  height: number;
  /** Väripalkkien korkeus; ei käytetä argumenteissa, mutta kertoo mihin asti
   *  kuvassa on palkkeja — pidetään mukana jotta sommittelua voi tarkistaa
   *  ilman kuvan avaamista. */
  barsHeight: number;
  fontBold: string;
  fontRegular: string;
  score: SlateTextStyle;
  status: SlateTextStyle;
}

/** Katvekuvan kaksi tekstiriviä. Tyhjä merkkijono = riviä ei näytetä
 *  (ennen ottelun alkua pisteitä ei ole). */
export interface SlateText {
  score: string;
  status: string;
}

export interface NoSignalSlateOptions {
  matchId: number;
  /** Hakemisto johon kuva ja tekstitiedostot kirjoitetaan (yleensä `run/`). */
  runDir: string;
  /** Generaattoriskripti; oletuksena `apps/broadcast/tools/no-signal-slate.py`. */
  generatorPath?: string;
  width?: number;
  height?: number;
  /** Testiseam: ajaa generaattorin ja palauttaa sen stdoutin. Oletus ajaa
   *  `python3 <skripti> …` ilman shelliä (execFile), jotta polkuun päätyvä
   *  erikoismerkki ei voi tulla tulkituksi komennoksi. */
  runGenerator?: (args: string[]) => Promise<string>;
}

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
/** Generaattori on PIL-ketju joka mittauksen mukaan vie ~0,2 s. 20 s on
 *  reilusti yli sen ja silti niin lyhyt, ettei jumittunut python jää
 *  roikkumaan katkon ajaksi. */
const GENERATOR_TIMEOUT_MS = 20_000;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseTextStyle(raw: unknown): SlateTextStyle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.y !== "number" || !Number.isFinite(rec.y)) return null;
  if (!isPositiveNumber(rec.size)) return null;
  if (typeof rec.color !== "string" || rec.color === "") return null;
  return { y: rec.y, size: rec.size, color: rec.color };
}

/** Jäsentää generaattorin stdoutin. Viimeinen ei-tyhjä rivi luetaan, jotta
 *  PIL:n tai pythonin mahdollinen varoitus stdoutissa ei kaada jäsennystä.
 *  Palauttaa `null` kaikesta odottamattomasta — kutsuja tulkitsee sen
 *  "katvekuvaa ei ole", ei virheeksi josta heitetään. */
export function parseSlateLayout(stdout: string): SlateLayout | null {
  const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop();
  if (!line) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const score = parseTextStyle(rec.score);
  const status = parseTextStyle(rec.status);
  if (!score || !status) return null;
  if (!isPositiveNumber(rec.width) || !isPositiveNumber(rec.height)) return null;
  if (typeof rec.fontBold !== "string" || rec.fontBold === "") return null;
  if (typeof rec.fontRegular !== "string" || rec.fontRegular === "") return null;
  const barsHeight = isPositiveNumber(rec.barsHeight) ? rec.barsHeight : 0;
  return {
    width: rec.width,
    height: rec.height,
    barsHeight,
    fontBold: rec.fontBold,
    fontRegular: rec.fontRegular,
    score,
    status,
  };
}

function defaultRunGenerator(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile, ei exec: ei shelliä, joten polussa oleva välilyönti tai
    // erikoismerkki ei voi tulla tulkituksi komennoksi.
    execFile(
      "python3",
      args,
      { timeout: GENERATOR_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

export class NoSignalSlate {
  private readonly matchId: number;
  private readonly runDir: string;
  private readonly generatorPath: string;
  private readonly width: number;
  private readonly height: number;
  private readonly runGenerator: (args: string[]) => Promise<string>;
  private layoutValue: SlateLayout | null = null;
  private lastText: SlateText = { score: "", status: "" };
  /** Kirjoitusvirheestä varoitetaan kerran per ajo: katkon aikana päivitys
   *  yritetään joka pollilla, ja rikkinäinen polku täyttäisi muuten lokin
   *  jonka on tarkoitus selittää katko. */
  private warnedAboutWrites = false;

  constructor(opts: NoSignalSlateOptions) {
    this.matchId = opts.matchId;
    this.runDir = opts.runDir;
    this.generatorPath =
      opts.generatorPath ?? new URL("../tools/no-signal-slate.py", import.meta.url).pathname;
    this.width = opts.width ?? DEFAULT_WIDTH;
    this.height = opts.height ?? DEFAULT_HEIGHT;
    this.runGenerator = opts.runGenerator ?? defaultRunGenerator;
  }

  /** Tosi vasta kun taustakuva on renderöity ja layout jäsennetty. Mikseri saa
   *  koskea katvetilaan vain tämän ollessa tosi. */
  get available(): boolean {
    return this.layoutValue !== null;
  }

  get layout(): SlateLayout | null {
    return this.layoutValue;
  }

  get imagePath(): string {
    return join(this.runDir, `slate-${this.matchId}.png`);
  }

  get scoreTextPath(): string {
    return join(this.runDir, `slate-score-${this.matchId}.txt`);
  }

  get statusTextPath(): string {
    return join(this.runDir, `slate-status-${this.matchId}.txt`);
  }

  /** Ajaa generaattorin kerran ja ottaa layoutin käyttöön. Ei koskaan heitä:
   *  puuttuva python3, puuttuva PIL, epäonnistunut renderöinti tai
   *  odottamaton tuloste jättävät `available`in epätodeksi ja kirjoittavat
   *  YHDEN varoitusrivin. Katve on lisä, ei ehto lähetykselle. */
  async prepare(): Promise<boolean> {
    if (this.layoutValue) return true;
    try {
      const stdout = await this.runGenerator([
        this.generatorPath,
        "--out",
        this.imagePath,
        "--width",
        String(this.width),
        "--height",
        String(this.height),
      ]);
      const layout = parseSlateLayout(stdout);
      if (!layout) throw new Error("generaattorin tuloste ei ollut odotettua JSON-riviä");
      // Generaattori voi tulostaa layoutin ja silti epäonnistua kuvan
      // kirjoituksessa; ilman tätä tarkistusta ffmpeg käynnistettäisiin
      // olemattomalla -i:llä ja kaatuisi vasta katkon hetkellä.
      const stat = statSync(this.imagePath);
      if (!stat.isFile() || stat.size === 0) throw new Error(`kuvatiedosto puuttuu tai on tyhjä: ${this.imagePath}`);
      this.layoutValue = layout;
      // Tyhjät rivit alkuun: ennen ottelun alkua ei ole pisteitä eikä
      // pelitilannetta, ja tyhjä tiedosto on drawtextille kelvollinen.
      this.lastText = { score: " ", status: " " }; // pakota ensimmäinen kirjoitus
      this.update({ score: "", status: "" });
      logInfo(
        "slate.prepared",
        `Katvekuva valmis: ${this.imagePath} (${layout.width}x${layout.height}).`
      );
      return true;
    } catch (err) {
      this.layoutValue = null;
      logWarn(
        "slate.unavailable",
        `Katvekuvaa ei voitu valmistella (${err instanceof Error ? err.message : String(err)}) — ` +
          "katvetila ohitetaan ja lähteen uudelleenyritys toimii kuten ennenkin."
      );
      return false;
    }
  }

  /** Päivittää pisterivin ja tilannerivin. Kirjoittaa vain muuttuneen rivin ja
   *  aina atomisesti (tmp + rename): ffmpeg lukee tiedostoja `reload`illa joka
   *  kehyksellä, joten puoliksi kirjoitettu tiedosto näkyisi ruudulla. */
  update(text: SlateText): void {
    if (!this.layoutValue) return;
    if (text.score !== this.lastText.score) {
      if (this.writeAtomic(this.scoreTextPath, text.score)) this.lastText = { ...this.lastText, score: text.score };
    }
    if (text.status !== this.lastText.status) {
      if (this.writeAtomic(this.statusTextPath, text.status)) this.lastText = { ...this.lastText, status: text.status };
    }
  }

  /** Testien ja kutsujan avuksi: mitä ruudulla juuri nyt lukee. */
  get currentText(): SlateText {
    return { ...this.lastText };
  }

  private writeAtomic(path: string, contents: string): boolean {
    const tmp = `${path}.tmp`;
    try {
      // Ei rivinvaihtoa perään: drawtext piirtäisi siitä ylimääräisen tyhjän
      // rivin ja siirtäisi tekstin sommittelusta pois.
      writeFileSync(tmp, contents);
      renameSync(tmp, path);
      return true;
    } catch (err) {
      if (!this.warnedAboutWrites) {
        this.warnedAboutWrites = true;
        logWarn(
          "slate.write_failed",
          `Katvekuvan tekstirivin kirjoitus epäonnistui (${err instanceof Error ? err.message : String(err)}) — ` +
            "kuva näyttää edellistä sisältöä."
        );
      }
      return false;
    }
  }
}
