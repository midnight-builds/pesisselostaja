import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSignalSlate, fitSlateLine, parseSlateLayout } from "../src/noSignalSlate.js";

/** Sama yhden rivin JSON jonka `tools/no-signal-slate.py` tulostaa — sopimus
 *  generaattorin ja tämän moduulin välillä. */
const LAYOUT_JSON = JSON.stringify({
  width: 1920,
  height: 1080,
  barsHeight: 626,
  fontBold: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  fontRegular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  score: { y: 812, size: 58, color: "white", maxWidth: 1690 },
  status: { y: 892, size: 42, color: "0xB0B0B0", maxWidth: 1690 },
});

describe("fitSlateLine", () => {
  const score = { y: 812, size: 58, color: "white", maxWidth: 1690 };

  it("leaves a normal score row alone", () => {
    expect(fitSlateLine("Testilä Tähdet 12 – Esimerkki Eagles 1", score)).toBe(
      "Testilä Tähdet 12 – Esimerkki Eagles 1"
    );
  });

  it("truncates a row too wide for the frame, with an ellipsis", () => {
    // drawtext ei osaa kutistaa tekstiä eikä fontsize voi riippua text_w:stä,
    // joten ylileveä rivi leikkautuisi MOLEMMISTA reunoista — eli molemmista
    // joukkueiden nimistä katoaisi merkkejä keskeltä ulospäin.
    const wide = "Kotipesän Urheilijat Reippailijat 12 – Lyöntilän Palloseura Nuoret 11";
    const fitted = fitSlateLine(wide, score);
    expect(fitted.length).toBeLessThan(wide.length);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("does nothing when the generator reported no width limit", () => {
    const wide = "x".repeat(500);
    expect(fitSlateLine(wide, { ...score, maxWidth: 0 })).toBe(wide);
  });

  it("leaves an empty row empty — no lone ellipsis before the match starts", () => {
    expect(fitSlateLine("", score)).toBe("");
  });
});

describe("parseSlateLayout", () => {
  it("reads the generator's one-line JSON contract", () => {
    const layout = parseSlateLayout(`${LAYOUT_JSON}\n`);
    expect(layout).not.toBeNull();
    expect(layout!.width).toBe(1920);
    expect(layout!.barsHeight).toBe(626);
    expect(layout!.score).toEqual({ y: 812, size: 58, color: "white", maxWidth: 1690 });
    expect(layout!.status.color).toBe("0xB0B0B0");
  });

  it("reads the LAST non-empty line, so a python warning on stdout is harmless", () => {
    expect(parseSlateLayout(`DeprecationWarning: whatever\n${LAYOUT_JSON}\n\n`)).not.toBeNull();
  });

  it("returns null — never throws — on anything unexpected", () => {
    expect(parseSlateLayout("")).toBeNull();
    expect(parseSlateLayout("not json")).toBeNull();
    expect(parseSlateLayout("[1,2,3]")).toBeNull();
    // Puuttuva pakollinen kenttä on yhtä käyttökelvoton kuin roska.
    const noFont = JSON.parse(LAYOUT_JSON) as Record<string, unknown>;
    delete noFont.fontBold;
    expect(parseSlateLayout(JSON.stringify(noFont))).toBeNull();
    const noStatus = JSON.parse(LAYOUT_JSON) as Record<string, unknown>;
    delete noStatus.status;
    expect(parseSlateLayout(JSON.stringify(noStatus))).toBeNull();
  });
});

describe("NoSignalSlate", () => {
  let runDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "pesis-slate-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(runDir, { recursive: true, force: true });
  });

  /** Generaattorin sijainen: kirjoittaa kuvan ja tulostaa layout-JSONin, eli
   *  käyttäytyy kuin `tools/no-signal-slate.py` ilman pythonia tai PIL:iä. */
  function fakeGenerator(calls: string[][] = []) {
    return async (args: string[]): Promise<string> => {
      calls.push(args);
      const out = args[args.indexOf("--out") + 1];
      writeFileSync(out, Buffer.alloc(1024));
      return `${LAYOUT_JSON}\n`;
    };
  }

  function slate(runGenerator: (args: string[]) => Promise<string>): NoSignalSlate {
    return new NoSignalSlate({ matchId: 146210, runDir, runGenerator });
  }

  function logged(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  }

  it("renders once and exposes the layout and the three file paths", async () => {
    const calls: string[][] = [];
    const s = slate(fakeGenerator(calls));

    expect(await s.prepare()).toBe(true);

    expect(s.available).toBe(true);
    expect(s.imagePath).toBe(join(runDir, "slate-146210.png"));
    expect(s.scoreTextPath).toBe(join(runDir, "slate-score-146210.txt"));
    expect(s.statusTextPath).toBe(join(runDir, "slate-status-146210.txt"));
    expect(existsSync(s.imagePath)).toBe(true);
    expect(s.layout!.status.y).toBe(892);
    // Generaattori ajetaan kerran per ajo, ei per katko.
    await s.prepare();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--out");
    expect(calls[0]).toContain("1920");
  });

  it("starts with EMPTY text rows — ennen ottelua pisteitä ei näytetä", async () => {
    const s = slate(fakeGenerator());
    await s.prepare();
    expect(readFileSync(s.scoreTextPath, "utf8")).toBe("");
    expect(readFileSync(s.statusTextPath, "utf8")).toBe("");
  });

  it("accepts an empty score row while the status row has content", async () => {
    const s = slate(fakeGenerator());
    await s.prepare();
    s.update({ score: "", status: "kuvayhteyttä odotetaan — selostus jatkuu" });
    expect(readFileSync(s.scoreTextPath, "utf8")).toBe("");
    expect(readFileSync(s.statusTextPath, "utf8")).toBe("kuvayhteyttä odotetaan — selostus jatkuu");
  });

  it("writes a row only when its content actually changed", async () => {
    const s = slate(fakeGenerator());
    await s.prepare();
    s.update({ score: "TTä 3 - 1 EEa", status: "1. jakso, 2 paloa" });

    // Sentinel: jos update kirjoittaisi joka kutsulla, tämä katoaisi.
    writeFileSync(s.scoreTextPath, "SENTINEL");
    s.update({ score: "TTä 3 - 1 EEa", status: "1. jakso, 2 paloa" });
    expect(readFileSync(s.scoreTextPath, "utf8")).toBe("SENTINEL");

    s.update({ score: "TTä 4 - 1 EEa", status: "1. jakso, 2 paloa" });
    expect(readFileSync(s.scoreTextPath, "utf8")).toBe("TTä 4 - 1 EEa");
  });

  /** ffmpeg lukee näitä `reload`illa joka kehyksellä, joten kirjoituksen on
   *  oltava atominen: puoliksi kirjoitettu tiedosto vilkkuisi ruudulla. Tämä
   *  todistaa reitin tmp:n kautta — kun tmp-polku on varattu hakemistolla,
   *  kirjoitus epäonnistuu KOKONAAN eikä kohdetiedosto muutu lainkaan. */
  it("writes through a temp file and never touches the target when that fails", async () => {
    const s = slate(fakeGenerator());
    await s.prepare();
    s.update({ score: "alkuperäinen", status: "" });
    mkdirSync(`${s.scoreTextPath}.tmp`);

    s.update({ score: "ei saa mennä läpi", status: "" });

    expect(readFileSync(s.scoreTextPath, "utf8")).toBe("alkuperäinen");
    expect(logged()).toContain("slate.write_failed");
    // Yksi varoitus per ajo, ei yhtä per polli.
    s.update({ score: "toinen yritys", status: "" });
    expect(logged().match(/slate\.write_failed/g)).toHaveLength(1);
  });

  it("leaves no .tmp files behind on a successful write", async () => {
    const s = slate(fakeGenerator());
    await s.prepare();
    s.update({ score: "TTä 1 - 0 EEa", status: "1. jakso, 0 paloa" });
    expect(existsSync(`${s.scoreTextPath}.tmp`)).toBe(false);
    expect(existsSync(`${s.statusTextPath}.tmp`)).toBe(false);
  });

  describe("failure is never fatal — katve ohitetaan, käytös on nykyinen", () => {
    it("survives a missing python3 / failing generator with one warning", async () => {
      const s = slate(async () => {
        throw new Error("spawn python3 ENOENT");
      });
      await expect(s.prepare()).resolves.toBe(false);
      expect(s.available).toBe(false);
      expect(s.layout).toBeNull();
      expect(logged()).toContain("slate.unavailable");
      // update() on turvallinen no-op eikä heitä.
      expect(() => s.update({ score: "x", status: "y" })).not.toThrow();
    });

    it("rejects a generator that printed a layout but produced no image", async () => {
      const s = slate(async () => `${LAYOUT_JSON}\n`); // ei kirjoita kuvaa
      await expect(s.prepare()).resolves.toBe(false);
      expect(s.available).toBe(false);
    });

    it("rejects a generator whose stdout is not the agreed JSON line", async () => {
      const s = slate(async (args: string[]) => {
        writeFileSync(args[args.indexOf("--out") + 1], Buffer.alloc(16));
        return "valmis!\n";
      });
      await expect(s.prepare()).resolves.toBe(false);
      expect(s.available).toBe(false);
    });

    it("rejects an image file that exists but is empty", async () => {
      const s = slate(async (args: string[]) => {
        writeFileSync(args[args.indexOf("--out") + 1], Buffer.alloc(0));
        return `${LAYOUT_JSON}\n`;
      });
      await expect(s.prepare()).resolves.toBe(false);
    });
  });
});
