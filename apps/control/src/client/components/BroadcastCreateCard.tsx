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
 *  shared. So the button that does it is behind three separate gates:
 *
 *    1. the texts must have been fetched (POST .../templates/preview creates
 *       nothing — it is pure text, so previewing is free),
 *    2. the operator must tick "olen tarkistanut", which is the moment the
 *       spoiler-free title and the right date are actually looked at,
 *    3. and then the button itself takes two taps (ConfirmButton).
 *
 *  None of the three is decoration: the first two make the check possible, the
 *  third makes a pocket tap harmless. */

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
}

export function BroadcastCreateCard({ active, notify, onGoToAuth, reloadToken }: Props) {
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
  const [checked, setChecked] = useState(false);
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
    if (!active) return;
    void loadJobs();
  }, [active, loadJobs, reloadToken]);

  // Changing the job invalidates everything downstream: previewing job A and
  // then creating job B is exactly the mistake this card exists to prevent.
  useEffect(() => {
    setPreview(null);
    setCreated(null);
    setChecked(false);
  }, [jobId]);

  // Editing a title field after previewing would leave the checked-and-read
  // texts describing something else than what gets created — so the preview
  // (and the tick) go with it.
  useEffect(() => {
    setPreview(null);
    setChecked(false);
  }, [teamLabel, opponent, shortVenue]);

  const job = jobs.find((j) => j.id === jobId) ?? null;

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
      setChecked(false);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthMissing(err)) setAuthError(message);
      else notify("error", message);
    } finally {
      setBusy(false);
    }
  };

  if (jobs.length === 0) {
    return (
      <section className="card">
        <h2 className="card__title">Lähetysten luonti</h2>
        <p className="muted">Ei töitä. Valitse ottelu Ottelut-välilehdeltä ensin.</p>
      </section>
    );
  }

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

            <button
              type="button"
              className="knob knob--toggle"
              aria-pressed={checked}
              onClick={() => setChecked(!checked)}
            >
              <span className="knob__text">
                <span className="knob__label">Olen tarkistanut tekstit ja kuvat</span>
                <span className="knob__hint">Otsikossa ei saa olla lopputulosta, päivä ja aika oikein</span>
              </span>
              <span className={`switch ${checked ? "switch--on" : ""}`}>
                <span className="switch__knob" />
              </span>
            </button>

            <ConfirmButton
              className="btn--wide btn--tall"
              label="Luo lähetykset YouTubeen"
              confirmLabel="Vahvista: luo 2 lähetystä"
              disabled={busy || !checked || created !== null}
              onConfirm={() => void runCreate()}
            />
            {!checked && <p className="field__hint">Kuittaa tarkistus ensin.</p>}
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
        <p className="field__hint">
          Työn kohdetiedot päivittyivät automaattisesti — .env.relay kirjoitetaan Työ-välilehdeltä.
        </p>
      </section>
    </>
  );
}
