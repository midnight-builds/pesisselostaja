/** Issue #57, mikserin puoli: katto on olemassa vain jos se on johdotettu
 *  configista FIFOon asti ja jos operaattori kuulee kun se puree.
 *
 *  Jonon oma pudotuslogiikka on testattu `narrationFifo.test.ts`:ssä; tässä
 *  koetellaan johdotus ja se, ettei lyhentäminen tapahdu hiljaa. */

import { describe, it, expect, afterEach } from "vitest";
import { FfmpegMixer } from "../src/ffmpegMixer.js";
import { setLogSink } from "../src/log.js";

afterEach(() => setLogSink(null));

/** 20 ms 48 kHz/stereo/s16le -kehyksiä. */
const FRAME_BYTES = 3840;
const clip = (frames: number) => Buffer.alloc(FRAME_BYTES * frames);

function mixerWithCap(maxQueuedNarrationMs: number): FfmpegMixer {
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "",
    streamKey: "",
    narrationGain: 1,
    maxQueuedNarrationMs,
    fifoPath: "/tmp/pesis-test-cap-unused.pcm",
  });
}

function captureLog(): { code: string | null; msg: string }[] {
  const lines: { code: string | null; msg: string }[] = [];
  setLogSink((entry) => lines.push({ code: entry.code ?? null, msg: entry.msg }));
  return lines;
}

describe("selostusjonon katto mikserissä (#57)", () => {
  it("sanoo ääneen kun jonoa jouduttiin lyhentämään", () => {
    // Hiljaa lyhennetty lähetys on pahempi kuin pitkä: operaattori ei voi
    // arvioida selostusta, jos hän ei tiedä mitä siitä puuttuu.
    const lines = captureLog();
    const mixer = mixerWithCap(100); // 5 kehystä

    mixer.enqueueNarration(clip(3), "droppable");
    mixer.enqueueNarration(clip(3), "droppable");

    const trimmed = lines.filter((l) => l.code === "narration.queue_trimmed");
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.msg).toMatch(/pudotettiin 1 ohitettavaa klippiä/);
  });

  it("vaikenee kun jono pysyy katon alla", () => {
    const lines = captureLog();
    const mixer = mixerWithCap(10_000);

    for (let i = 0; i < 5; i++) mixer.enqueueNarration(clip(3), "droppable");

    expect(lines.filter((l) => l.code === "narration.queue_trimmed")).toHaveLength(0);
  });

  it("kertoo erikseen kun katto ei riittänyt, koska loput ovat kriittisiä", () => {
    const lines = captureLog();
    const mixer = mixerWithCap(100); // 5 kehystä

    mixer.enqueueNarration(clip(4), "critical"); // juoksu
    mixer.enqueueNarration(clip(4), "critical"); // toinen juoksu
    mixer.enqueueNarration(clip(1), "droppable"); // lyöjänvaihto

    const trimmed = lines.filter((l) => l.code === "narration.queue_trimmed");
    expect(trimmed).toHaveLength(1);
    // Ohitettava lähti, mutta kaksi juoksua on yhä yli katon — eikä niitä
    // leikata. Rivin on kerrottava se, ettei katto näytä toimineen kun se ei
    // toiminut.
    expect(trimmed[0]?.msg).toMatch(/yli katon \(loput kriittisiä\)/);
  });

  it("ei pudota mitään kun kattoa ei ole asetettu", () => {
    const lines = captureLog();
    const mixer = mixerWithCap(0);

    for (let i = 0; i < 20; i++) mixer.enqueueNarration(clip(5), "droppable");

    expect(lines.filter((l) => l.code === "narration.queue_trimmed")).toHaveLength(0);
    expect(mixer.pendingClips).toBe(20);
  });

  it("kohtelee luokittelematonta klippiä kriittisenä", () => {
    // Oletus on turvallinen: uusi selostus ei päädy pudotettavaksi siksi,
    // että kukaan ei muistanut luokitella sitä.
    const mixer = mixerWithCap(100);

    mixer.enqueueNarration(clip(4));
    mixer.enqueueNarration(clip(4));

    expect(mixer.pendingClips).toBe(2);
  });
});
