import { useEffect, useState } from "react";
import type { ControlSettings } from "../../../shared/types";
import { api } from "../../api";

/** Pysyväisasetukset huoltoarkissa (#133, #188).
 *
 *  Kaksi asiaa, jotka säilyvät ottelusta toiseen: jakoviestin sanamuoto ja
 *  kenttänimen siivous. Ottelunaikaiset säätimet EIVÄT ole täällä — ne ovat
 *  tilakortissa, koska ne ovat ohjausta eivätkä asetuksia.
 *
 *  Jakoviesti muokataan yhtenä tekstipalana, ei kenttä kerrallaan: se on
 *  viesti, ja operaattori arvioi sitä kokonaisuutena juuri niin kuin se
 *  liimautuu ryhmään. Ensimmäinen rivi on avaus, loput linkkirivejä — sama
 *  jako kuin palvelimen mallissa, mutta sitä ei tarvitse tietää nähdäkseen
 *  mitä on muokkaamassa. */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
}

function toText(template: ControlSettings["shareTemplate"]): string {
  return [template.opening, ...template.lines].join("\n");
}

function fromText(text: string): ControlSettings["shareTemplate"] {
  const rows = text.split("\n");
  return { opening: rows[0] ?? "", lines: rows.slice(1).filter((row) => row.trim().length > 0) };
}

export function ShareSettings({ notify }: Props) {
  const [settings, setSettings] = useState<ControlSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .settings()
      .then((value) => {
        setSettings(value);
        setDraft(toText(value.shareTemplate));
      })
      .catch(() => setSettings(null));
  }, []);

  if (!settings) {
    return (
      <section className="sheet__section" data-testid="share-settings">
        <h3 className="sheet__heading">Jakoviesti</h3>
        <p className="muted">Asetuksia ei saada juuri nyt luettua.</p>
      </section>
    );
  }

  const dirty = draft !== toText(settings.shareTemplate);
  // Tyhjä pohja ei ole muokkaus vaan vahinko: jakoviesti muodostuu siitä, ja
  // tyhjänä ryhmään lähtisi tyhjä viesti ilman linkkejä.
  const empty = draft.trim().length === 0;

  const save = async () => {
    setBusy(true);
    try {
      // Osittainen PATCH: kenttäsiivouksen kytkimet eivät saa nollautua sen
      // sivutuotteena, että viestiä muokattiin.
      const saved = await api.patchSettings({ shareTemplate: fromText(draft) });
      setSettings(saved);
      setDraft(toText(saved.shareTemplate));
      notify("ok", "Jakoviestin pohja tallennettu.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const flipVenue = async (key: keyof ControlSettings["venueCleanup"]) => {
    const next = { ...settings.venueCleanup, [key]: !settings.venueCleanup[key] };
    const previous = settings;
    setSettings({ ...settings, venueCleanup: next });
    try {
      setSettings(await api.patchSettings({ venueCleanup: next }));
    } catch (err) {
      setSettings(previous);
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="sheet__section" data-testid="share-settings">
      <h3 className="sheet__heading">Jakoviesti</h3>
      <p className="sheet__note">
        Ensimmäinen rivi on avaus, loput linkkirivejä. Aaltosulkeissa olevat kohdat täytetään
        ottelun tiedoilla.
      </p>
      <textarea
        className="field__input sheet__textarea"
        rows={5}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        data-testid="share-template"
      />
      <button
        type="button"
        className="btn btn--primary btn--wide"
        disabled={busy || !dirty || empty}
        onClick={() => void save()}
        data-testid="share-save"
      >
        {dirty ? "Tallenna jakoviesti" : "Tallennettu"}
      </button>
      {empty && (
        <p className="sheet__lead is-warn" data-testid="share-empty">
          Jakoviesti ei voi olla tyhjä — silloin ryhmään lähtisi viesti ilman linkkejä.
        </p>
      )}

      <div className="sheet__toggles">
        <button
          type="button"
          className={`toggle ${settings.venueCleanup.stripFieldNumber ? "toggle--on" : ""}`}
          role="switch"
          aria-checked={settings.venueCleanup.stripFieldNumber}
          onClick={() => void flipVenue("stripFieldNumber")}
        >
          <span className="toggle__body">
            <span className="toggle__label">Siisti kenttänumero</span>
            <span className="toggle__hint">"Keskuskenttä 2" → "Keskuskenttä"</span>
          </span>
          <span className="toggle__lamp" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`toggle ${settings.venueCleanup.stripQualifier ? "toggle--on" : ""}`}
          role="switch"
          aria-checked={settings.venueCleanup.stripQualifier}
          onClick={() => void flipVenue("stripQualifier")}
        >
          <span className="toggle__body">
            <span className="toggle__label">Siisti kentän tarkenne</span>
            <span className="toggle__hint">Sulkeissa olevat lisäykset pois otsikoista</span>
          </span>
          <span className="toggle__lamp" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
