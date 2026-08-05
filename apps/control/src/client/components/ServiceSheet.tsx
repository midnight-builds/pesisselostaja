import { useEffect, useRef } from "react";
import type { LiveState } from "../../shared/types";
import { GoogleCheck } from "./service/GoogleCheck";
import { LogTail } from "./service/LogTail";
import { PushCheck } from "./service/PushCheck";
import { SchedulerCheck } from "./service/SchedulerCheck";
import { ShareSettings } from "./service/ShareSettings";

/** Huoltoarkki — kartan viimeinen tiketti (#188, päätökset #173, #176, #174).
 *
 *  Kaikki mikä EI ole ottelupäivän polkua asuu täällä, hammasrattaan takana:
 *  Google-yhteys, ilmoitukset, jakoviestin pohja ja loki. Ne eivät ole
 *  vähemmän tärkeitä — ilman niitä ei lähde mitään — mutta ne ovat kerran
 *  tehtäviä ja rikkoutuessaan tarkistettavia, eivät ottelun aikana käytettäviä
 *  (#170). Tilakortti pysyy siksi yhtenä silmäyksenä.
 *
 *  Arkki peittää näkymän kokonaan sen sijaan että se olisi puolikas: puhelimen
 *  393 px:llä puolikas arkki tarkoittaa, että kumpaakaan ei voi lukea. Se
 *  sulkeutuu taustaa napauttamalla, Escillä ja omalla napillaan — sulkeminen
 *  ei saa olla se, mitä joutuu opettelemaan.
 *
 *  **Tekninen taso on täällä ja vain täällä.** SSH:ta ei käytetä koskaan, joten
 *  huoltoarkin on riitettävä vianetsintään: lokirivit ja koneen oma
 *  tilannelause näkyvät raakana. Ottelupäivän polulla sama tieto on kielletty
 *  (#176) — ei env-arvoja, ei tiedostopolkuja, ei stream keytä missään. */

interface Props {
  live: LiveState | null;
  notify: (kind: "ok" | "error", text: string) => void;
  onClose: () => void;
}

export function ServiceSheet({ live, notify, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-layer" data-testid="service-sheet">
      <button type="button" className="sheet__backdrop" aria-label="Sulje huolto" onClick={onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label="Huolto">
        <header className="sheet__bar">
          <h2 className="sheet__title">Huolto</h2>
          <button type="button" className="btn btn--ghost sheet__close" ref={closeRef} onClick={onClose} data-testid="sheet-close">
            Sulje
          </button>
        </header>

        {/* Järjestys on vikaepäilyn järjestys: yhteys ensin (ilman sitä ei
            synny lähetysparia), sitten ilmoitukset (ilman niitä operaattori ei
            saa tietää mistään), sitten harvoin koskettava sanamuoto, ja loki
            viimeisenä — se on pisin ja sitä luetaan vain kun jokin on rikki. */}
        <div className="sheet__body">
          <GoogleCheck notify={notify} />
          <PushCheck notify={notify} />
          {/* Käynnistysvahdin kytkin (#208): kerran tehtävä valinta, ei
              ottelun aikana käytettävä säädin. Ilmoitusten jälkeen, koska
              vahdin lupaus ("saat ilmoituksen") nojaa niihin. */}
          <SchedulerCheck notify={notify} />
          <ShareSettings notify={notify} />
          <LogTail live={live} />
        </div>
      </section>
    </div>
  );
}
