import { useCallback, useEffect, useState } from "react";
import type { Job, JobShareMessage, LiveState, PreflightResult } from "../../shared/types";
import { ApiRequestError, DEFAULT_RTMP_URL, api } from "../api";
import { ConfirmButton } from "../components/ConfirmButton";
import { CopyButton } from "../components/CopyButton";
import { Field } from "../components/Field";
import { BroadcastCreateCard } from "../components/BroadcastCreateCard";
import { SchedulerCard } from "../components/SchedulerCard";
import { fiDate, fiTime } from "../format";

/** The job form: which match, which source, which target. Getting source and
 *  target the wrong way round is the single most repeated mistake in this
 *  production chain, so the warning is part of the form, not a footnote. */

interface Props {
  live: LiveState | null;
  notify: (kind: "ok" | "error", text: string) => void;
  /** Bumped by the matches view after creating jobs, to force a refetch. */
  reloadToken: number;
  /** Whether this tab is the visible one — the create card only auto-previews
   *  while it is on screen (#129). */
  active: boolean;
}

interface FormState {
  sourceUrl: string;
  targetStreamKey: string;
  targetRtmpUrl: string;
}

const EMPTY_FORM: FormState = { sourceUrl: "", targetStreamKey: "", targetRtmpUrl: DEFAULT_RTMP_URL };

export function JobView({ live, notify, reloadToken, active }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when activation was refused because another job still holds the
   *  broadcast slot. Carries the server's own sentence, and turns the recovery
   *  into a button instead of a hand-written PATCH in the middle of a match
   *  changeover (#101). */
  const [clash, setClash] = useState<string | null>(null);
  /** Jakoviesti (#131). Haetaan aina uudelleen valitulle työlle sen sijaan
   *  että se talletettaisiin luontivastauksesta: luonnin jälkeen viesti näkyi
   *  vain kerran, ja katosi jos operaattori ei kopioinut sitä heti tai sivu
   *  latautui uudelleen. Katsojia tulee kanaville kesken ottelunkin. */
  const [share, setShare] = useState<JobShareMessage | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const activeId = live?.job?.id ?? null;

  useEffect(() => {
    if (!selectedId) {
      setShare(null);
      setShareError(null);
      return;
    }
    let cancelled = false;
    setShare(null);
    setShareError(null);
    api.jobShare(selectedId).then(
      (msg) => !cancelled && setShare(msg),
      (err: unknown) => !cancelled && setShareError(err instanceof Error ? err.message : String(err))
    );
    return () => {
      cancelled = true;
    };
    // reloadToken: lähetysten luonti YouTube-välilehdellä muuttaa työn linkit,
    // jolloin sama työ tuottaa eri viestin.
  }, [selectedId, reloadToken]);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await api.jobs());
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }, [notify]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs, reloadToken]);

  // Pick the running job by default; otherwise the newest one.
  useEffect(() => {
    if (selectedId && jobs.some((j) => j.id === selectedId)) return;
    const fallback = activeId ?? jobs[jobs.length - 1]?.id ?? null;
    setSelectedId(fallback);
  }, [jobs, activeId, selectedId]);

  const job = jobs.find((j) => j.id === selectedId) ?? live?.job ?? null;

  // Seed the form whenever the selected job changes identity — never on every
  // SSE push, or typing would be overwritten mid-keystroke.
  useEffect(() => {
    if (!job) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      sourceUrl: job.sourceUrl ?? "",
      targetStreamKey: job.targetStreamKey ?? "",
      targetRtmpUrl: job.targetRtmpUrl || DEFAULT_RTMP_URL,
    });
    setPreflight(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  const run = async <T,>(work: () => Promise<T>, okText: string): Promise<T | null> => {
    setBusy(true);
    try {
      const result = await work();
      notify("ok", okText);
      return result;
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** Activation, with the clash answer separated from real failures: a
   *  conflict is a state with a next step, not an error to shout about. */
  const activate = async (target: Job, force: boolean) => {
    setBusy(true);
    try {
      await saveForm(target);
      await api.activateJob(target.id, { force });
      setClash(null);
      await loadJobs();
      notify("ok", force ? "Edellinen lopetettu, .env.relay kirjoitettu" : ".env.relay kirjoitettu");
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setClash(err.message);
      } else {
        notify("error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const saveForm = async (target: Job) =>
    api.patchJob(target.id, {
      sourceUrl: form.sourceUrl.trim() || null,
      targetStreamKey: form.targetStreamKey.trim() || null,
      targetRtmpUrl: form.targetRtmpUrl.trim() || DEFAULT_RTMP_URL,
    });

  if (!job) {
    return (
      <div className="view">
        <section className="card">
          <h2 className="card__title">Ei työtä</h2>
          <p className="muted">Valitse ottelu Ottelut-välilehdeltä ja luo työ.</p>
        </section>
        {/* Näkyy myös ilman työtä: silloin se kertoo juuri sen — ettei ole
            mitään odotettavaa — mikä on eri asia kuin että ajastin olisi
            rikki. */}
        <SchedulerCard notify={notify} />
      </div>
    );
  }

  const blockers = preflight?.blockers ?? 0;

  return (
    <div className="view">
      <section className="card">
        <h2 className="card__title">Työ</h2>
        <p className="job__teams">
          {job.home} – {job.away}
        </p>
        <p className="muted">
          {[job.seriesName, job.stadium].filter(Boolean).join(" · ") || "—"}
        </p>
        <p className="muted">
          {fiDate(job.startsAt)} klo {fiTime(job.startsAt)} · ottelu {job.matchId} ·{" "}
          <span className={`tag tag--${job.status}`}>{job.status}</span>
          {job.id === activeId && <span className="tag tag--live">aktiivinen</span>}
        </p>
        {jobs.length > 1 && (
          <div className="field">
            <span className="field__label">Vaihda työtä</span>
            <select
              className="field__input"
              value={job.id}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {fiTime(j.startsAt)} {j.home}–{j.away} ({j.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Raakalähetys ja selostettu lähetys</h2>
        <p className="warnbox">
          <strong>Raakalähetystä</strong> <em>luetaan</em> — se on se, johon kuvauspuhelin työntää.<br />
          <strong>Selostettuun lähetykseen</strong> <em>pushataan</em> — se on se, jonka relay tuottaa.<br />
          Näiden sekoittaminen lähettää selostuksen väärään lähetykseen.
        </p>

        <Field
          label="Raakalähetyksen YouTube-osoite (luetaan)"
          value={form.sourceUrl}
          inputMode="url"
          placeholder="https://www.youtube.com/watch?v=…"
          hint="Lähetys johon kuvauspuhelimen StreamLabs työntää. Ohjaamon luomana tämä täyttyy itsestään."
          onChange={(v) => setForm({ ...form, sourceUrl: v })}
        />
        <Field
          label="Selostetun lähetyksen stream key (pushataan)"
          value={form.targetStreamKey}
          secret
          placeholder="xxxx-xxxx-xxxx-xxxx"
          hint="Selostetun lähetyksen avain — ei koskaan raakalähetyksen avain."
          onChange={(v) => setForm({ ...form, targetStreamKey: v })}
        />
        <Field
          label="Selostetun lähetyksen RTMP-osoite"
          value={form.targetRtmpUrl}
          inputMode="url"
          hint={`Oletus: ${DEFAULT_RTMP_URL}`}
          onChange={(v) => setForm({ ...form, targetRtmpUrl: v })}
        />

        <div className="btn-row">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void run(() => saveForm(job).then(loadJobs), "Tiedot tallennettu")}
          >
            Tallenna tiedot
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void activate(job, false)}
          >
            Kirjoita .env.relay
          </button>
        </div>

        {clash && (
          <div className="clash">
            <p className="clash__text">{clash}</p>
            {/* Two taps: this ends a broadcast that may still be on air. */}
            <ConfirmButton
              className="btn--wide"
              label="Lopeta edellinen ja aktivoi tämä"
              confirmLabel="Varmista: lopeta edellinen"
              disabled={busy}
              onConfirm={() => void activate(job, true)}
            />
          </div>
        )}
      </section>

      {/* Lähetysten luonti on tässä eikä YouTube-välilehdellä (#129): ottelun
          valinta, lähetykset, jakoviesti, preflight ja käynnistys ovat yksi
          jatkuva polku, ei kahta sivua joiden järjestys pitää muistaa. */}
      <BroadcastCreateCard
        active={active}
        notify={notify}
        onGoToAuth={() => notify("error", "YouTube-valtuutus puuttuu — avaa YouTube-välilehti.")}
        reloadToken={reloadToken}
        job={job}
        onCreated={() => void loadJobs()}
      />

      {/* Jakoviesti on saatavilla työn koko elinkaaren ajan, ei vain
          luontihetkellä (#131). Ennen lähetysten luontia se näkyy silti —
          paikkamerkkeineen — jotta operaattori näkee mitä puuttuu. */}
      <section className="card">
        <h2 className="card__title">Jaettava viesti</h2>
        {shareError && <p className="field__hint is-fail">{shareError}</p>}
        {!shareError && !share && <p className="muted">Haetaan…</p>}
        {share && (
          <>
            <pre className="textblock" data-testid="job-share-message">
              {share.shareMessage}
            </pre>
            {!share.linksReady && (
              <p className="field__hint is-fail">
                Lähetyksiä ei ole vielä luotu — viestissä on paikkamerkit oikeiden linkkien sijaan.
                Älä jaa sitä vielä.
              </p>
            )}
            <CopyButton className="btn--wide" text={share.shareMessage} label="Kopioi jaettava viesti" />
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Preflight</h2>
        <button
          type="button"
          className="btn btn--wide"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await api.preflight(job.id);
              setPreflight(result);
              return result;
            }, "Preflight ajettu")
          }
        >
          Aja preflight
        </button>

        {preflight && (
          <>
            <p className={`preflight__summary ${blockers > 0 ? "is-fail" : ""}`}>
              {preflight.summary}
            </p>
            <ul className="checks">
              {preflight.checks.map((check) => (
                <li key={check.name} className={`check check--${check.status}`}>
                  <span className="check__mark" aria-hidden="true">
                    {check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗"}
                  </span>
                  <span className="check__body">
                    <span className="check__name">{check.name}</span>
                    <span className="check__detail">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="field__hint">
              {blockers > 0
                ? `${blockers} estoa — korjaa ennen käynnistystä.`
                : preflight.warnings > 0
                  ? `${preflight.warnings} varoitusta, käynnistys sallittu.`
                  : "Ei esteitä."}
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Käynnistys</h2>
        <button
          type="button"
          className="btn btn--primary btn--wide btn--tall"
          disabled={busy || blockers > 0 || (live?.relay.active ?? false)}
          onClick={() => void run(() => api.relay("start"), "Relay käynnistetty")}
        >
          Käynnistä relay
        </button>
        {blockers > 0 && <p className="field__hint is-fail">Preflightin esteet estävät käynnistyksen.</p>}
        {live?.relay.active && <p className="field__hint">Relay on jo ajossa.</p>}
      </section>

      {/* Ajastin on käsikäynnistyksen alla, ei sen yllä: käsin painettu nappi
          on edelleen ensisijainen tapa, ja ajastin on se jonka operaattori
          ottaa käyttöön vasta kun on katsonut sen kuivaharjoitusta. */}
      <SchedulerCard notify={notify} />
    </div>
  );
}
