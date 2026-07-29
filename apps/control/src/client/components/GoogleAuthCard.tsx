import { useEffect, useRef, useState } from "react";
import type { AuthHealth } from "../api";
import { api } from "../api";
import { fiDate, fiTime } from "../format";
import { CopyButton } from "./CopyButton";
import { Field } from "./Field";

/** Google-yhteys: the device flow, and afterwards the health report.
 *
 *  Why the device flow at all is in googleAuth.ts's own header; what matters
 *  here is that the code is read off ONE phone and typed into ANOTHER device,
 *  so it is rendered at 40 px with wide letter spacing and a copy button. A
 *  code you have to squint at is a code that gets mistyped, and every mistype
 *  costs a full restart of the flow.
 *
 *  The single most serious thing this card can report is the wrong channel.
 *  A valid connection to the wrong Google account looks completely healthy —
 *  scopes fine, token fresh, quota fine — and would publish a children's match
 *  to a stranger's channel. So the channel is checked against the one channel
 *  this production belongs to (runbook "Tilit ja perustiedot") and anything
 *  else is painted as a failure, not a warning. */

/** Runbook: docs/youtube-runbook.md → "Tilit ja perustiedot". */
export const EXPECTED_CHANNEL_TITLE = "Talonkuningas";
export const EXPECTED_CHANNEL_ID = "UC4oXm9z5eNyh1snqGsRqcnw";

/** Google's device page. The server hands back whatever Google returned; this
 *  is only the fallback for rendering before the first response. */
const DEVICE_URL = "https://www.google.com/device";

/** googleAuth.ts warns at 6 days; repeated here so the number the operator
 *  reads and the number the server acts on cannot drift apart silently. */
const TOKEN_WARN_AGE_DAYS = 6;

interface PendingFlow {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSec: number;
}

interface Props {
  health: AuthHealth | null;
  error: string | null;
  loading: boolean;
  onReload: () => void;
  notify: (kind: "ok" | "error", text: string) => void;
}

export function channelIsExpected(channel: { id: string; title: string } | null): boolean {
  if (!channel) return false;
  return (
    channel.id === EXPECTED_CHANNEL_ID ||
    channel.title.trim().toLowerCase() === EXPECTED_CHANNEL_TITLE.toLowerCase()
  );
}

export function GoogleAuthCard({ health, error, loading, onReload, notify }: Props) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState<PendingFlow | null>(null);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once the operator abandons a flow, so a stale server-side pending
   *  code does not immediately reappear on the next health refresh. */
  const dismissed = useRef(false);

  // A device flow started on another phone (or before a reload) is still on
  // the server — pick it up rather than making the operator start over.
  useEffect(() => {
    if (!health?.pending || pending || dismissed.current) return;
    setPending({ ...health.pending, intervalSec: 5 });
  }, [health?.pending, pending]);

  // Poll until Google says the user approved. The first poll fires quickly so
  // an approval that already happened is noticed at once; after that the
  // server's own interval is respected (Google answers `slow_down` otherwise).
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      try {
        const poll = await api.youtubeAuthPoll();
        if (stopped) return;
        setPollMessage(poll.message);
        if (poll.status === "connected") {
          setPending(null);
          notify("ok", poll.message);
          onReload();
          return;
        }
        if (poll.status === "expired" || poll.status === "denied" || poll.status === "none") {
          setPending(null);
          notify("error", poll.message);
          return;
        }
        timer = setTimeout(() => void tick(), Math.max(poll.intervalSec, 3) * 1000);
      } catch (err) {
        if (stopped) return;
        // A failed poll is not a failed flow: keep trying, but slower.
        setPollMessage(err instanceof Error ? err.message : String(err));
        timer = setTimeout(() => void tick(), 8000);
      }
    };

    timer = setTimeout(() => void tick(), 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pending, notify, onReload]);

  const start = async () => {
    setBusy(true);
    try {
      const started = await api.youtubeAuthStart({
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret.trim() || null,
      });
      dismissed.current = false;
      setPollMessage(null);
      setPending({
        userCode: started.userCode,
        verificationUrl: started.verificationUrl || DEVICE_URL,
        expiresAt: started.expiresAt,
        intervalSec: started.intervalSec,
      });
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <section className="card">
        <h2 className="card__title">Yhdistä Google-tili</h2>
        <ol className="steps">
          <li className="steps__item">
            <span className="steps__n">1</span>
            <span className="steps__body">
              Avaa <strong>toisella laitteella</strong> osoite
              <span className="devicecode__url">{pending.verificationUrl}</span>
            </span>
          </li>
          <li className="steps__item">
            <span className="steps__n">2</span>
            <span className="steps__body">Syötä tämä koodi:</span>
          </li>
        </ol>

        <p className="devicecode__code num" data-testid="device-code">
          {pending.userCode}
        </p>
        <div className="btn-row">
          <CopyButton text={pending.userCode} label="Kopioi koodi" />
          <CopyButton text={pending.verificationUrl} label="Kopioi osoite" />
        </div>

        <p className="field__hint">
          Kirjaudu sillä tilillä, joka omistaa kanavan {EXPECTED_CHANNEL_TITLE}. Koodi vanhenee klo{" "}
          {fiTime(pending.expiresAt)}.
        </p>
        <p className="field__hint">{pollMessage ?? "Odotetaan hyväksyntää…"}</p>

        <button
          type="button"
          className="btn btn--ghost btn--wide"
          onClick={() => {
            dismissed.current = true;
            setPending(null);
            setPollMessage(null);
          }}
        >
          Keskeytä
        </button>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card">
        <h2 className="card__title">Google-yhteys</h2>
        <div className="warnbox warnbox--fail">
          <strong>Yhteyden tilaa ei saatu</strong>
          {error}
        </div>
        <button type="button" className="btn btn--wide" onClick={onReload}>
          Yritä uudelleen
        </button>
      </section>
    );
  }

  if (!health) {
    return (
      <section className="card">
        <h2 className="card__title">Google-yhteys</h2>
        <p className="muted">{loading ? "Tarkistetaan…" : "Ei tietoa."}</p>
      </section>
    );
  }

  if (!health.connected) return <ConnectForm {...{ clientId, setClientId, clientSecret, setClientSecret, busy, start }} />;

  return <HealthReport health={health} loading={loading} onReload={onReload} />;
}

function ConnectForm({
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  busy,
  start,
}: {
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  busy: boolean;
  start: () => Promise<void>;
}) {
  return (
    <section className="card">
      <h2 className="card__title">Google-yhteys</h2>
      <p className="muted">
        Google-tiliä ei ole yhdistetty. Ilman yhteyttä lähetyksiä ei voi luoda eikä videoita hallita.
      </p>
      <p className="field__hint">
        OAuth-clientin tyypin on oltava <strong>TVs and Limited Input devices</strong>. Jos tunnukset on jo
        tallennettu palvelimelle, jätä kentät tyhjiksi ja paina Yhdistä.
      </p>

      <Field
        label="client_id"
        value={clientId}
        placeholder="…apps.googleusercontent.com"
        hint="Jätä tyhjäksi jos tunnus on jo palvelimella (run/google-client.json)."
        onChange={setClientId}
      />
      <Field
        label="client_secret (valinnainen)"
        value={clientSecret}
        secret
        placeholder="GOCSPX-…"
        hint="Laitevirtaclientilla secretiä ei välttämättä ole — tyhjä kelpaa."
        onChange={setClientSecret}
      />

      <button
        type="button"
        className="btn btn--primary btn--wide btn--tall"
        disabled={busy}
        onClick={() => void start()}
      >
        Yhdistä
      </button>
    </section>
  );
}

function HealthReport({
  health,
  loading,
  onReload,
}: {
  health: AuthHealth;
  loading: boolean;
  onReload: () => void;
}) {
  const expected = channelIsExpected(health.channel);
  const quota = health.quota;
  const quotaPct = quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  const quotaLevel = quota.remaining <= 0 ? "fail" : quota.remaining < 300 ? "warn" : "ok";
  const staleToken = health.daysSinceSuccess !== null && health.daysSinceSuccess >= TOKEN_WARN_AGE_DAYS;

  return (
    <>
      <section className="card">
        <h2 className="card__title">Valtuutettu kanava</h2>
        <div className={`channel ${expected ? "channel--ok" : "channel--wrong"}`}>
          <span className="channel__name">{health.channel?.title ?? "Kanavaa ei saatu haettua"}</span>
          {health.channel && <span className="channel__id num">{health.channel.id}</span>}
          {expected ? (
            <span className="channel__verdict channel__verdict--ok">Oikea kanava</span>
          ) : health.channel ? (
            <span className="channel__verdict channel__verdict--wrong">VÄÄRÄ KANAVA</span>
          ) : (
            <span className="channel__verdict channel__verdict--wrong">Varmistamaton</span>
          )}
        </div>

        {health.channel && !expected && (
          <div className="warnbox warnbox--fail">
            <strong>Älä luo lähetyksiä</strong>
            Yhteys on tilillä, joka omistaa kanavan “{health.channel.title}”, ei kanavaa{" "}
            {EXPECTED_CHANNEL_TITLE} ({EXPECTED_CHANNEL_ID}). Lähetykset menisivät väärälle kanavalle.
            Katkaise oikeus osoitteessa myaccount.google.com/permissions ja kirjaudu uudelleen oikealla
            tilillä.
          </div>
        )}
        {!health.channel && (
          <div className="warnbox">
            <strong>Kanavaa ei varmistettu</strong>
            channels.list ei vastannut. Älä luo lähetyksiä ennen kuin tämä näyttää{" "}
            {EXPECTED_CHANNEL_TITLE}.
          </div>
        )}

        <p className={`health__headline ${health.health === "fail" ? "is-fail" : ""}`}>{health.headline}</p>

        <div className="btn-row">
          <button type="button" className="btn btn--ghost" disabled={loading} onClick={onReload}>
            {loading ? "Tarkistetaan…" : "Tarkista uudelleen"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Tokenin ikä</h2>
        <dl className="kv">
          <div className={staleToken ? "kv__row kv__row--fail" : "kv__row"}>
            <dt>Viimeisin onnistunut päivitys</dt>
            <dd className="num">
              {health.daysSinceSuccess === null ? "–" : `${health.daysSinceSuccess} vrk sitten`}
            </dd>
          </div>
          <div className="kv__row">
            <dt>Päivitetty</dt>
            <dd>
              {health.lastRefreshAt
                ? `${fiDate(health.lastRefreshAt)} klo ${fiTime(health.lastRefreshAt)}`
                : "ei kertaakaan"}
            </dd>
          </div>
          <div className="kv__row">
            <dt>Yhteys luotu</dt>
            <dd>
              {health.tokenObtainedAt
                ? `${fiDate(health.tokenObtainedAt)} klo ${fiTime(health.tokenObtainedAt)}`
                : "–"}
            </dd>
          </div>
        </dl>
        {staleToken && (
          <div className="warnbox warnbox--fail">
            <strong>Yli {TOKEN_WARN_AGE_DAYS} vrk ilman päivitystä</strong>
            Testing-tilassa oleva OAuth-sovellus vanhentaa refresh tokenin 7 vuorokaudessa. Uusi yhteys
            nyt — älä kesken lähetyksen.
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Oikeudet</h2>
        <ul className="checks">
          {health.scopes.length === 0 && (
            <li className="check check--warn">
              <span className="check__mark" aria-hidden="true">
                ⚠
              </span>
              <span className="check__body">
                <span className="check__name">Scopeja ei saatu luettua</span>
                <span className="check__detail">tokeninfo ei vastannut</span>
              </span>
            </li>
          )}
          {health.scopes.map((scope) => (
            <li key={scope} className="check check--ok">
              <span className="check__mark" aria-hidden="true">
                ✓
              </span>
              <span className="check__body">
                <span className="check__detail">{scope}</span>
              </span>
            </li>
          ))}
          {health.missingScopes.map((scope) => (
            <li key={scope} className="check check--fail">
              <span className="check__mark" aria-hidden="true">
                ✗
              </span>
              <span className="check__body">
                <span className="check__name">Puuttuu</span>
                <span className="check__detail">{scope}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="card__title">Kiintiö tänään</h2>
        <div className="meter__value num">
          {quota.remaining}
          <span className="meter__unit">yksikköä jäljellä</span>
        </div>
        <div className={`meter meter--${quotaLevel}`}>
          <div className="meter__fill" style={{ width: `${quotaPct}%` }} />
        </div>
        <p className="field__hint">
          Käytetty {quota.used} / {quota.limit} yksikköä. Yhden ottelun lähetyspari kuluttaa noin 300.
          Kiintiöpäivä {quota.day} (nollautuu keskiyöllä Tyynenmeren aikaa).
        </p>
      </section>

      {health.warnings.length > 0 && (
        <section className="card">
          <h2 className="card__title">Huomiot</h2>
          <ul className="checks">
            {health.warnings.map((warning) => (
              <li key={warning} className="check check--warn">
                <span className="check__mark" aria-hidden="true">
                  ⚠
                </span>
                <span className="check__body">
                  <span className="check__detail">{warning}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
