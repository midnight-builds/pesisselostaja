/** Selostusklipin äänenvoimakkuuden skaalaus PCM-tasolla (#244).
 *
 *  Miksi tämä on olemassa: selostuksen gain leivotaan ffmpegin
 *  filtterigraafiin relayn käynnistyksessä (`buildMixFilterComplex`,
 *  `[1:a]volume=…`), eikä graafia voi muuttaa käynnistämättä ffmpegiä
 *  uudelleen. Ottelussa 136770 (16.8.2026) kentän äänet olivat liian hiljaa
 *  suhteessa selostukseen, ja ainoa keino oli `.env.relay` + restart — eli
 *  katko selostettuun lähetykseen kesken ottelun, ja äänitasapainon hakeminen
 *  voi vaatia useamman yrityksen.
 *
 *  Klippikohtainen skaalaus ratkaisee sen ilman katkoa: relay kertoo klipin
 *  näytteet ennen kuin klippi menee FIFOon, joten uusi arvo vaikuttaa
 *  seuraavasta klipistä alkaen. ffmpegin graafiin EI kosketa — se on eri
 *  seudun muutos (ks. #68), eikä sitä avata rinnakkain tämän kanssa.
 *
 *  Kentän ääni ei kulje relayn käsien läpi PCM:nä, joten sitä ei voi säätää
 *  täältä. Suhteen säätöön riittää silti toisen puolen liikuttelu.
 */

/** Näytemuoto FIFOssa: 48 kHz, stereo, s16le (ks. NarrationFifo). */
const BYTES_PER_SAMPLE = 2;
const SAMPLE_MIN = -32768;
const SAMPLE_MAX = 32767;

export interface PcmGainResult {
  pcm: Buffer;
  /** Montako näytettä leikkautui rajaan. 0 kun kerroin on ≤ 1. */
  clipped: number;
}

/** Kertoo s16le-näytteet kertoimella ja leikkaa rajaan.
 *
 *  Kerroin 1 palauttaa saman puskurin sellaisenaan — ei kopiota eikä
 *  läpikäyntiä. Tämä on tavallisin tapaus (operaattori ei ole säätänyt
 *  mitään), joten oletuspolku ei maksa mitään.
 *
 *  Leikkaus on kova (clamp), ja siksi `clipped` palautetaan: yli 1:n kerroin
 *  voi viedä näytteet int16:n rajan yli ennen kuin ffmpegin `alimiter` ehtii
 *  nähdä niitä, ja se kuuluu särönä. Kutsuja kertoo siitä operaattorille sen
 *  sijaan että vaimeneva särö jäisi lokiin näkymättömäksi.
 *
 *  Pariton tavumäärä katkaistaan parilliseen: puolikas näyte ei ole näyte,
 *  eikä sen lukeminen `readInt16LE`llä olisi määriteltyä. Käytännössä tätä ei
 *  tapahdu (TTS tuottaa kokonaisia kehyksiä), mutta puskurin pituus tulee
 *  ulkopuolelta eikä vaimea rappeutuminen maksa täällä mitään. */
export function applyPcmGain(pcm: Buffer, factor: number): PcmGainResult {
  if (!Number.isFinite(factor) || factor === 1) return { pcm, clipped: 0 };
  const usable = pcm.length - (pcm.length % BYTES_PER_SAMPLE);
  const out = Buffer.allocUnsafe(usable);
  let clipped = 0;
  for (let i = 0; i < usable; i += BYTES_PER_SAMPLE) {
    const scaled = Math.round(pcm.readInt16LE(i) * factor);
    let value = scaled;
    if (scaled > SAMPLE_MAX) {
      value = SAMPLE_MAX;
      clipped++;
    } else if (scaled < SAMPLE_MIN) {
      value = SAMPLE_MIN;
      clipped++;
    }
    out.writeInt16LE(value, i);
  }
  return { pcm: out, clipped };
}
