import { useCallback, useEffect, useState } from "react";
import type { ControlSettings } from "../../shared/types";
import { api } from "../api";
import { ToggleRow } from "../components/ToggleRow";

/** Asetukset: ohjaamon pysyväisasetukset yhdessä paikassa (#133).
 *
 *  Rajaus on issuen oma: tänne kuuluu se mikä säilyy ottelusta toiseen —
 *  jakoviestin sanamuoto ja kenttänimen siivous. Relayn ottelunaikaiset
 *  säätimet (selostus päälle/pois, viive, pollausväli) pysyvät Live-näkymässä,
 *  koska ne ovat ohjausta eivätkä asetuksia: niitä kosketaan kesken lähetyksen
 *  ja ne menevät relayn control-tiedostoon, eivät `run/`-asetustiedostoihin.
 *
 *  Jokainen kortti tallennetaan erikseen. PATCH on osittainen, joten toisen
 *  kortin kesken jäänyt muokkaus ei voi nollata toista — leiripäivänä
 *  puhelimella tehty tallennus ei saa olla sivuvaikutuksellinen. */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
}

export function SettingsView({ notify }: Props) {
  const [settings, setSettings] = useState<ControlSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Jakoviestin pohja tekstinä: yksi rivi per linkkirivi. Erillään
   *  `settings`istä, jotta kesken kirjoittamista oleva teksti ei katoa
   *  tallennuksen palauttaessa normalisoidun arvon. */
  const [opening, setOpening] = useState("");
  const [lines, setLines] = useState("");

  const adopt = useCallback((next: ControlSettings) => {
    setSettings(next);
    setOpening(next.shareTemplate.opening);
    setLines(next.shareTemplate.lines.join("\n"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.settings().then(
      (s) => !cancelled && adopt(s),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  const save = async (patch: Partial<ControlSettings>, what: string) => {
    setBusy(true);
    try {
      adopt(await api.patchSettings(patch));
      notify("ok", `${what} tallennettu`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="view">
        <section className="card">
          <h2 className="card__title">Asetukset</h2>
          <p className="field__hint is-fail">{error}</p>
        </section>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="view">
        <section className="card">
          <h2 className="card__title">Asetukset</h2>
          <p className="muted">Haetaan…</p>
        </section>
      </div>
    );
  }

  return (
    <div className="view">
      <section className="card">
        <h2 className="card__title">Jaettava viesti</h2>
        <p className="field__hint">
          Paikkamerkit: <code>{"{time}"}</code> <code>{"{matchup}"}</code> <code>{"{watchUrl}"}</code>{" "}
          <code>{"{narratedWatchUrl}"}</code> <code>{"{matchUrl}"}</code>. Tuntematon paikkamerkki jää
          näkyviin, jotta kirjoitusvirhe huomataan esikatselusta eikä lähetetystä viestistä.
        </p>
        <label className="field">
          <span className="field__label">Aloitusrivi</span>
          <input
            className="field__input"
            value={opening}
            disabled={busy}
            onChange={(e) => setOpening(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Linkkirivit (yksi per rivi)</span>
          <textarea
            className="field__input"
            rows={4}
            value={lines}
            disabled={busy}
            data-testid="share-lines"
            onChange={(e) => setLines(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary btn--wide"
          disabled={busy}
          onClick={() =>
            void save(
              {
                shareTemplate: {
                  opening,
                  // Tyhjät rivit pois: tekstialueeseen jää helposti rivinvaihto
                  // loppuun, ja se tuottaisi tyhjän rivin jokaiseen viestiin.
                  lines: lines.split("\n").map((l) => l.trim()).filter(Boolean),
                },
              },
              "Jaettavan viestin pohja",
            )
          }
        >
          Tallenna viestipohja
        </button>
      </section>

      <section className="card">
        <h2 className="card__title">Kenttänimen siivous</h2>
        <p className="field__hint">
          Tulospalvelun kenttänimi on sisäisessä muodossaan, esim.{" "}
          <code>01 - Viinijärven pallokenttä, tekonurmi 1| LEIRITUOTANTO</code>. Siivous koskee
          otsikkoa, kuvausta, thumbnailia ja jakoviestiä — ja samaa sääntöä käyttää myös selostus,
          joten puhuttu ja kirjoitettu kenttänimi pysyvät samana.
        </p>
        <ToggleRow
          label="Pudota kenttänumero"
          hint="&quot;01 - Viinijärven pallokenttä&quot; → &quot;Viinijärven pallokenttä&quot;"
          on={settings.venueCleanup.stripFieldNumber}
          disabled={busy}
          onToggle={(value) =>
            void save(
              { venueCleanup: { ...settings.venueCleanup, stripFieldNumber: value } },
              "Kenttänimen siivous",
            )
          }
        />
        <ToggleRow
          label="Pudota tuotantomerkintä"
          hint="Kaikki &quot;|&quot;-merkistä eteenpäin, esim. &quot;| LEIRITUOTANTO&quot;"
          on={settings.venueCleanup.stripQualifier}
          disabled={busy}
          onToggle={(value) =>
            void save(
              { venueCleanup: { ...settings.venueCleanup, stripQualifier: value } },
              "Kenttänimen siivous",
            )
          }
        />
      </section>

      <section className="card">
        <h2 className="card__title">Muut asetukset</h2>
        <p className="muted">
          Lähetysten näkyvyys ja soittolista valitaan lähetyksiä luodessa YouTube-välilehdellä, koska
          ne ovat lähetyskohtaisia valintoja eivätkä pysyviä asetuksia. Käynnistysikkunan pituus on
          yhä koodivakio.
        </p>
        <p className="muted">
          Relayn ottelunaikaiset säätimet ovat Live-välilehdellä: ne ovat ohjausta kesken lähetyksen,
          eivät asetuksia.
        </p>
      </section>
    </div>
  );
}
