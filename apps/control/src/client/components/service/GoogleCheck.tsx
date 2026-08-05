import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthHealth, DeviceFlowStart } from "../../api";
import { api } from "../../api";

/** Google-yhteys huoltoarkissa (#188, päätös #176).
 *
 *  Koko yhteys kutistuu **yhteen kuittaukseen**: hyvänä päivänä tässä lukee
 *  "Google-yhteys kunnossa" ja alla kanavan nimi — ei scopeja, ei tokenin ikää,
 *  ei client id:tä. Ne ovat koneen kirjanpitoa, ja operaattorin ainoa kysymys
 *  on "toimiiko tämä huomenna". Vasta kun vastaus on ei, kortti kasvaa: silloin
 *  varoitukset näytetään sellaisenaan ja uusintanappi on käskymuodossa.
 *
 *  Vanhenemisesta ja kiintiöstä EI tarvitse tulla katsomaan tänne — ne
 *  piippaavat puhelimeen omana varoituksenaan (`server/authWatch.ts`). Tämä
 *  pinta on se paikka, johon se push lähettää.
 *
 *  Laitevirta on ainoa tapa yhdistää: koodi ja osoite ruudulle, ja pollaus
 *  kunnes Google kertoo tuloksen. Kenttiä ei ole — client id ja secret ovat
 *  palvelimen tietoa (#176), eikä niitä kysytä käyttöliittymässä. */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
}

/** Kiintiöstä puhutaan prosentteina, koska "8123/10000 yksikköä" ei kerro
 *  operaattorille mitään: hän ei tiedä mitä yksikkö maksaa. */
function quotaLine(health: AuthHealth): string {
  const { used, limit } = health.quota;
  if (limit <= 0) return "Päivän kiintiötä ei saada luettua.";
  const share = Math.round((used / limit) * 100);
  if (share >= 80) return `Päivän YouTube-kiintiöstä on käytetty ${share} % — lähetysparin luonti voi estyä tänään.`;
  return `Päivän YouTube-kiintiöstä on käytetty ${share} %.`;
}

export function GoogleCheck({ notify }: Props) {
  const [health, setHealth] = useState<AuthHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DeviceFlowStart | null>(null);
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Arkin sulkeminen purkaa tämän komponentin, mutta kesken oleva pollauskutsu
   *  ei tiedä siitä: ilman lippua sen `.then` ajastaisi uuden kierroksen, jota
   *  mikään ei enää pysäytä — laitevirta jäisi kysymään Googlelta viiden
   *  sekunnin välein loppusessioksi. */
  const alive = useRef(true);

  const read = useCallback(async () => {
    try {
      setHealth(await api.youtubeHealth());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [read]);

  /** Laitevirran pollaus. Google kertoo itse millä välillä sitä saa kysyä
   *  (`intervalSec`), ja sitä noudatetaan — tiheämpi pollaus vastataan
   *  `slow_down`illa, joka pidentäisi kirjautumista eikä nopeuttaisi. */
  const poll = useCallback(
    async (intervalSec: number) => {
      try {
        const result = await api.youtubeAuthPoll();
        if (!alive.current) return;
        if (result.status === "connected") {
          setPending(null);
          notify("ok", "Google-yhteys muodostettu.");
          await read();
          return;
        }
        if (result.status === "expired" || result.status === "denied" || result.status === "none") {
          setPending(null);
          notify("error", result.message);
          await read();
          return;
        }
        const next = result.status === "slow_down" ? intervalSec + 5 : intervalSec;
        pollTimer.current = setTimeout(() => void poll(next), next * 1000);
      } catch (err) {
        if (!alive.current) return;
        setPending(null);
        notify("error", err instanceof Error ? err.message : String(err));
      }
    },
    [notify, read],
  );

  const startFlow = async () => {
    setBusy(true);
    try {
      // Tyhjä runko: palvelin käyttää omaa client-konfiguraatiotaan. Kenttiä
      // ei ole, koska UI ei kysy eikä näytä tunnisteita (#176).
      const started = await api.youtubeAuthStart({});
      setPending(started);
      pollTimer.current = setTimeout(() => void poll(started.intervalSec), started.intervalSec * 1000);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <section className="sheet__section" data-testid="google-check">
        <h3 className="sheet__heading">Google-yhteys</h3>
        <p className="sheet__lead is-fail">Yhteyden tilaa ei saada luettua: {error}</p>
      </section>
    );
  }

  if (!health) {
    return (
      <section className="sheet__section" data-testid="google-check">
        <h3 className="sheet__heading">Google-yhteys</h3>
        <p className="muted">Luetaan…</p>
      </section>
    );
  }

  const ok = health.connected && health.health === "ok";
  const live = pending ?? (health.pending
    ? { ...health.pending, intervalSec: 5, instructions: "" }
    : null);

  return (
    <section className="sheet__section" data-testid="google-check">
      <h3 className="sheet__heading">Google-yhteys</h3>

      <p className={`sheet__lead ${ok ? "is-ok" : health.health === "fail" || !health.connected ? "is-fail" : "is-warn"}`}>
        {ok
          ? "Google-yhteys kunnossa"
          : health.connected
            ? "Google-yhteys vaatii huomiota"
            : "Google-yhteyttä ei ole"}
      </p>

      {health.channel && <p className="sheet__note">Kanava: {health.channel.title}</p>}

      {/* Varoitukset ovat palvelimen kirjoittamia lauseita: ne kertovat mitä
          tehdä, eivät mikä kenttä on väärin. Tämä on ainoa paikka koko
          käyttöliittymässä, jossa ne näytetään (#176). */}
      {!ok && health.warnings.length > 0 && (
        <ul className="sheet__list" data-testid="google-warnings">
          {health.warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <p className="sheet__note">{quotaLine(health)}</p>

      {live ? (
        <div className="sheet__flow" data-testid="google-flow">
          <p className="sheet__note">Avaa {live.verificationUrl} ja syötä koodi:</p>
          <p className="sheet__code num">{live.userCode}</p>
          <a className="btn btn--ghost btn--wide" href={live.verificationUrl} target="_blank" rel="noreferrer">
            Avaa Googlen sivu
          </a>
          <p className="sheet__note">Tämä sivu huomaa itse, kun kirjautuminen on valmis.</p>
        </div>
      ) : (
        <button
          type="button"
          className={`btn ${ok ? "btn--ghost" : "btn--primary"} btn--wide`}
          disabled={busy}
          onClick={() => void startFlow()}
          data-testid="google-renew"
        >
          {ok ? "Uusi yhteys" : "Yhdistä Google-tili"}
        </button>
      )}
    </section>
  );
}
