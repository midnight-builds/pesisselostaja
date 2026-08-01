import { useCallback, useEffect, useState } from "react";
import type { CreatedBroadcastPair, PrivacyStatus, TemplatePreview, TitleOverrides } from "../api";
import { api, isAuthMissing } from "../api";
import type { Job } from "../../shared/types";
import { fiTime } from "../format";
import { AuthMissingNotice } from "./AuthMissingNotice";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";
import { Field } from "./Field";
import { ThumbnailPair } from "./ThumbnailPair";

/** Lähetysten luonti: preview first, create second, and never the other way
 *  round.
 *
 *  Creating the pair is the one action in this whole app that is visible to
 *  people outside it and cannot be taken back: two broadcasts appear on the
 *  channel, and even deleting them afterwards leaves a link that was already
 *  shared. So the button that does it stays behind two gates:
 *
 *    1. the texts must be on screen above the button (POST
 *       .../templates/preview creates nothing — it is pure text, so previewing
 *       is free, and since #129 it runs by itself as soon as the job and the
 *       title fields settle),
 *    2. and the button itself takes two taps (ConfirmButton).
 *
 *  The third gate — an "olen tarkistanut" tick — was removed on the operator's
 *  decision (1.8.2026) as one step too many in a flow that is already a
 *  checklist. Neither remaining gate is decoration: the preview makes the check
 *  possible, the double tap makes a pocket tap harmless. A duplicate pair HAS
 *  been created for real once (match 145905), which is why the preview stays
 *  directly above the button rather than behind a press.
 *
 *  The card is used in two ways: given a `job` it renders for that job and
 *  drops its own picker (Työ-välilehti, #129), without one it fetches the job
 *  list and asks which match. */

const PRIVACY_OPTIONS: Array<{ value: PrivacyStatus; label: string }> = [
  { value: "unlisted", label: "Piilotettu — vain linkin saaneet" },
  { value: "public", label: "Julkinen — näkyy kanavalla" },
  { value: "private", label: "Yksityinen — vain oma tili" },
];

interface Props {
  active: boolean;
  notify: (kind: "ok" | "error", text: string) => void;
  onGoToAuth: () => void;
  /** Bumped when the connection state changes, to retry after connecting. */
  reloadToken: number;
  /** The job the surrounding view already has open (#129). Given one, the card
   *  drops its own match picker — two pickers for the same choice is how you
   *  preview job A and create job B. */
  job?: Job | null;
  /** Called after a successful create, so the view can refresh the job it
   *  shows: the links and the stream key land on the job server-side. */
  onCreated?: () => void;
}

export function BroadcastCreateCard({ active, notify, onGoToAuth, reloadToken, job: externalJob, onCreated }: Props) {
  const ownsJobChoice = externalJob === undefined;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState<string>("");
  const [privacy, setPrivacy] = useState<PrivacyStatus>("unlisted");
  const [playlistOverride, setPlaylistOverride] = useState("");
  /** Otsikon tiedot joita tulospalvelu ei tunne. Ilman näitä ensimmäinen
   *  UI:sta luotu lähetys sai otsikon "Pesä Ysit, Lappeenranta - Espoon Pesis,
   *  29.7.2026 04 - Liperin kirkonkylän kenttä 4| LEIRITUOTANTO" (#95). */
  const [teamLabel, setTeamLabel] = useState("");
  const [opponent, setOpponent] = useState("");
  const [shortVenue, setShortVenue] = useState("");
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [created, setCreated] = useState<CreatedBroadcastPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const list = await api.jobs();
      setJobs(list);
      setJobId((current) => (current && list.some((j) => j.id === current) ? current : (list.at(-1)?.id ?? "")));
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }, [notify]);

  useEffect(() => {
    if (!active || !ownsJobChoice) return;
    void loadJobs();
  }, [active, ownsJobChoice, loadJobs, reloadToken]);

  const job = ownsJobChoice ? (jobs.find((j) => j.id === jobId) ?? null) : (externalJob ?? null);

  // Changing the job invalidates everything downstream: previewing job A and
  // then creating job B is exactly the mistake this card exists to prevent.
  useEffect(() => {
    setPreview(null);
    setCreated(null);
  }, [job?.id]);

  // Editing a title field after previewing would leave the texts on screen
  // describing something else than what gets created — so the preview goes
  // with it, and the auto-preview below fetches a fresh one.
  useEffect(() => {
    setPreview(null);
  }, [teamLabel, opponent, shortVenue]);

  // Esikatselu ajetaan itsestään (#129): se ei luo mitään YouTubeen, joten
  // erillinen painallus oli vain este sen ja luonnin välissä. Pieni viive,
  // jotta otsikkokenttiin kirjoittaminen ei laukaise hakua joka näppäimestä.
  // Vain kun kortti on näkyvissä eikä pari ole jo luotu.
  useEffect(() => {
    if (!active || !job || preview || created || busy) return;
    const timer = setTimeout(() => void runPreview(), 600);
    return () => clearTimeout(timer);
    // runPreview luetaan tuoreena joka ajolla; sen sulkeuma riippuu samoista
    // arvoista kuin tämä efekti.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, job?.id, preview, created, busy, teamLabel, opponent, shortVenue]);


  /** Tyhjä kenttä = ei ohitusta; palvelin päättelee nimen itse. */
  const overrides = (): TitleOverrides => ({
    ...(teamLabel.trim() ? { teamLabel: teamLabel.trim() } : {}),
    ...(opponent.trim() ? { opponent: opponent.trim() } : {}),
    ...(shortVenue.trim() ? { shortVenue: shortVenue.trim() } : {}),
  });

  const runPreview = async () => {
    if (!job) return;
    setBusy(true);
    setAuthError(null);
    try {
      const result = await api.templatesPreview({ jobId: job.id, overrides: overrides() });
      setPreview(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthMissing(err)) setAuthError(message);
      else notify("error", message);
    } finally {
      setBusy(false);
    }
  };

  const runCreate = async () => {
    if (!job || !preview) return;
    setBusy(true);
    setAuthError(null);
    try {
      const result = await api.createBroadcasts({
        jobId: job.id,
        privacy,
        overrides: overrides(),
        ...(playlistOverride.trim() ? { playlistId: playlistOverride.trim() } : {}),
      });
      setCreated(result);
      notify("ok", "Lähetykset luotu YouTubeen");
      // Työlle kirjautui palvelimella raakalähetyksen URL ja selostetun stream
      // key; näkymän on luettava se uudelleen, tai operaattori katsoo tyhjiä
      // kenttiä juuri luodun parin vieressä.
      onCreated?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthMissing(err)) setAuthError(message);
      else notify("error", message);
    } finally {
      setBusy(false);
    }
  };

  if (ownsJobChoice && jobs.length === 0) {
    return (
      <section className="card">
        <h2 className="card__title">Lähetysten luonti</h2>
        <p className="muted">Ei töitä. Valitse ottelu Ottelut-välilehdeltä ensin.</p>
      </section>
    );
  }
  if (!ownsJobChoice && !job) return null;

  return (
    <>
      <section className="card">
        <h2 className="card__title">Työ</h2>
        <div className="field">
          <span className="field__label">Mille ottelulle</span>
          <select className="field__input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {fiTime(j.startsAt)} {j.home}–{j.away}
              </option>
            ))}
          </select>
        </div>
        {job && (
          <p className="muted">
            {[job.seriesName, job.stadium].filter(Boolean).join(" · ") || "—"} · ottelu {job.matchId}
          </p>
        )}

        {/* Kolme kenttää joita pesistulokset ei tiedä. Ne muuttavat otsikkoa,
            thumbnailia JA jaettavaa viestiä, joten ne kysytään ennen
            esikatselua — esikatselu näyttää tuloksen. */}
        <Field
          label="Oma joukkue otsikossa (valinnainen)"
          value={teamLabel}
          placeholder={job ? job.home : "Pesä Ysit F-pojat"}
          hint="Vakiintunut muoto, esim. Pesä Ysit F-pojat. Tyhjänä käytetään tulospalvelun nimeä."
          onChange={setTeamLabel}
        />
        <Field
          label="Vastustaja otsikossa (valinnainen)"
          value={opponent}
          placeholder={job ? job.away : "IPV"}
          hint="Lyhenne, esim. IPV."
          onChange={setOpponent}
        />
        <Field
          label="Lyhyt paikka (valinnainen)"
          value={shortVenue}
          placeholder="Naperoleiri Liperi"
          hint="Otsikkoon ja thumbnailiin. Tyhjänä käytetään kentän koko nimeä."
          onChange={setShortVenue}
        />

        <button
          type="button"
          className="btn btn--wide"
          disabled={busy || !job}
          onClick={() => void runPreview()}
        >
          Esikatsele tekstit
        </button>
        <p className="field__hint">Esikatselu ei luo mitään YouTubeen.</p>
      </section>

      {authError && (
        <section className="card">
          <AuthMissingNotice detail={authError} onGoToAuth={onGoToAuth} />
        </section>
      )}

      {preview && (
        <>
          <section className="card">
            <h2 className="card__title">Otsikot</h2>
            <p className="field__label">Normaali</p>
            <p className="textline">{preview.texts.title}</p>
            <p className="field__label">Selostettu</p>
            <p className="textline">{preview.texts.narratedTitle}</p>
            <p className="field__hint">
              {preview.texts.scheduledLocal} · {preview.texts.venue || "paikka puuttuu"}
              {preview.texts.playlistName ? ` · soittolista: ${preview.texts.playlistName}` : ""}
            </p>
          </section>

          <section className="card">
            <h2 className="card__title">Kuvaus</h2>
            <pre className="textblock">{preview.texts.description}</pre>
          </section>

          <section className="card">
            <h2 className="card__title">Jaettava viesti</h2>
            <pre className="textblock">{preview.texts.shareMessage}</pre>
            <p className="field__hint">
              Linkit ovat vielä paikkamerkkejä — luonnin jälkeen tähän tulee valmis viesti.
            </p>
          </section>

          <section className="card">
            <h2 className="card__title">Thumbnail</h2>
            <ThumbnailPair
              headline={preview.texts.thumbnailHeadline}
              datetime={preview.texts.thumbnailDatetime}
              venue={preview.texts.thumbnailVenue}
            />
          </section>

          <section className="card card--danger">
            <h2 className="card__title">Luo lähetykset</h2>
            <div className="warnbox">
              <strong>Peruuttamaton ja ulospäin näkyvä</strong>
              Tämä luo kanavalle <strong>kaksi</strong> lähetystä: normaalin ja Selostetun. Poistaminen
              jälkikäteen ei poista jo jaettua linkkiä.
            </div>

            <div className="field">
              <span className="field__label">Näkyvyys</span>
              <select
                className="field__input"
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value as PrivacyStatus)}
              >
                {PRIVACY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label="Soittolistan id (valinnainen)"
              value={playlistOverride}
              placeholder={preview.texts.playlistId ?? "PL…"}
              hint={
                preview.texts.playlistId
                  ? `Oletus ikäluokan mukaan: ${preview.texts.playlistName ?? preview.texts.playlistId}`
                  : "Ikäluokkaa ei tunnistettu — ilman id:tä videota ei lisätä soittolistaan."
              }
              onChange={setPlaylistOverride}
            />

            {/* Tekstit ja kuvat ovat yllä, tässä järjestyksessä tarkoituksella:
                otsikossa ei saa olla lopputulosta, ja päivän ja ajan on
                täsmättävä. Erillinen kuittauskytkin poistettiin (#129), kaksi
                napautusta jää. */}
            <ConfirmButton
              className="btn--wide btn--tall"
              label="Luo lähetykset YouTubeen"
              confirmLabel="Vahvista: luo 2 lähetystä"
              disabled={busy || created !== null}
              onConfirm={() => void runCreate()}
            />
            <p className="field__hint">
              Tarkista yltä ettei otsikossa ole lopputulosta ja että päivä ja aika ovat oikein — luonti on
              peruuttamaton ja näkyy ulospäin.
            </p>
            {created && <p className="field__hint">Lähetykset on jo luotu tälle työlle.</p>}
          </section>
        </>
      )}

      {created && <CreatedResult created={created} />}
    </>
  );
}

function CreatedResult({ created }: { created: CreatedBroadcastPair }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <>
      <section className="card">
        <h2 className="card__title">Jaettava viesti</h2>
        {/* The message the operator pastes into the team's chat. It always
            starts with "Seuraava live on " (leirimallin SKILL), so it is shown
            verbatim rather than reassembled here. */}
        <pre className="textblock" data-testid="share-message">
          {created.shareMessage}
        </pre>
        <CopyButton className="btn--wide" text={created.shareMessage} label="Kopioi jaettava viesti" />
      </section>

      <section className="card">
        <h2 className="card__title">Luodut lähetykset</h2>
        <dl className="kv">
          <div className="kv__row">
            <dt>Normaali</dt>
            <dd>
              <a className="linkbtn" href={created.normal.watchUrl} target="_blank" rel="noreferrer">
                Avaa
              </a>
            </dd>
          </div>
          <div className="kv__row">
            <dt>Selostettu</dt>
            <dd>
              <a className="linkbtn" href={created.narrated.watchUrl} target="_blank" rel="noreferrer">
                Avaa
              </a>
            </dd>
          </div>
          <div className="kv__row">
            <dt>Kohteen video id</dt>
            <dd className="num">{created.narrated.videoId}</dd>
          </div>
          <div className="kv__row">
            <dt>RTMP</dt>
            <dd className="num">{created.narrated.rtmpUrl ?? "–"}</dd>
          </div>
          <div className="kv__row">
            <dt>Stream key</dt>
            <dd className="num">
              {revealed ? (created.narrated.streamKey ?? "–") : "••••-••••-••••-••••"}
            </dd>
          </div>
        </dl>
        <div className="btn-row">
          <button type="button" className="btn btn--ghost" onClick={() => setRevealed(!revealed)}>
            {revealed ? "Piilota avain" : "Näytä avain"}
          </button>
          <CopyButton text={created.broadcastSummary} label="Kopioi tekniset tiedot" />
        </div>
        {/* Thumbnail on ainoa osa luontia joka voi epäonnistua ILMAN että
            luonti epäonnistuu: lähetykset ovat jo olemassa. Siksi tulos
            näytetään erikseen eikä pääteltävissä muusta kortista — #130
            löytyi juuri siitä, että thumbnail jäi asettamatta ja luonti
            raportoi silti onnistuneensa.

            Kenttä luetaan varovasti: jos vastauksessa ei ole sitä lainkaan,
            rivi jää pois eikä kortti kaadu. Kaatuessaan se veisi mukanaan
            jakoviestin ja stream keyn. */}
        {created.thumbnails && (
          <>
            <dl className="kv">
              <div className="kv__row">
                <dt>Thumbnailit</dt>
                <dd data-testid="thumbnail-outcome">
                  {created.thumbnails.normal.ok && created.thumbnails.narrated.ok
                    ? "Asetettu molempiin"
                    : [
                        created.thumbnails.normal.ok
                          ? null
                          : `normaali: ${created.thumbnails.normal.error}`,
                        created.thumbnails.narrated.ok
                          ? null
                          : `selostettu: ${created.thumbnails.narrated.error}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </dd>
              </div>
            </dl>
            {(!created.thumbnails.normal.ok || !created.thumbnails.narrated.ok) && (
              <p className="field__hint is-fail">
                Lähetykset on silti luotu — älä luo niitä uudelleen. Thumbnailin voi asettaa Studiossa.
              </p>
            )}
          </>
        )}
        <p className="field__hint">
          Työn kohdetiedot päivittyivät automaattisesti — .env.relay kirjoitetaan Työ-välilehdeltä.
        </p>
      </section>
    </>
  );
}
