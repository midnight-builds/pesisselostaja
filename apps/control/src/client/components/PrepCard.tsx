import { useCallback, useEffect, useState } from "react";
import type { Job, PreflightResult } from "../../shared/types";
import { hasBroadcastPair } from "../../shared/jobState";
import { parseYouTubeVideoId, watchUrlForVideo } from "../../shared/youtubeUrl";
import type { BroadcastTexts } from "../../server/templates";
import type { CreatedBroadcastPair, TemplatePreview, TitleOverrides } from "../api";
import { api, isAuthMissing } from "../api";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

/** Valmistelu — tilakortin sisältö ennen kuin ottelu alkaa (#184).
 *
 *  Kaksi peräkkäistä hetkeä, ei kahta korttia:
 *
 *  1. **Lähetysparia ei ole.** Esikatselu on pysyvästi näkyvissä painikkeen
 *     yläpuolella ja luonti vaatii kaksoisnapautuksen. Se on ottelupäivän ainoa
 *     vahvistusta vaativa teko: peruuttamaton ja ulospäin näkyvä (#171/1).
 *     Erillinen "olen tarkistanut" -kytkin on poissa — tuplaparin esti oikeasti
 *     kone, ei kytkin, joten sen tehtävä on koneella: kun työllä on jo pari,
 *     luonti ei ole painettavissa.
 *  2. **Pari on olemassa.** Linkit ja jakoviesti yhdessä paikassa, ja
 *     valmiustarkistus, jonka esteet ovat operaattorin kieltä. Ohjaamo sitoo
 *     itsensä valittuun otteluun ilman nappia ja kertoo tekonsa rivinä
 *     "Korjattiin: …" (#176).
 *
 *  Mitään teknistä ei näy: ei env-arvoja, ei tiedostoja, ei stream keytä — ei
 *  edes piilotettuna (#176). Jos sidonta ei mene automaattisesti oikein, se on
 *  korjattava vika eikä kenttä johon operaattori liimaa arvoja. */

interface Props {
  job: Job;
  notify: (kind: "ok" | "error", text: string) => void;
}

export function PrepCard({ job, notify }: Props) {
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [created, setCreated] = useState<CreatedBroadcastPair | null>(null);
  /** Voimassa olevat ohitukset: näillä palvelin muodostaa esikatselun ja niillä
   *  lähetykset luodaan. */
  const [overrides, setOverrides] = useState<TitleOverrides>({});
  /** Kenttiin kirjoitettu, vielä soveltamaton teksti. Erillään `overrides`ista,
   *  koska esikatselu päivittyy vasta napista — ja koska ero näiden kahden
   *  välillä on se, minkä perusteella YouTubeen kirjoittaminen on lukossa
   *  (#225): muuten nappi kirjoittaisi otsikon, jonka palvelin muodosti
   *  edellisistä arvoista. */
  const [draft, setDraft] = useState<TitleOverrides>({});
  const [authMissing, setAuthMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<string | null>(null);
  const [checks, setChecks] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(false);
  /** Mitä otsikoita YouTubeen viimeksi kirjoitettiin, tai null. Ohitukset eivät
   *  säily työssä (ks. #231), joten kortin uudelleenavaus näyttäisi taas
   *  tulospalvelun nimillä muodostetun otsikon — vaikka YouTubessa on toinen.
   *  Tämä rivi on se, mikä estää kortin väittämästä väärää: se kertoo mitä
   *  KIRJOITETTIIN, erillään siitä mitä esikatselu ehdottaa. */
  const [written, setWritten] = useState<{
    narrated: string;
    raw: string | null;
    /** Menikö kansikuva perille molempiin. */
    thumbnails: boolean;
  } | null>(null);

  // Työ on totuus siitä onko pari olemassa; juuri luotu pari on mukana siksi,
  // että palvelimen seuraava kehys on sekunteja päässä eikä luonti saa näyttää
  // menneen hukkaan sillä välin.
  const videoId = job.targetVideoId ?? created?.narrated.videoId ?? null;
  const streamKey = job.targetStreamKey ?? created?.narrated.streamKey ?? null;
  // Pari on olemassa vasta kun sillä on MOLEMMAT: video ja avain (#203).
  // Pelkkä videoId siirsi kortin "pari on olemassa" -haaraan, jolloin
  // luontipainike katosi pysyvästi samalla kun valmiustarkistus neuvoi
  // luomaan lähetysparin — teon, jonka käyttöliittymä oli juuri poistanut.
  // Käsikenttiä ei ole enää (#176), joten kentällä ei ollut mitään tehtävissä.
  //
  // Sääntö on jaettu palvelimen tuplaparin eston kanssa (#204): kaksi eri
  // rajaa tuottaisi tilan, jossa kortti tarjoaa luontia jonka palvelin torjuu.
  const hasPair = hasBroadcastPair({ targetVideoId: videoId, targetStreamKey: streamKey });
  // Osoite apurista eikä käsin: sama muoto on jo neljässä paikassa, ja käsin
  // kirjoitettuna ne eroaisivat toisistaan hiljaa (#228).
  const narratedUrl = videoId ? watchUrlForVideo(videoId) : null;
  const rawUrl = job.sourceUrl ?? created?.normal.watchUrl ?? null;

  const same = (a: TitleOverrides, b: TitleOverrides) =>
    a.homeTeam === b.homeTeam && a.awayTeam === b.awayTeam && a.shortVenue === b.shortVenue;
  /** Kentissä on tekstiä, jota esikatselu ei vielä tunne. */
  const dirty = !same(draft, overrides);

  const fail = useCallback(
    (err: unknown) => {
      if (isAuthMissing(err)) {
        setAuthMissing(true);
        return;
      }
      notify("error", err instanceof Error ? err.message : String(err));
    },
    [notify],
  );

  // Esikatselu haetaan itsestään: se ei luo mitään YouTubeen (pelkkää tekstiä),
  // ja jos sen joutuisi pyytämään napista, luonti olisi kahden napin päässä
  // eikä yhden — mikä on juuri se hitaus, jonka takia tekstejä ei katsottaisi.
  //
  // Haetaan MYÖS parin olemassa ollessa (#225): otsikon muuttaminen luonnin
  // jälkeen tarvitsee saman tekstin, jonka luontikin sai — se on palvelimen
  // muodostama, ei clientissä kasattu, jotta YouTubeen kirjoitettu otsikko on
  // sama jonka operaattori näki ruudulla.
  useEffect(() => {
    let cancelled = false;
    api.templatesPreview({ jobId: job.id, overrides }).then(
      (result) => !cancelled && (setPreview(result), setAuthMissing(false)),
      (err: unknown) => !cancelled && fail(err),
    );
    return () => {
      cancelled = true;
    };
  }, [job.id, overrides, hasPair, fail]);

  // Jakoviesti muodostetaan aina uudelleen työn linkeistä (#131): luontivastaus
  // näkyy vain kerran, ja viesti jaetaan useaan ryhmään eri aikoina.
  useEffect(() => {
    if (!hasPair) return;
    let cancelled = false;
    api.jobShare(job.id).then(
      (msg) => !cancelled && msg.linksReady && setShare(msg.shareMessage),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [job.id, hasPair, created]);

  const runChecks = useCallback(async () => {
    setChecking(true);
    try {
      setChecks(await api.preflight(job.id));
    } catch (err) {
      fail(err);
    } finally {
      setChecking(false);
    }
  }, [job.id, fail]);

  // Valmiustarkistus vasta kun on jotain tarkistettavaa: ennen lähetysparia
  // jokainen rivi kertoisi puuttuvasta sidonnasta, mikä on tässä vaiheessa
  // normaali tila eikä este.
  useEffect(() => {
    if (!hasPair) return;
    void runChecks();
  }, [hasPair, runChecks]);

  const create = async () => {
    if (busy || hasPair) return;
    setBusy(true);
    try {
      const pair = await api.createBroadcasts({ jobId: job.id, overrides });
      setCreated(pair);
      notify("ok", "Lähetyspari luotu");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** Kirjoittaa otsikon MOLEMPIIN lähetyksiin (#225).
   *
   *  Ketju oli valmis viimeistä metriä myöten — palvelimen `PATCH
   *  /api/youtube/videos/:id` ja `api.patchVideo` olivat olemassa, mutta yksikään
   *  komponentti ei kutsunut niitä. Operaattorin ainoat keinot olivat YouTube
   *  Studio ja käsin kirjoitettu HTTP-kutsu.
   *
   *  **Rajaus.** Tämä ajetaan vain valmistelusta: `PrepCard` renderöidään
   *  ainoastaan tiloissa `draft` ja `scheduled`, eli ennen kuin lähetys on
   *  alkanut. Raakalähetykseen ei siis kosketa ottelun ollessa kesken
   *  (CLAUDE.md) — otsikko on metatietoa eikä lähetyksen tilaa, ja ohjaamo on
   *  itse luonut molemmat lähetykset muutamaa minuuttia aiemmin.
   *
   *  Selostettu ensin: se on se lähetys, jonka linkki jaetaan. Jos
   *  raakalähetyksen päivitys kaatuu, selostettu on jo oikein ja rivi kertoo
   *  kumpi jäi — hiljainen osittainen onnistuminen olisi pahin lopputulos. */
  const updateTitles = async () => {
    if (busy || !preview || !videoId) return;
    setBusy(true);
    try {
      const narratedTitle = preview.texts.narratedTitle;
      await api.patchVideo(videoId, { title: narratedTitle });
      // Raakalähetyksen videoId ei ole työssä omana kenttänään, vaan sen
      // osoitteessa. Jäsentymätön osoite (operaattorin käsin liittämä muoto,
      // jota emme tunne) ei ole virhe: silloin sitä lähetystä ei vain päivitetä,
      // ja rivi sanoo sen ääneen.
      const rawId = parseYouTubeVideoId(rawUrl);
      let rawTitle: string | null = null;
      if (rawId) {
        await api.patchVideo(rawId, { title: preview.texts.title });
        rawTitle = preview.texts.title;
      }
      // Kansikuvassa lukee sama ottelupari kuin otsikossa, joten pelkän
      // otsikon vaihtaminen jättäisi lähetyksen kertomaan kahta eri tarinaa.
      // Parasta yritystä eikä ehtoa: kuvan renderöinti on ainoa osa, joka voi
      // kaatua ilman että mikään muu on vialla (#130), eikä sen kaatuminen saa
      // kumota otsikkoa joka on jo perillä.
      const thumbnails = await Promise.all(
        [
          { videoId, narrated: true },
          ...(rawId ? [{ videoId: rawId, narrated: false }] : []),
        ].map((target) =>
          api
            .setThumbnail(target.videoId, {
              headline: preview.texts.thumbnailHeadline,
              datetime: preview.texts.thumbnailDatetime,
              venue: preview.texts.thumbnailVenue,
              narrated: target.narrated,
            })
            .then(
              () => true,
              () => false,
            ),
        ),
      );
      setWritten({ narrated: narratedTitle, raw: rawTitle, thumbnails: thumbnails.every(Boolean) });
      notify("ok", rawId ? "Otsikot päivitetty YouTubeen" : "Selostetun lähetyksen otsikko päivitetty");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (!hasPair) {
    return (
      <div className="prep">
        {authMissing ? (
          <p className="prep__note is-fail">
            Google-yhteys puuttuu — lähetyksiä ei voi luoda ennen kuin se on kunnossa.
          </p>
        ) : preview ? (
          <>
            <dl className="prep__texts">
              <dt>Selostettu lähetys</dt>
              <dd>{preview.texts.narratedTitle}</dd>
              <dt>Raakalähetys</dt>
              <dd>{preview.texts.title}</dd>
              <dt>Alkaa</dt>
              <dd>{preview.texts.scheduledLocal}</dd>
            </dl>
            <details className="prep__edit">
              <summary>Muokkaa otsikkoa</summary>
              <TitleFields value={draft} texts={preview.texts} onChange={setDraft} />
              {/* Esikatselu päivittyy vasta napista: joka näppäimenpainalluksella
                  haettuna teksti hyppisi silmien alla juuri kun sitä luetaan. */}
              <button
                type="button"
                className="btn btn--ghost btn--wide"
                disabled={busy || !dirty}
                onClick={() => setOverrides(draft)}
              >
                Päivitä esikatselu
              </button>
            </details>
            <ConfirmButton
              className="btn--wide btn--tall"
              label="Luo lähetyspari"
              confirmLabel="Vahvista: luo lähetyspari"
              disabled={busy}
              onConfirm={() => void create()}
            />
            <p className="prep__note">
              Luo YouTubeen kaksi lähetystä. Jo jaettua linkkiä ei saa pois, joten tämä kysytään kahdesti.
            </p>
          </>
        ) : (
          <p className="prep__note">Valmistellaan tekstejä…</p>
        )}
      </div>
    );
  }

  return (
    <div className="prep">
      <p className="prep__note">Lähetyspari on luotu.</p>
      {/* Linkit luetaan TYÖSTÄ eikä luontivastauksesta: vastaus on olemassa vain
          sen selainistunnon ajan, jossa pari luotiin, ja kortti on sama myös
          seuraavalla avauksella. */}
      <div className="prep__links">
        {narratedUrl && (
          <a className="linkbtn" href={narratedUrl} target="_blank" rel="noreferrer">
            Avaa selostettu lähetys
          </a>
        )}
        {rawUrl && (
          <a className="linkbtn" href={rawUrl} target="_blank" rel="noreferrer">
            Avaa raakalähetys
          </a>
        )}
      </div>
      {/* Thumbnail on ainoa osa luontia joka voi epäonnistua ILMAN että luonti
          epäonnistuu — lähetykset ovat jo olemassa (#130). Hiljainen niely
          johtaisi siihen että pari luodaan uudelleen turhaan. */}
      {created?.thumbnails && (!created.thumbnails.normal.ok || !created.thumbnails.narrated.ok) && (
        <p className="prep__note is-fail">
          Kansikuva jäi asettamatta. Lähetykset on silti luotu — älä luo niitä uudelleen.
        </p>
      )}

      {/* Otsikon muutos luonnin jälkeen (#225). Kokoon taitettuna, koska otsikko
          on oikein useimmiten — mutta olemassa, koska ennen tätä sitä ei saanut
          muutetuksi ohjaamosta lainkaan, vaikka palvelin ja client-kerros
          osasivat sen jo: yksikään komponentti ei kutsunut `patchVideo`ta. */}
      {preview && (
        <details className="prep__edit" data-testid="retitle">
          <summary>Muokkaa otsikkoa</summary>
          <dl className="prep__texts">
            <dt>Selostettu lähetys</dt>
            <dd data-testid="retitle-narrated">{preview.texts.narratedTitle}</dd>
            <dt>Raakalähetys</dt>
            <dd>{preview.texts.title}</dd>
          </dl>
          <TitleFields value={draft} texts={preview.texts} onChange={setDraft} />
          {/* Kaksi tekoa, kaksi nappia, ja kirjoitus on lukossa niin kauan kuin
              kentissä on soveltamatonta tekstiä. Yksi nappi kirjoittaisi sen
              otsikon, jonka palvelin muodosti EDELLISISTÄ arvoista — eli tekisi
              tismalleen sen mitä tämä tiketti moittii: näyttäisi muuttavansa
              jotain mitä se ei muuta. */}
          <button
            type="button"
            className="btn btn--ghost btn--wide"
            disabled={busy || !dirty}
            onClick={() => setOverrides(draft)}
          >
            Päivitä esikatselu
          </button>
          <button
            type="button"
            className="btn btn--primary btn--wide"
            disabled={busy || dirty}
            onClick={() => void updateTitles()}
          >
            {busy ? "Päivitetään…" : "Kirjoita otsikot YouTubeen"}
          </button>
          {dirty ? (
            <p className="prep__note">Päivitä esikatselu ensin — YouTubeen kirjoitetaan se otsikko, joka yllä lukee.</p>
          ) : written ? (
            <p className="prep__note" data-testid="retitle-written">
              Kirjoitettiin YouTubeen: {written.narrated}
              {written.raw === null &&
                " — raakalähetyksen otsikko jäi ennalleen, koska sen osoitteesta ei löydy video-id:tä."}
              {!written.thumbnails && " Kansikuva jäi vanhaksi; siinä lukee yhä entinen ottelupari."}
            </p>
          ) : (
            <p className="prep__note">
              Yllä olevat tekstit ovat ehdotus, eivät se mitä YouTubessa nyt lukee. Nappi kirjoittaa ne
              molempiin lähetyksiin.
            </p>
          )}
        </details>
      )}

      {share && (
        <div className="prep__share">
          <pre className="textblock" data-testid="share-message">
            {share}
          </pre>
          <CopyButton className="btn--wide" text={share} label="Kopioi jaettava viesti" />
        </div>
      )}

      <Readiness result={checks} checking={checking} onRecheck={() => void runChecks()} />
    </div>
  );
}

/** Otsikon tiedot joita tulospalvelu ei tunne (#95) — pelkät kentät.
 *
 *  Kokoontaittaminen ja napit ovat kutsujalla, koska kenttiä käytetään nyt
 *  kahdessa hetkessä (#225): ennen luontia esikatselun säätämiseen, luonnin
 *  jälkeen YouTubessa olevan otsikon korjaamiseen. Teot ovat eri, kentät samat
 *  — ja luonnos, joka ei ole vielä voimassa, kuuluu sille joka tietää mitä
 *  sillä seuraavaksi tehdään.
 *
 *  Placeholderit tulevat käsillä olevasta ottelusta, eivät esimerkistä (#221).
 *  Kentät ovat tyhjiä siihen asti että operaattori kirjoittaa niihin, ja
 *  puhelimen ruudulla harmaa esimerkkiteksti lukeutuu kentän arvoksi: kun se
 *  oli kovakoodattu toisen ottelun joukkueiksi, vaikutelma oli että ohjaamo on
 *  sitonut työn väärään otteluun. Palvelin kertoo esikatselussa parin puolikkaat
 *  valmiiksi (`teamPair`: koti ensin, vieras toisena), joten päättelyä ei tehdä täällä.
 *  Tuntematon arvo jätetään tyhjäksi — väärä placeholder on pahempi kuin ei
 *  placeholderia. */
function TitleFields({
  value,
  texts,
  onChange,
}: {
  value: TitleOverrides;
  texts: BroadcastTexts;
  onChange: (next: TitleOverrides) => void;
}) {
  const trimmed = (v: string) => (v.trim() ? v.trim() : undefined);

  return (
    <>
      <label className="field">
        <span className="field__label">Kotijoukkue</span>
        <input
          className="field__input"
          value={value.homeTeam ?? ""}
          placeholder={texts.homeTeam}
          onChange={(e) => onChange({ ...value, homeTeam: trimmed(e.target.value) })}
        />
      </label>
      <label className="field">
        <span className="field__label">Vierasjoukkue</span>
        <input
          className="field__input"
          value={value.awayTeam ?? ""}
          placeholder={texts.awayTeam}
          onChange={(e) => onChange({ ...value, awayTeam: trimmed(e.target.value) })}
        />
      </label>
      <label className="field">
        <span className="field__label">Paikka lyhyesti</span>
        <input
          className="field__input"
          value={value.shortVenue ?? ""}
          placeholder={texts.thumbnailVenue}
          onChange={(e) => onChange({ ...value, shortVenue: trimmed(e.target.value) })}
        />
      </label>
      {/* #221:n jälkihoito: placeholder kertoo nyt totuuden, mutta EI sitä mitä
          tyhjä kenttä tarkoittaa. Harmaa teksti on puhelimen ruudulla yhä
          kahden lukutavan välissä ("tämä on arvo" / "tämä on esimerkki"), ja
          juuri se epäselvyys sai operaattorin epäilemään väärää sidontaa. */}
      <p className="field__hint">
        Tyhjä kenttä tarkoittaa harmaana näkyvää nimeä. Kirjoita vain se, minkä haluat toisin.
      </p>
    </>
  );
}

/** Valmiustarkistus. Esteet ja ohjaamon omat korjaukset näkyvät riveinä;
 *  kunnossa olevat lasketaan yhteen, koska kahdeksan vihreää riviä puhelimen
 *  ruudulla piilottaa sen yhden, joka ei ole. */
function Readiness({
  result,
  checking,
  onRecheck,
}: {
  result: PreflightResult | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  if (!result) {
    return <p className="prep__note">{checking ? "Tarkistetaan valmiutta…" : ""}</p>;
  }
  const notable = result.checks.filter((c) => c.status !== "ok" || c.fixed);
  const quiet = result.checks.length - notable.length;

  return (
    <div className="prep__ready">
      <p className={`prep__verdict ${result.blockers > 0 ? "is-fail" : ""}`}>
        {result.blockers > 0
          ? `${result.blockers === 1 ? "Yksi este" : `${result.blockers} estettä`} ennen käynnistystä:`
          : "Valmiina käynnistymään, kun raakalähetys alkaa."}
      </p>
      {notable.length > 0 && (
        <ul className="checks">
          {notable.map((check) => (
            <li key={check.name} className={`check check--${check.fixed ? "fixed" : check.status}`}>
              <span className="check__mark" aria-hidden="true">
                {check.fixed ? "↺" : check.status === "fail" ? "✗" : "⚠"}
              </span>
              <span className="check__detail">{check.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="linkbtn" disabled={checking} onClick={onRecheck}>
        {checking ? "Tarkistetaan…" : quiet > 0 ? `Tarkista uudelleen (${quiet} kunnossa)` : "Tarkista uudelleen"}
      </button>
    </div>
  );
}
