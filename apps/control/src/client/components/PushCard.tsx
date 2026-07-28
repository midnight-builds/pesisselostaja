import { useCallback, useEffect, useState } from "react";
import type { NotificationPrefs } from "../../shared/types";
import {
  enablePush,
  getPushPrefs,
  isStandalone,
  readPushStatus,
  sendTestPush,
  setPushPrefs,
  type PushStatus,
} from "../push";
import { ToggleRow } from "./ToggleRow";

/** Notification setup, at the bottom of the live view.
 *
 *  Placement is deliberate: it belongs to monitoring, but it is configured
 *  once and then never touched, so it sits below everything used during a
 *  match. The test button is not a nicety — the operator has to be able to
 *  prove the alert path works while still standing next to the camera, since
 *  an alert path you only discover is broken when it fails to alert you is
 *  worse than none. */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
}

/** What the operator is told for each state, in the words that say what to do
 *  next rather than what went wrong. */
const STATUS_TEXT: Record<PushStatus, string> = {
  on: "Ilmoitukset ovat käytössä tällä puhelimella.",
  off: "Ilmoitukset eivät ole vielä käytössä tällä puhelimella.",
  blocked:
    "Ilmoitukset on estetty. Salli ne puhelimen asetuksista (Asetukset → Ilmoitukset → Ohjaamo) ja palaa tänne.",
  "needs-install":
    "Lisää Koti-valikkoon ensin. iOS sallii ilmoitukset vain kotivalikkoon asennetulle sovellukselle: Safarissa Jaa-painike → “Lisää koti­valikkoon”, ja avaa sovellus sen jälkeen kotivalikon kuvakkeesta.",
  unsupported: "Tämä selain ei tue push-ilmoituksia.",
};

export function PushCard({ notify }: Props) {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await readPushStatus());
  }, []);

  useEffect(() => {
    void refresh();
    // Preferences are server-side (they decide what the server sends), so they
    // are read even when this particular phone is not subscribed.
    getPushPrefs()
      .then(setPrefs)
      .catch(() => undefined);
  }, [refresh]);

  // Returning from the iOS install flow, or from the Settings app after
  // allowing notifications, brings the app back to the foreground — recheck
  // then, or the card would keep telling the operator to do what they just did.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const savePref = (patch: Partial<NotificationPrefs>): Promise<void> =>
    run(async () => {
      setPrefs(await setPushPrefs(patch));
    });

  // Re-subscribing while already "on" is deliberately allowed: the browser can
  // hold a subscription the server has since lost (run/ wiped, VAPID key
  // regenerated), and a disabled button would leave no way out of that —
  // enablePush unsubscribes and re-subscribes, so it is safe to press twice.
  const canEnable = status === "off" || status === "on";
  const installHint = status === "needs-install";

  return (
    <section className="card">
      <h2 className="card__title">Ilmoitukset</h2>

      {status === null ? (
        <p className="muted">Tarkistetaan…</p>
      ) : installHint ? (
        <div className="warnbox">
          <strong>Lisää Koti-valikkoon ensin</strong>
          {STATUS_TEXT["needs-install"]}
        </div>
      ) : (
        <p className={status === "blocked" ? "muted is-fail" : "muted"}>{STATUS_TEXT[status]}</p>
      )}

      {status !== null && !installHint && !isStandalone() && (
        <p className="field__hint">
          Sovellusta ei ole avattu kotivalikosta. Ilmoitukset saattavat toimia tässä selaimessa, mutta
          iPhonella ne toimivat varmasti vasta kotivalikkoon asennettuna.
        </p>
      )}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !canEnable}
          onClick={() =>
            // enablePush must run inside this tap: iOS only grants the
            // permission prompt to a user gesture.
            void run(async () => {
              const next = await enablePush();
              setStatus(next);
              notify("ok", "Ilmoitukset otettu käyttöön");
            })
          }
        >
          {status === "on" ? "Ilmoitukset käytössä" : "Ota ilmoitukset käyttöön"}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy || status !== "on"}
          onClick={() =>
            void run(async () => {
              const result = await sendTestPush();
              notify(
                result.sent > 0 ? "ok" : "error",
                result.sent > 0
                  ? `Testi-ilmoitus lähetetty (${result.sent} laitetta)`
                  : "Testi-ilmoitusta ei saatu perille yhteenkään laitteeseen"
              );
            })
          }
        >
          Lähetä testi-ilmoitus
        </button>
      </div>

      <ToggleRow
        label="Lähetys rikki"
        hint="Vika ei korjaantunut minuutissa"
        on={prefs?.broken ?? false}
        disabled={busy || !prefs}
        onToggle={(value) => void savePref({ broken: value })}
      />
      <ToggleRow
        label="Automaattinen korjaus"
        hint="Ohjaamo korjasi jotain itse"
        on={prefs?.autoFix ?? false}
        disabled={busy || !prefs}
        onToggle={(value) => void savePref({ autoFix: value })}
      />
      <ToggleRow
        label="Valmistelu ja käynnistys"
        hint="Relay ajoon, preflightissa esteitä"
        on={prefs?.startup ?? false}
        disabled={busy || !prefs}
        onToggle={(value) => void savePref({ startup: value })}
      />
      <ToggleRow
        label="Lähetys päättyi"
        hint="Relay pois ajosta kesken ottelun tai ottelun jälkeen"
        on={prefs?.ended ?? false}
        disabled={busy || !prefs}
        onToggle={(value) => void savePref({ ended: value })}
      />
    </section>
  );
}
