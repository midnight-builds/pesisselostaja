import { useState } from "react";
import type { Job, LiveState } from "../../shared/types";
import { NO_JOB_STATE, jobStateWord } from "../../shared/jobState";
import { api } from "../api";
import { fiTime } from "../format";
import { PrepCard } from "./PrepCard";

/** Tilakortti — ohjaamon etusivu (#173, variantti A).
 *
 *  Yksi kortti: "tämä ottelu, tässä tilassa". Otsikkosana tulee työn tilasta
 *  yhdestä sanamuotolähteestä (`shared/jobState.ts`, #174) ja selittävä lause
 *  kertoo mitä kone tekee seuraavaksi — ei mitä operaattorin pitäisi tehdä,
 *  paitsi silloin kun jotain oikeasti odotetaan häneltä (#170: käynnistysikkuna
 *  on ilmoitushetki, ei vuorovaikutushetki).
 *
 *  Kortin runko on tässä; tilakohtainen sisältö kasvaa tilakoneen järjestyksessä
 *  omissa PR:issään (#178): valmistelu → ajastettu → ottelunaikainen
 *  kertasilmäys → päättynyt → huoltoarkki. Siksi tämä kortti ei vielä väitä
 *  esimerkiksi lähetysparista mitään sellaista, mitä se ei näe. */

interface Props {
  job: Job | null;
  live: LiveState | null;
  notify: (kind: "ok" | "error", text: string) => void;
  /** Työ vaihtui pois valinnasta tässä käyttöliittymässä (peruttu). Kuori
   *  lakkaa näyttämästä sitä heti, ilman SSE:n viivettä. */
  onCleared: (jobId: string) => void;
}

export function StateCard({ job, live, notify, onCleared }: Props) {
  const [busy, setBusy] = useState(false);
  const state = job ? jobStateWord(job.status) : NO_JOB_STATE;

  const cancel = async () => {
    if (!job || busy) return;
    setBusy(true);
    try {
      await api.patchJob(job.id, { status: "cancelled" });
      onCleared(job.id);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`state state--${state.tone}`} aria-live="polite">
      <p className="state__word">{state.word}</p>
      <p className="state__detail">{detailFor(job, live)}</p>

      {/* Valmistelu kattaa molemmat sitä edeltävät tilat: luonnoksen, jolla
          lähetysparia ei vielä ole, ja ajastetun työn, jolla se on. Ne ovat sama
          hetki operaattorille — ottelu on valittu, lähetys ei ole alkanut —
          eivätkä kaksi korttia (#170). Ajastimen ja käynnistysikkunan oma
          sisältö tulee #185:ssä. */}
      {job && (job.status === "draft" || job.status === "scheduled") && (
        <PrepCard job={job} notify={notify} />
      )}

      {/* Luonnos on työ, jolle ei ole vielä luotu lähetysparia, joten sen saa
          hylätä ilman ulospäin näkyviä seurauksia — ottelunvaihto ON vahvistus
          (#171/5). Pidemmällä olevan työn toipumispolut tulevat niiden
          tilojen omissa PR:issään. */}
      {job?.status === "draft" && (
        <button type="button" className="btn btn--ghost btn--wide" disabled={busy} onClick={() => void cancel()}>
          Vaihda ottelu
        </button>
      )}
    </section>
  );
}

function detailFor(job: Job | null, live: LiveState | null): string {
  if (!job) return "Valitse päivän ottelu, niin ohjaamo hoitaa loput.";
  const kickoff = job.startsAt ? `klo ${fiTime(job.startsAt)}` : null;
  switch (job.status) {
    case "draft":
      return kickoff
        ? `Ottelu valittu, alkaa ${kickoff}. Lähetyspari on vielä luomatta.`
        : "Ottelu valittu. Lähetyspari on vielä luomatta.";
    case "scheduled":
      return kickoff
        ? `Lähetyspari on luotu. Selostus käynnistyy itsestään, kun raakalähetys alkaa — ottelu alkaa ${kickoff}.`
        : "Lähetyspari on luotu. Selostus käynnistyy itsestään, kun raakalähetys alkaa.";
    case "arming":
      return "Ohjaamo tarkkailee raakalähetystä. Saat ilmoituksen, kun selostus on käynnissä.";
    case "live":
      // Palvelimen oma yhden lauseen tiivistys ketjun tilasta — sama teksti
      // jonka vanha Live-näkymä näytti. Ottelunaikainen kertasilmäys (viisi
      // tietoa, kaksi säätöä, selostuslista) tulee tämän tilalle #186:ssa.
      return live?.headline ?? "Selostus on ajossa.";
    case "finished":
      return job.endedAt
        ? `Selostus ja lähetykset päättyivät klo ${fiTime(job.endedAt)}. Tallenne on soittolistassa.`
        : "Selostus ja lähetykset päättyivät. Tallenne on soittolistassa.";
    case "failed":
      return job.note ?? "Ajo päättyi virheeseen. Katso loki ennen kuin yrität uudelleen.";
    case "cancelled":
      return "Työ peruttiin.";
  }
}
