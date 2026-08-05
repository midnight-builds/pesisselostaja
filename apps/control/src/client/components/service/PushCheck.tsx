import { useEffect, useState } from "react";
import type { NotificationPrefs } from "../../../shared/types";
import { enablePush, getPushPrefs, readPushStatus, sendTestPush, setPushPrefs, type PushStatus } from "../../push";

/** Ilmoitukset huoltoarkissa (#188).
 *
 *  Pushit ovat koko ohjaamon lupaus: käynnistysikkuna on ilmoitushetki eikä
 *  vuorovaikutushetki (#170), joten operaattori saa olla katsomatta ruutua —
 *  mutta vain jos tämä puhelin on tilannut ne. Siksi tilaus on huoltoarkissa
 *  eikä ottelupäivän polulla: se tehdään kerran per puhelin, ei per ottelu.
 *
 *  iOS on syy siihen, miksi tilat ovat nimettyjä eivätkä boolean: selaimen
 *  välilehdessä `Notification` ei ole olemassa lainkaan, ja lupa on kysyttävä
 *  suoraan napautuksesta. `push.ts` kantaa nuo säännöt; tämä komponentti vain
 *  renderöi kunkin tilan oman lauseen — hiljainen "nappi ei tee mitään" oli
 *  juuri se vika, jota vastaan tilat kirjoitettiin. */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
}

const STATUS_TEXT: Record<PushStatus, string> = {
  on: "Ilmoitukset ovat käytössä tällä puhelimella.",
  off: "Ilmoituksia ei ole vielä otettu käyttöön tällä puhelimella.",
  blocked: "Ilmoitukset on estetty. Salli ne puhelimen omista asetuksista (Ilmoitukset → Ohjaamo).",
  "needs-install": "Lisää ohjaamo ensin Koti-valikkoon — iOS sallii ilmoitukset vain asennetulle sovellukselle.",
  unsupported: "Tämä selain ei tue ilmoituksia. Käytä puhelinta, jolle ohjaamo on asennettu.",
};

/** Neljä kytkintä, samat neljä kuin palvelimen liipaisimet. Sanamuoto on
 *  tapahtuman kieltä eikä koodin: operaattori valitsee mistä hän haluaa
 *  puhelimen piippaavan, ei mitä muuttujaa hän asettaa. */
const PREF_ROWS: Array<{ key: keyof NotificationPrefs; label: string; hint: string }> = [
  { key: "startup", label: "Valmistelu ja käynnistys", hint: "Lähetyspari valmiina, lähetys käynnistyi, este valmistelussa" },
  { key: "broken", label: "Lähetys rikki", hint: "Vika ei korjaantunut itsestään minuutissa" },
  { key: "ended", label: "Lähetys päättyi", hint: "Siivous on tehty" },
  { key: "autoFix", label: "Automaattiset korjaukset", hint: "Ohjaamo korjasi jotain omin päin" },
];

export function PushCheck({ notify }: Props) {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readPushStatus().then(setStatus);
    void getPushPrefs()
      .then(setPrefs)
      .catch(() => setPrefs(null));
  }, []);

  /** MUST stay synchronous down to `enablePush()`: iOS spends the tap gesture
   *  on the first await, and the permission prompt would never appear. */
  const turnOn = () => {
    setBusy(true);
    enablePush()
      .then((next) => {
        setStatus(next);
        notify("ok", "Ilmoitukset otettu käyttöön tällä puhelimella.");
      })
      .catch((err: unknown) => notify("error", err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const test = async () => {
    setBusy(true);
    try {
      const result = await sendTestPush();
      notify(
        result.sent > 0 ? "ok" : "error",
        result.sent > 0
          ? `Testi-ilmoitus lähetetty ${result.sent} laitteeseen.`
          : "Testi-ilmoitus ei mennyt perille yhteenkään laitteeseen.",
      );
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const flip = async (key: keyof NotificationPrefs) => {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    try {
      setPrefs(await setPushPrefs({ [key]: next[key] }));
    } catch (err) {
      setPrefs(prefs);
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="sheet__section" data-testid="push-check">
      <h3 className="sheet__heading">Ilmoitukset</h3>

      <p className={`sheet__lead ${status === "on" ? "is-ok" : status === "blocked" ? "is-fail" : "is-warn"}`}>
        {status ? STATUS_TEXT[status] : "Tarkistetaan…"}
      </p>

      {status === "off" && (
        <button type="button" className="btn btn--primary btn--wide" disabled={busy} onClick={turnOn} data-testid="push-enable">
          Ota ilmoitukset käyttöön
        </button>
      )}
      {status === "on" && (
        <button type="button" className="btn btn--ghost btn--wide" disabled={busy} onClick={() => void test()} data-testid="push-test">
          Lähetä testi-ilmoitus
        </button>
      )}

      {prefs && (
        <div className="sheet__toggles" data-testid="push-prefs">
          {PREF_ROWS.map((row) => (
            <button
              key={row.key}
              type="button"
              className={`toggle ${prefs[row.key] ? "toggle--on" : ""}`}
              role="switch"
              aria-checked={prefs[row.key]}
              onClick={() => void flip(row.key)}
            >
              <span className="toggle__body">
                <span className="toggle__label">{row.label}</span>
                <span className="toggle__hint">{row.hint}</span>
              </span>
              <span className="toggle__lamp" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
