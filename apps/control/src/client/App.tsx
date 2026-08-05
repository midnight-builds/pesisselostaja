import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, LiveState } from "../shared/types";
import { isJobClosed } from "../shared/jobState";
import { connectLive, type LiveConnectionStatus } from "./api";
import { MatchPicker } from "./components/MatchPicker";
import { ServiceSheet } from "./components/ServiceSheet";
import { StateCard } from "./components/StateCard";
import { Toast, type ToastMessage } from "./components/Toast";
import { fiTime } from "./format";

/** Kuori: ei navigaatiota lainkaan (#173, variantti A).
 *
 *  Etusivu on aina yksi tilakortti — "tämä ottelu, tässä tilassa" — ja ilman
 *  aktiivista ottelua sen alla on ottelun valinta. Välilehtiä ei ole: kuusi
 *  välilehteä oli itse ongelma, ei niiden sisältö (#168, #178).
 *
 *  **Valinnan totuuslähde on palvelin.** Se mikä ottelu on valittu tulee
 *  SSE-virran `LiveState.job`-kentästä eikä tämän kuoren tilasta — kaksi
 *  rinnakkaista työvalitsinta oli #129:n ja #165:n juurisyy (#169). Tässä
 *  pidetään vain se työ, jonka juuri luotiin, siihen asti kunnes palvelin
 *  kertoo saman: aggregaattori tikittää 5 s välein, ja niin kauan valinta
 *  näyttäisi menneen hukkaan. */

export function App() {
  const [live, setLive] = useState<LiveState | null>(null);
  const [connection, setConnection] = useState<LiveConnectionStatus>("connecting");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  /** Juuri luotu työ, jota palvelin ei ole vielä ehtinyt julkaista. */
  const [pending, setPending] = useState<Job | null>(null);
  /** Tässä käyttöliittymässä peruttu työ: sitä ei näytetä vaikka palvelimen
   *  edellinen tikki kertoisi sen vielä olevan valinta. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /** Huoltoarkki auki (#188). Ei reittiä eikä tilaa palvelimella: arkki on
   *  ohikiitävä ja sen sulkeminen palauttaa aina ottelupäivän polulle. */
  const [service, setService] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => connectLive({ onState: setLive, onStatus: setConnection }), []);

  const notify = useCallback((kind: "ok" | "error", text: string) => {
    setToast({ id: Date.now(), kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // Errors linger; confirmations get out of the way fast.
    toastTimer.current = setTimeout(() => setToast(null), kind === "error" ? 8000 : 3000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const served = live?.job ?? null;
  // Palvelin voittaa heti kun se puhuu samasta työstä — tai jostain muusta,
  // mikä tarkoittaa että valinta on ehtinyt muuttua toisaalla.
  useEffect(() => {
    if (pending && served && served.id === pending.id) setPending(null);
    if (dismissed && served?.id !== dismissed) setDismissed(null);
  }, [served, pending, dismissed]);

  const job = served && served.id === dismissed ? null : (served ?? pending);
  const showPicker = !job || isJobClosed(job.status);

  return (
    <div className="app">
      <div className="safe-top" />
      <header className="topbar">
        {/* Otsikko ja meta ovat topbarin ruudukossa omina soluinaan, eivät
            sisäkkäisessä sarakkeessa: metarivi saa koko leveyden, joten
            ajastushetki ei katkea kolmeen pisteeseen sen takia, että riville
            lisättiin hammasratas (#188). Kellonaika on rivin viimeisenä ja
            oikeat sarja- ja kenttänimet ovat fixtuureja pidempiä. */}
        <span className="topbar__title">{job ? `${job.home} – ${job.away}` : "Ohjaamo"}</span>
        {job && (
          <span className="topbar__meta">
            {/* Kellonaika ensin: jos rivi jostain syystä katkeaa, katkeaa
                kenttänimen häntä eikä ajastushetki. */}
            {[job.startsAt ? `klo ${fiTime(job.startsAt)}` : null, job.seriesName, job.stadium]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
        <span className={`conn conn--${connection}`}>
          {connection === "open" ? "yhteys ok" : connection === "connecting" ? "yhdistetään" : "yhteys poikki"}
        </span>
        {/* Ainoa navigaatio koko sovelluksessa, ja se johtaa pois ottelupäivän
            polulta: huolto on olemassa vain kun jokin on rikki (#173). */}
        <button
          type="button"
          className="gear"
          aria-label="Huolto"
          onClick={() => setService(true)}
          data-testid="gear"
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </header>

      {/* Ottelun aikana näkymä EI vieri: viisi tietoa ja kaksi säätöä pysyvät
          paikoillaan 393 px:n ruudulla, ja ainoa vierivä lohko on selostuslista
          oman laatikkonsa sisällä (#173, #186). Siksi sarake venytetään
          ruudun mittaiseksi vain siinä tilassa — muissa tiloissa sisältö saa
          kasvaa ja sivu vierii normaalisti. */}
      <main className="scroll">
        <div className={`view ${job?.status === "live" ? "view--glance" : ""}`}>
          <StateCard
            job={job}
            live={live}
            notify={notify}
            onCleared={(jobId) => {
              setPending(null);
              setDismissed(jobId);
            }}
          />
          {showPicker && (
            <MatchPicker
              notify={notify}
              onSelected={(created) => {
                setDismissed(null);
                setPending(created);
              }}
            />
          )}
        </div>
      </main>
      {/* Kotipalkin kaista (#207): ilman sitä alin säädin jää sen alle. */}
      <div className="safe-bottom" />

      {service && <ServiceSheet live={live} notify={notify} onClose={() => setService(false)} />}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
