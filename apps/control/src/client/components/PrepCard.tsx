import { useCallback, useEffect, useState } from "react";
import type { Job, PreflightResult } from "../../shared/types";
import { hasBroadcastPair } from "../../shared/jobState";
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
  const [overrides, setOverrides] = useState<TitleOverrides>({});
  const [authMissing, setAuthMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<string | null>(null);
  const [checks, setChecks] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(false);

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
  const narratedUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
  const rawUrl = job.sourceUrl ?? created?.normal.watchUrl ?? null;

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
  useEffect(() => {
    if (hasPair) return;
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
            <TitleFields value={overrides} disabled={busy} onChange={setOverrides} />
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

/** Otsikon tiedot joita tulospalvelu ei tunne (#95). Kokoon taitettuna, koska
 *  ne ovat oikein useimmiten: normaalipolku on esikatselu + yksi nappi. */
function TitleFields({
  value,
  disabled,
  onChange,
}: {
  value: TitleOverrides;
  disabled: boolean;
  onChange: (next: TitleOverrides) => void;
}) {
  const [draft, setDraft] = useState<TitleOverrides>(value);
  const trimmed = (v: string) => (v.trim() ? v.trim() : undefined);

  return (
    <details className="prep__edit">
      <summary>Muokkaa otsikkoa</summary>
      <label className="field">
        <span className="field__label">Oma joukkue</span>
        <input
          className="field__input"
          value={draft.teamLabel ?? ""}
          placeholder="Pesä Ysit F-pojat"
          onChange={(e) => setDraft({ ...draft, teamLabel: trimmed(e.target.value) })}
        />
      </label>
      <label className="field">
        <span className="field__label">Vastustaja</span>
        <input
          className="field__input"
          value={draft.opponent ?? ""}
          placeholder="IPV"
          onChange={(e) => setDraft({ ...draft, opponent: trimmed(e.target.value) })}
        />
      </label>
      <label className="field">
        <span className="field__label">Paikka lyhyesti</span>
        <input
          className="field__input"
          value={draft.shortVenue ?? ""}
          placeholder="Naperoleiri Liperi"
          onChange={(e) => setDraft({ ...draft, shortVenue: trimmed(e.target.value) })}
        />
      </label>
      {/* Esikatselu päivittyy vasta napista: joka näppäimenpainalluksella
          haettuna teksti hyppisi silmien alla juuri kun sitä luetaan. */}
      <button type="button" className="btn btn--ghost btn--wide" disabled={disabled} onClick={() => onChange(draft)}>
        Päivitä esikatselu
      </button>
    </details>
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
