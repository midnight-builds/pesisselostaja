import { useEffect, useRef, useState } from "react";
import type { Job, SchedulerDecision, SchedulerState } from "../../shared/types";
import { api } from "../api";
import { fiTime, untilOrSince } from "../format";

/** Käynnistysvahti — ajastetun työn oma sisältö tilakortissa (#185).
 *
 *  Käynnistysikkuna on ILMOITUSHETKI, ei vuorovaikutushetki (#170): silloin
 *  operaattori seisoo kentällä puhelin taskussa, eikä kukaan katso ruutua.
 *  Siksi tässä ei ole käynnistysnappia. Kortti vastaa yhteen kysymykseen —
 *  "käynnistyykö tämä itsestään vai pitääkö minun tehdä jotain" — ja jos vastaus
 *  on jälkimmäinen, sen rivi on käskymuodossa.
 *
 *  Vahti myös KORJAA itsensä: ajastin on oletuksena pois päältä, ja pois
 *  päältä oleva ajastin on täsmälleen se vika, jonka huomaa vasta kun lähetys
 *  ei alkanut. Kytkin ei ole operaattorin muistettava — ohjaamo kytkee sen
 *  päälle ja kertoo tekonsa jälkikäteen (#171: itsekorjaus on sallittu, kun
 *  kohteena on operaattorin itsensä valitsema ottelu). Kytkintä ei näytetä
 *  tässä lainkaan; sen paikka on huoltoarkissa (#188).
 *
 *  Ajastimen tila ei kulje SSE:ssä, joten se kysytään erikseen. Puolen minuutin
 *  tahti riittää: vahdin oma sykli on 30 s käynnistysikkunan lähellä. */

/** Ajastimen tekninen päätös operaattorin kielelle (#176).
 *
 *  Päätöksen mukana tuleva `reason` on ajastimen omaa puhetta ja sisältää
 *  yt-dlp:n sanamuotoja — sitä ei näytetä. Tässä on täsmälleen yksi lause per
 *  päätös, ja `mood` kertoo kumpaa lajia se on: `wait` = kone hoitaa, `act` =
 *  operaattorin on tehtävä jotain. */
function decisionLine(decision: SchedulerDecision): { text: string; mood: "wait" | "act" } {
  switch (decision) {
    case "idle":
      return { text: "Käynnistysvahti ei näe tätä ottelua jonossa. Tarkista valinta.", mood: "act" };
    case "waiting":
    case "source-error":
      // Molemmat ovat samaa asiaa operaattorin kannalta: kuvauspuhelimen
      // lähetystä ei vielä näy. "Ei saatu selvitettyä" on normaali vastaus
      // lähetykselle, jota ei ole vielä avattu — ei vika.
      return { text: "Raakalähetystä ei ole vielä näkynyt.", mood: "wait" };
    case "start":
      return { text: "Raakalähetys näkyy — selostus käynnistyy.", mood: "wait" };
    case "blocked-preflight":
      return { text: "Valmiustarkistus estää käynnistyksen. Korjaa yllä olevat rivit.", mood: "act" };
    case "blocked-disk":
      return { text: "Levytila on lopussa. Vapauta tilaa, tai lähetystä ei aloiteta.", mood: "act" };
    case "blocked-busy":
      return { text: "Toinen lähetys on ajossa. Lopeta se ensin, jos haluat vaihtaa.", mood: "act" };
    case "start-failed":
      return { text: "Käynnistys ei mennyt läpi. Ohjaamo yrittää uudelleen muutaman minuutin päästä.", mood: "wait" };
  }
}

/** Ajastimen viimeisin näkemys. Päällä ollessaan se on `lastAction`; juuri
 *  päälle kytketyllä vahdilla sitä ei vielä ole, jolloin kuiva-ajon `wouldHaveDone`
 *  kertoo saman asian. */
function latestDecision(scheduler: SchedulerState): SchedulerDecision | null {
  return scheduler.lastAction?.decision ?? scheduler.wouldHaveDone?.decision ?? null;
}

const POLL_MS = 30_000;

interface Props {
  job: Job;
  /** Palvelimen kello SSE-kehyksestä — sama kello joka päätti ottelun alkuajan. */
  now: string;
}

export function StartGuard({ job, now }: Props) {
  const [scheduler, setScheduler] = useState<SchedulerState | null>(null);
  const [repaired, setRepaired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Päälle kytketään korkeintaan kerran per mount: jos kytkentä ei mene läpi,
   *  uudelleenyritys joka pollilla tekisi rikkinäisestä oikeudesta silmukan. */
  const armed = useRef(false);

  useEffect(() => {
    let stopped = false;

    const read = async () => {
      try {
        let state = await api.scheduler();
        if (!state.enabled && !armed.current) {
          armed.current = true;
          state = await api.schedulerEnable(true);
          if (state.enabled && !stopped) setRepaired(true);
        }
        if (!stopped) {
          setScheduler(state);
          setError(null);
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job.id]);

  const kickoff = job.startsAt ? `klo ${fiTime(job.startsAt)}` : null;
  const relative = untilOrSince(job.startsAt, now);
  const decision = scheduler ? latestDecision(scheduler) : null;
  const line = decision ? decisionLine(decision) : null;
  // Vahti seuraa yhtä työtä kerrallaan. Jos se seuraa jotain muuta kuin sitä
  // ottelua, joka kortissa lukee, mikään muu rivi ei ole totta — tämä on sama
  // ansa kuin #155:n väärä sidonta, vain aiemmassa vaiheessa.
  const watchingOther =
    scheduler?.nextJob != null && scheduler.nextJob.id !== job.id ? scheduler.nextJob : null;

  return (
    <div className="guard" data-testid="start-guard">
      <p className="guard__lead">
        {scheduler?.enabled === false
          ? "Käynnistysvahti ei ole päällä."
          : "Käynnistysvahti päällä: selostus käynnistyy itsestään, kun raakalähetys alkaa."}
      </p>
      {(kickoff || relative) && (
        <p className="guard__when">
          {kickoff ? `Ottelu alkaa ${kickoff}` : "Ottelun alkuaika ei ole tiedossa"}
          {relative ? ` — ${relative}.` : "."}
        </p>
      )}

      <ul className="checks">
        {repaired && (
          <li className="check check--fixed">
            <span className="check__mark" aria-hidden="true">
              ↺
            </span>
            <span className="check__detail">Korjattiin: käynnistysvahti kytkettiin päälle.</span>
          </li>
        )}
        {watchingOther && (
          <li className="check check--fail">
            <span className="check__mark" aria-hidden="true">
              ✗
            </span>
            <span className="check__detail">
              Käynnistysvahti seuraa ottelua {watchingOther.home} – {watchingOther.away}, ei tätä.
            </span>
          </li>
        )}
        {line && (
          <li className={`check check--${line.mood === "act" ? "fail" : "wait"}`}>
            <span className="check__mark" aria-hidden="true">
              {line.mood === "act" ? "✗" : "·"}
            </span>
            <span className="check__detail">{line.text}</span>
          </li>
        )}
        {error && (
          <li className="check check--warn">
            <span className="check__mark" aria-hidden="true">
              ⚠
            </span>
            <span className="check__detail">Käynnistysvahdin tilaa ei saatu luettua.</span>
          </li>
        )}
      </ul>
    </div>
  );
}
