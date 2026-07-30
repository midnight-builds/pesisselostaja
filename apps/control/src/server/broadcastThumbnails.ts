import { renderThumbnail, type ThumbnailOptions } from "./thumbnail.js";
import { setThumbnail, type BroadcastPair } from "./youtube.js";
import type { BroadcastTexts } from "./templates.js";
import type { ThumbnailOutcome, ThumbnailOutcomes } from "../shared/types.js";

/** Thumbnailin asetus juuri luodulle lähetysparille (#130).
 *
 *  Oma moduulinsa eikä `index.ts`:n sisäinen apuri, koska tällä on yksi
 *  varsinainen takuu — **se ei koskaan heitä** — ja takuu jota ei voi testata
 *  ei ole takuu. `index.ts` on reittikerros ilman testisaumaa.
 *
 *  Miksi takuu on tärkeä: kun tätä kutsutaan, molemmat lähetykset ovat jo
 *  olemassa YouTubessa eikä luontia voi perua. Jos thumbnail-virhe kaataisi
 *  luontipyynnön, operaattori näkisi punaisen virheen onnistuneesta luonnista
 *  ja luultavasti painaisi "Luo lähetykset" uudelleen — mikä tuottaisi toisen
 *  parin. Se ei ole hypoteettista: `run/youtube-created.ndjson` sisältää kaksi
 *  paria samalle ottelulle 145905 (30.7.2026).
 *
 *  Ennen tätä `setThumbnail` oli olemassa ja sillä oli oma reittinsä, mutta
 *  luontipolku ei kutsunut kumpaakaan: thumbnail jäi asettamatta ilman yhtään
 *  virhettä, ja luonti raportoi onnistuneensa. */
export interface ThumbnailUploadDeps {
  render: (opts: ThumbnailOptions) => Promise<Buffer>;
  upload: (videoId: string, image: Buffer, contentType: string) => Promise<unknown>;
}

const defaultDeps: ThumbnailUploadDeps = {
  render: renderThumbnail,
  upload: (videoId, image, contentType) => setThumbnail(videoId, image, contentType),
};

export async function uploadPairThumbnails(
  pair: BroadcastPair,
  texts: BroadcastTexts,
  overrides: Partial<ThumbnailUploadDeps> = {}
): Promise<ThumbnailOutcomes> {
  const deps: ThumbnailUploadDeps = { ...defaultDeps, ...overrides };

  const one = async (videoId: string, narrated: boolean): Promise<ThumbnailOutcome> => {
    try {
      // Sama renderöijä ja samat tekstit kuin esikatselussa, joten operaattorin
      // hyväksymä kuva on se joka ladataan. `narrated` on ainoa ero.
      const image = await deps.render({
        headline: texts.thumbnailHeadline,
        datetime: texts.thumbnailDatetime,
        venue: texts.thumbnailVenue,
        narrated,
      });
      await deps.upload(videoId, image, "image/png");
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Lokiin myös, koska vastaus voi jäädä lukematta: operaattori näkee
      // kortin vain jos hän on yhä sivulla luonnin jälkeen.
      console.error(`[youtube] thumbnailin asetus epäonnistui (${videoId}): ${error}`);
      return { ok: false, error };
    }
  };

  // Peräkkäin eikä rinnakkain: molemmat ajavat saman Python-komposiitin ja
  // kuluttavat samaa YouTube-kiintiötä, eikä parin sekunnin säästö ole sen
  // arvoista että kiintiökirjanpito kilpailisi itsensä kanssa. Toisen
  // epäonnistuminen ei estä toista — puolikaskin on parempi kuin ei mitään.
  const normal = await one(pair.normal.videoId, false);
  const narrated = await one(pair.narrated.videoId, true);
  return { normal, narrated };
}
