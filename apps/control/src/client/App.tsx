import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, LiveState } from "../shared/types";
import { isJobClosed } from "../shared/jobState";
import { connectLive, type LiveConnectionStatus } from "./api";
import { MatchPicker } from "./components/MatchPicker";
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
        <span className="topbar__id">
          {job ? (
            <>
              <span className="topbar__title">
                {job.home} – {job.away}
              </span>
              <span className="topbar__meta">
                {[job.seriesName, job.stadium, job.startsAt ? `klo ${fiTime(job.startsAt)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </>
          ) : (
            <span className="topbar__title">Ohjaamo</span>
          )}
        </span>
        <span className={`conn conn--${connection}`}>
          {connection === "open" ? "yhteys ok" : connection === "connecting" ? "yhdistetään" : "yhteys poikki"}
        </span>
      </header>

      <main className="scroll">
        <div className="view">
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

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
