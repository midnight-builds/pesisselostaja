import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthHealth } from "../api";
import { api } from "../api";
import { GoogleAuthCard } from "../components/GoogleAuthCard";
import { VideoListCard } from "../components/VideoListCard";

/** YouTube-välilehti: yhteys, lähetysparin luonti, menneet videot.
 *
 *  Kolme korttia yhdellä välilehdellä, tässä järjestyksessä, koska ne ovat
 *  riippuvuusketju: ilman yhteyttä kaksi alempaa eivät voi tehdä mitään ja
 *  näyttävät AuthMissingNoticen. Siksi yhteyskortti on ylimpänä eikä omalla
 *  välilehdellään — "siirry yhdistämään" on tällä sivulla pelkkä vieritys,
 *  ei navigointi joka veisi kesken työn pois.
 *
 *  Terveys haetaan täällä eikä GoogleAuthCardissa, koska sama vastaus ratkaisee
 *  kaikkien kolmen kortin tilan: kun yhteys syntyy, `reloadToken` kasvaa ja
 *  alemmat kortit yrittävät uudelleen ilman että operaattori lataa sivua.
 *
 *  Haku tehdään vain kun välilehti on näkyvissä. Kaikki näkymät pysyvät
 *  mountattuina (ks. App.tsx), joten ilman tätä ehtoa YouTube-terveys
 *  pollattaisiin taustalla koko ottelun ajan — turhaa kiintiönkulutusta
 *  juuri sillä kiintiöllä jota `googleAuth.ts` erikseen laskee. */

export function YouTubeView({
  active,
  notify,
}: {
  active: boolean;
  notify: (kind: "ok" | "error", text: string) => void;
}) {
  const [health, setHealth] = useState<AuthHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const authRef = useRef<HTMLDivElement | null>(null);
  /** Edellinen yhteystila, jotta `reloadToken` kasvaa vain kun se oikeasti
   *  muuttuu — ei joka kerta kun terveys haetaan uudelleen. */
  const wasConnected = useRef<boolean | null>(null);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.youtubeHealth();
      setHealth(next);
      setError(null);
      if (wasConnected.current !== null && wasConnected.current !== next.connected) {
        setReloadToken((n) => n + 1);
      }
      wasConnected.current = next.connected;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadHealth();
  }, [active, loadHealth]);

  const goToAuth = useCallback(() => {
    authRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <section className="view view--youtube">
      <div ref={authRef}>
        <GoogleAuthCard
          health={health}
          error={error}
          loading={loading}
          onReload={() => void loadHealth()}
          notify={notify}
        />
      </div>
      <VideoListCard active={active} notify={notify} onGoToAuth={goToAuth} reloadToken={reloadToken} />
    </section>
  );
}
