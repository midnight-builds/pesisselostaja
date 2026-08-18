import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NarrationFifo, FIFO_FRAME_BYTES } from "../src/narrationFifo.js";

/** Libuvin säiepoolin koko. Testi EI vaadi ympäristömuuttujaa: ilman sitä
 *  pooli on neljä säiettä, ja jos ajaja on kasvattanut sitä, luetaan kasvatettu
 *  arvo — kummassakin tapauksessa yritetään tukkia pooli kokonaan. */
const POOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE) || 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`aikakatkaisu: ${what}`)), ms);
      t.unref();
    }),
  ]);
}

describe("NarrationFifo: jumissa oleva avaus ei saa vuotaa säiepoolisäiettä (#274)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pesis-fifo-leak-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Tämä on itse vika. Katvekuvasilmukka (ffmpegMixer.ts:1383-1388) tekee
   *  juuri tämän kierroksen: prepare + open (joka blokkaa kernelissä kunnes
   *  lukija liittyy) + closeIo, kun ffmpeg ei käynnistynyt. Ilman korjausta
   *  jokainen kierros jättää yhden libuv-säikeen varatuksi pysyvästi, ja
   *  poolin täytyttyä KAIKKI tiedosto-operaatiot roikkuvat — relay jumittuu
   *  kesken lähetyksen.
   *
   *  Mittari on suora: poolin verran + 2 hylättyä avausta, ja sen jälkeen
   *  tavallinen stat(). Jos yksikin avaus jäi roikkumaan poolin täyttymisen
   *  jälkeen, stat ei koskaan valmistu. */
  it("vapauttaa jokaisen hylätyn avauksen, joten säiepooli ei tukkeudu toistuvasta katvekierroksesta", async () => {
    const rounds = POOL_SIZE + 2;
    const fifos: NarrationFifo[] = [];
    for (let i = 0; i < rounds; i++) {
      const fifo = new NarrationFifo(join(dir, `slate-${i}.pcm`));
      await fifo.prepare();
      fifos.push(fifo);
    }

    for (const fifo of fifos) {
      // Yhtään lukijaa ei ole: avaus jää kerneliin odottamaan.
      void fifo.open();
      await sleep(20); // avauspyyntö ehtii säiepooliin
      fifo.closeIo(); // "ffmpeg ei käynnistynyt katvetilassa"
    }

    await sleep(50);
    await expect(
      withTimeout(stat(dir), 3000, "stat säiepoolin tukkeutumisen jälkeen"),
    ).resolves.toBeDefined();
  });

  it("päättää hylätyn open()-lupauksen sen sijaan että jättäisi sen roikkumaan ikuisesti", async () => {
    const fifo = new NarrationFifo(join(dir, "abandoned.pcm"));
    await fifo.prepare();
    const opening = fifo.open();
    await sleep(20);
    fifo.closeIo();
    // Ei saa heittää: molemmat kutsupaikat ovat jo hylänneet tämän lupauksen
    // Promise.racessa, joten rejection olisi käsittelemätön kesken lähetyksen.
    await expect(withTimeout(opening, 3000, "hylätty open()")).resolves.toBeUndefined();
  });

  /** Suoja korjauksen pahimmalle lopputulokselle: hiljainen lähetys. */
  it("normaali polku ennallaan: lukijan liityttyä ääni menee putkeen ja stop() sulkee siististi", async () => {
    const fifoPath = join(dir, "narration.pcm");
    const sinkPath = join(dir, "sink.raw");
    const fifo = new NarrationFifo(fifoPath);
    await fifo.prepare();

    const reader = spawn("sh", ["-c", 'cat "$1" > "$2"', "sh", fifoPath, sinkPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await withTimeout(fifo.open(), 5000, "fifo.open lukijan kanssa");
      fifo.enqueue(Buffer.alloc(FIFO_FRAME_BYTES * 3, 7));
      await sleep(300);
      expect(fifo.pendingClips).toBe(0);
      fifo.stop();
      await new Promise<void>((r) => reader.once("exit", () => r()));

      const written = readFileSync(sinkPath);
      // Tikitys on jatkuvaa (hiljaisuus kun mitään ei ole jonossa), joten
      // dataa on enemmän kuin klippi — olennaista on että klippi on siellä.
      expect(written.length).toBeGreaterThanOrEqual(FIFO_FRAME_BYTES * 3);
      expect(written.includes(Buffer.alloc(FIFO_FRAME_BYTES, 7))).toBe(true);
    } finally {
      reader.kill("SIGKILL");
    }
  });

  /** Herätysavaus tehdään vain jos avaus oli yhä jumissa. Kun avaus oli jo
   *  onnistunut, closeIo() ei saa avata putkeen ylimääräistä lukupäätä eikä
   *  heittää — muuten se sotkisi käynnissä olevan kirjoituksen. */
  it("closeIo() jo auenneelle putkelle sulkee kirjoituspään siististi eikä heitä", async () => {
    const fifoPath = join(dir, "reopen.pcm");
    const sinkPath = join(dir, "reopen-sink.raw");
    const fifo = new NarrationFifo(fifoPath);
    await fifo.prepare();

    const reader = spawn("sh", ["-c", 'cat "$1" > "$2"', "sh", fifoPath, sinkPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await withTimeout(fifo.open(), 5000, "fifo.open lukijan kanssa");
      fifo.enqueue(Buffer.alloc(FIFO_FRAME_BYTES, 3));
      await sleep(200);
      expect(() => fifo.closeIo()).not.toThrow();

      // Kirjoituspää sulkeutui: lukija saa EOF:n ja poistuu. Jos closeIo()
      // olisi avannut ylimääräisen lukupään, se ei estäisi tätä, mutta
      // roikkuva fd näkyisi tässä testissä respawnin jumina.
      const code = await withTimeout(
        new Promise<number | null>((r) => reader.once("exit", (c) => r(c))),
        5000,
        "lukijan EOF closeIo():n jälkeen",
      );
      expect(code).toBe(0);
      expect(readFileSync(sinkPath).length).toBeGreaterThan(0);

      // Ja putki on uudelleenkäytettävissä samalla tavalla kuin respawnissa.
      await expect(fifo.prepare()).resolves.toBeUndefined();
    } finally {
      reader.kill("SIGKILL");
    }
  });
});
