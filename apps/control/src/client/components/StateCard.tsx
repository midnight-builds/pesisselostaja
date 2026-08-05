import { useState } from "react";
import type { Job, LiveState } from "../../shared/types";
import { NO_JOB_STATE, jobStateWord } from "../../shared/jobState";
import { api } from "../api";
import { duration, fiTime } from "../format";
import { EndedCard } from "./EndedCard";
import { MatchGlance } from "./MatchGlance";
import { PrepCard } from "./PrepCard";
import { StartGuard } from "./StartGuard";

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
          eivätkä kaksi korttia (#170). */}
      {job && (job.status === "draft" || job.status === "scheduled") && (
        <PrepCard job={job} notify={notify} />
      )}

      {/* Käynnistysvahti tulee valmiustarkistuksen JÄLKEEN: se on lupaus siitä
          mitä tapahtuu seuraavaksi, ja "korjaa yllä olevat rivit" osoittaa
          ylöspäin. Vasta ajastetulla työllä on lupaus annettavana — luonnokselta
          puuttuu lähetyspari, jota käynnistää (#185). */}
      {job?.status === "scheduled" && <StartGuard job={job} now={live?.now ?? new Date().toISOString()} />}

      {/* Ottelun aikana kortti on kertasilmäys: viisi tietoa, kaksi säätöä ja
          selostuslista (#186). Ilman SSE-kehystä ei ole mitään näytettävää —
          silloin jää otsikko ja sen alla oleva lause. */}
      {job?.status === "live" && live && <MatchGlance live={live} notify={notify} />}

      {/* Päättynyt ajo: mitä ohjaamo teki, mistä lopetus pääteltiin ja missä
          tallenne on (#187). Vain `finished` — `failed` ja `cancelled` ovat
          eri asia: niissä ajoa ei koskaan ollut, eikä siivottavaakaan. */}
      {job?.status === "finished" && <EndedCard job={job} live={live} />}

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

/** Sekunteja `from`-hetkestä palvelimen kelloon. Selaimen omaa kelloa ei
 *  käytetä: puhelin voi olla väärässä ajassa, ja "ajossa 3 h" kesken ottelun
 *  olisi juuri se luku, joka lähettäisi operaattorin etsimään olematonta vikaa. */
function elapsedSec(from: string | null, now: string | null | undefined): number | null {
  if (!from) return null;
  const started = Date.parse(from);
  const ref = now ? Date.parse(now) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(ref)) return null;
  return Math.max(0, Math.round((ref - started) / 1000));
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
      // Käynnistyslupaus ja alkuaika ovat käynnistysvahdin rivejä (#185) —
      // sama lause kahdesti peräkkäin lukisi kuin virhe. Tähän jää se, mitä
      // valmistelusta on jo saatu aikaan.
      return "Molemmat lähetykset on luotu ja linkit ovat jaettavissa.";
    case "arming":
      return "Ohjaamo tarkkailee raakalähetystä. Saat ilmoituksen, kun selostus on käynnissä.";
    case "live": {
      // Palvelimen `headline` EI kelpaa tähän: se on ketjun tiivistys koneen
      // kielellä ("ffmpeg respawnasi 3×", commit-tunnus), eikä koneen kieltä
      // näytetä ottelupäivän polulla (#176). Ketjun tila luetaan kertasilmäyksen
      // riveiltä; tähän jää se, mitä otsikko ei kerro — kuinka kauan on menty.
      const ran = elapsedSec(job.startedAt, live?.now);
      return ran == null
        ? "Selostus on ajossa."
        : `Selostus on ollut ajossa ${duration(ran)}.`;
    }
    case "finished":
      // Päättymisaika, kesto ja tallenne ovat kortin omalla lohkolla (#187);
      // sama tieto kahteen kertaan lukisi kuin virhe. Tähän jää se, mitä
      // lohko ei kerro: päivä on tämän ottelun osalta ohi, ja seuraavan saa
      // valita alta.
      return "Ottelupäivä on tämän ottelun osalta ohi.";
    case "failed":
      return job.note ?? "Ajo päättyi virheeseen. Katso loki ennen kuin yrität uudelleen.";
    case "cancelled":
      return "Työ peruttiin.";
  }
}
