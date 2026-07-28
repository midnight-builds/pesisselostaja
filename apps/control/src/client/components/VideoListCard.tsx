import { useCallback, useEffect, useState } from "react";
import type { BroadcastRow, PlaylistSummary, PrivacyStatus } from "../api";
import { api, isAuthMissing } from "../api";
import { fiDate, fiTime } from "../format";
import { AuthMissingNotice } from "./AuthMissingNotice";
import { ConfirmButton } from "./ConfirmButton";
import { Field } from "./Field";

/** Menneet ja tulevat videot: list, edit, playlists, delete.
 *
 *  The delete path is deliberately heavier than ConfirmButton alone. A stopped
 *  broadcast's recording is the only copy of a match that will never be played
 *  again, and `videos.delete` has no undo and no trash — so it asks for the
 *  word POISTA to be typed while the video's own title is on screen next to
 *  the field. Two taps protect against the pocket; typing protects against
 *  deleting the wrong row, which is the mistake that actually happens in a
 *  list of near-identical titles. */

const STATUS_FILTERS: Array<{ value: "all" | "upcoming" | "active" | "completed"; label: string }> = [
  { value: "all", label: "Kaikki" },
  { value: "upcoming", label: "Tulevat" },
  { value: "active", label: "Ajossa" },
  { value: "completed", label: "Menneet" },
];

const PRIVACY_OPTIONS: Array<{ value: PrivacyStatus; label: string }> = [
  { value: "unlisted", label: "Piilotettu" },
  { value: "public", label: "Julkinen" },
  { value: "private", label: "Yksityinen" },
];

/** The exact word that has to be typed before a delete can be confirmed. */
const DELETE_WORD = "POISTA";

const LIFECYCLE_LABELS: Record<string, string> = {
  created: "luotu",
  ready: "valmis",
  testing: "testissä",
  live: "ajossa",
  complete: "päättynyt",
  revoked: "peruttu",
};

interface Props {
  active: boolean;
  notify: (kind: "ok" | "error", text: string) => void;
  onGoToAuth: () => void;
  reloadToken: number;
}

export function VideoListCard({ active, notify, onGoToAuth, reloadToken }: Props) {
  const [rows, setRows] = useState<BroadcastRow[] | null>(null);
  const [status, setStatus] = useState<"all" | "upcoming" | "active" | "completed">("all");
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (which: typeof status) => {
      setLoading(true);
      setAuthError(null);
      try {
        setRows(await api.youtubeBroadcasts(which));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRows(null);
        if (isAuthMissing(err)) setAuthError(message);
        else notify("error", message);
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  // Nothing is fetched until this section is actually open: every route here
  // answers 409 without a Google connection, and a hidden section must not
  // spend the operator's attention (or the quota) on that.
  useEffect(() => {
    if (!active) return;
    void load(status);
  }, [active, status, load, reloadToken]);

  const loadPlaylists = async () => {
    try {
      setPlaylists(await api.youtubePlaylists());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthMissing(err)) setAuthError(message);
      else notify("error", message);
    }
  };

  return (
    <>
      <section className="card">
        <h2 className="card__title">Videot</h2>
        <div className="chips">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`chip ${status === filter.value ? "chip--on" : ""}`}
              aria-pressed={status === filter.value}
              onClick={() => setStatus(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {authError && <AuthMissingNotice detail={authError} onGoToAuth={onGoToAuth} />}
        {!authError && loading && <p className="muted">Haetaan…</p>}
        {!authError && !loading && rows?.length === 0 && <p className="muted">Ei lähetyksiä.</p>}

        {rows && rows.length > 0 && (
          <ul className="vlist">
            {rows.map((row) => (
              <VideoRow
                key={row.videoId}
                row={row}
                open={openId === row.videoId}
                playlists={playlists}
                onToggle={() => setOpenId(openId === row.videoId ? null : row.videoId)}
                onLoadPlaylists={() => void loadPlaylists()}
                onChanged={() => void load(status)}
                notify={notify}
              />
            ))}
          </ul>
        )}

        <div className="btn-row">
          <button type="button" className="btn btn--ghost" disabled={loading} onClick={() => void load(status)}>
            Päivitä lista
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Soittolistat</h2>
        {playlists === null ? (
          <p className="muted">Ei haettu.</p>
        ) : playlists.length === 0 ? (
          <p className="muted">Ei soittolistoja.</p>
        ) : (
          <dl className="kv">
            {playlists.map((list) => (
              <div key={list.id} className="kv__row">
                <dt>{list.title}</dt>
                <dd className="num">{list.itemCount ?? "–"}</dd>
              </div>
            ))}
          </dl>
        )}
        <button type="button" className="btn btn--wide" onClick={() => void loadPlaylists()}>
          Hae soittolistat
        </button>
      </section>
    </>
  );
}

function VideoRow({
  row,
  open,
  playlists,
  onToggle,
  onLoadPlaylists,
  onChanged,
  notify,
}: {
  row: BroadcastRow;
  open: boolean;
  playlists: PlaylistSummary[] | null;
  onToggle: () => void;
  onLoadPlaylists: () => void;
  onChanged: () => void;
  notify: (kind: "ok" | "error", text: string) => void;
}) {
  const when = row.actualStartTime ?? row.scheduledStartTime;
  const lifecycle = row.lifeCycleStatus ? (LIFECYCLE_LABELS[row.lifeCycleStatus] ?? row.lifeCycleStatus) : "–";

  return (
    <li className="vrow">
      <button type="button" className="vrow__head" onClick={onToggle} aria-expanded={open}>
        <span className="vrow__title">{row.title || "(nimetön)"}</span>
        <span className="vrow__meta">
          {when ? `${fiDate(when)} klo ${fiTime(when)}` : "ei aikaa"} · {lifecycle}
          {row.privacyStatus ? ` · ${row.privacyStatus}` : ""}
          {typeof row.viewCount === "number" ? ` · ${row.viewCount} katselua` : ""}
        </span>
      </button>

      <div className="vrow__links">
        <a className="btn btn--ghost" href={row.watchUrl} target="_blank" rel="noreferrer">
          Katso
        </a>
        <a
          className="btn btn--ghost"
          href={`https://studio.youtube.com/video/${row.videoId}/edit`}
          target="_blank"
          rel="noreferrer"
        >
          Studio
        </a>
      </div>

      {open && (
        <VideoEditor
          row={row}
          playlists={playlists}
          onLoadPlaylists={onLoadPlaylists}
          onChanged={onChanged}
          notify={notify}
        />
      )}
    </li>
  );
}

function VideoEditor({
  row,
  playlists,
  onLoadPlaylists,
  onChanged,
  notify,
}: {
  row: BroadcastRow;
  playlists: PlaylistSummary[] | null;
  onLoadPlaylists: () => void;
  onChanged: () => void;
  notify: (kind: "ok" | "error", text: string) => void;
}) {
  const [title, setTitle] = useState(row.title);
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState<PrivacyStatus>(
    (row.privacyStatus as PrivacyStatus | null) ?? "unlisted",
  );
  const [playlistId, setPlaylistId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteWord, setDeleteWord] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    try {
      await work();
      notify("ok", okText);
      onChanged();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vrow__editor">
      <Field label="Otsikko" value={title} onChange={setTitle} />
      <div className="field">
        <span className="field__label">Kuvaus (tyhjä = ei muuteta)</span>
        <textarea
          className="field__input field__input--area"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn btn--primary btn--wide"
        disabled={busy}
        onClick={() =>
          void run(
            () =>
              api.patchVideo(row.videoId, {
                title,
                ...(description.trim() ? { description } : {}),
              }),
            "Metatiedot tallennettu",
          )
        }
      >
        Tallenna otsikko ja kuvaus
      </button>

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
      {/* Näkyvyyden muutos voi piilottaa jo jaetun videon katsojilta, joten se
          on erotettu tavallisesta tallennuksesta ja vaatii oman vahvistuksen. */}
      <ConfirmButton
        className="btn--wide"
        label={`Muuta näkyvyydeksi: ${privacy}`}
        confirmLabel="Vahvista näkyvyyden muutos"
        disabled={busy || privacy === row.privacyStatus}
        onConfirm={() =>
          void run(() => api.patchVideo(row.videoId, { privacyStatus: privacy }), "Näkyvyys muutettu")
        }
      />

      <div className="field">
        <span className="field__label">Lisää soittolistaan</span>
        <select className="field__input" value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
          <option value="">Valitse soittolista…</option>
          {(playlists ?? []).map((list) => (
            <option key={list.id} value={list.id}>
              {list.title}
            </option>
          ))}
        </select>
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn--ghost" onClick={onLoadPlaylists}>
          Hae soittolistat
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !playlistId}
          onClick={() => void run(() => api.patchVideo(row.videoId, { playlistId }), "Lisätty soittolistaan")}
        >
          Lisää
        </button>
      </div>

      {!deleting ? (
        <button type="button" className="btn btn--danger btn--wide" onClick={() => setDeleting(true)}>
          Poista video…
        </button>
      ) : (
        <div className="dangerbox">
          <strong>Poisto on lopullinen</strong>
          <p className="dangerbox__target">{row.title || row.videoId}</p>
          <p className="field__hint">
            Videota ei voi palauttaa, eikä sen tallennetta ole missään muualla. Kirjoita{" "}
            <strong>{DELETE_WORD}</strong> jatkaaksesi.
          </p>
          <Field label={`Kirjoita ${DELETE_WORD}`} value={deleteWord} onChange={setDeleteWord} />
          <ConfirmButton
            className="btn--wide btn--tall"
            label="Poista lopullisesti"
            confirmLabel="Vahvista lopullinen poisto"
            disabled={busy || deleteWord.trim().toUpperCase() !== DELETE_WORD}
            onConfirm={() => void run(() => api.deleteVideo(row.videoId), "Video poistettu")}
          />
          <button
            type="button"
            className="btn btn--ghost btn--wide"
            onClick={() => {
              setDeleting(false);
              setDeleteWord("");
            }}
          >
            Peruuta
          </button>
        </div>
      )}
    </div>
  );
}
