import { useEffect, useState } from "react";
import type { ControlKnobs, LiveState } from "../../shared/types";
import { api, type LiveConnectionStatus } from "../api";
import { bytes, duration, since } from "../format";
import { HealthBanner } from "../components/HealthBanner";
import { LiveControls } from "../components/LiveControls";
import { NarrationList } from "../components/NarrationList";
import { PushCard } from "../components/PushCard";
import { ScorePanel } from "../components/ScorePanel";
import { StatusGrid } from "../components/StatusGrid";

/** The default view. Order is deliberate and must survive edits: health,
 *  status grid, score, narration — all above the fold — then the controls. */

interface Props {
  live: LiveState | null;
  connection: LiveConnectionStatus;
  notify: (kind: "ok" | "error", text: string) => void;
}

function sameKnobs(a: ControlKnobs, b: ControlKnobs): boolean {
  return (
    a.announceBatterChanges === b.announceBatterChanges &&
    a.narrationDelayMs === b.narrationDelayMs &&
    a.deltaFetch === b.deltaFetch &&
    a.pollIntervalMs === b.pollIntervalMs
  );
}

export function LiveView({ live, connection, notify }: Props) {
  const [busy, setBusy] = useState(false);
  /** The SSE push lags a knob write by up to one poll; showing the server's
   *  answer immediately keeps the switches from flicking back. */
  const [override, setOverride] = useState<ControlKnobs | null>(null);

  const serverKnobs = live?.knobs ?? null;
  useEffect(() => {
    if (override && serverKnobs && sameKnobs(override, serverKnobs)) setOverride(null);
  }, [serverKnobs, override]);

  if (!live) {
    return (
      <div className="view">
        <section className="health health--idle">
          <div className="health__top">
            <span className="health__word">Yhdistetään</span>
          </div>
          <p className="health__headline">Haetaan tilaa ohjauspalvelimelta…</p>
        </section>
      </div>
    );
  }

  const knobs = override ?? live.knobs;

  const run = async <T,>(work: () => Promise<T>, okText: string) => {
    setBusy(true);
    try {
      const result = await work();
      notify("ok", okText);
      return result;
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const relayUptime =
    live.relay.active && live.relay.uptimeSec != null
      ? `Käynnissä ${duration(live.relay.uptimeSec)}`
      : null;

  return (
    <div className="view">
      <HealthBanner
        health={live.health}
        headline={live.headline}
        sub={relayUptime}
        connection={connection}
      />
      <StatusGrid chain={live.chain} />
      <ScorePanel match={live.match} />
      <NarrationList lines={live.narration} telemetry={live.telemetry} relay={live.relay} />

      <LiveControls
        relay={live.relay}
        knobs={knobs}
        busy={busy}
        onRelay={(action) => {
          void run(
            () => api.relay(action),
            action === "start"
              ? "Relay käynnistetty"
              : action === "stop"
                ? "Relay pysäytetty"
                : "Relay uudelleenkäynnistetty",
          );
        }}
        onKnobs={(patch) => {
          void run(async () => {
            const next = await api.knobs(patch);
            setOverride(next);
            return next;
          }, "Asetus tallennettu");
        }}
        onNudge={(deltaMs) => {
          void run(async () => {
            const next = await api.delayNudge(deltaMs);
            setOverride(next);
            return next;
          }, deltaMs > 0 ? "Viive +500 ms" : "Viive −500 ms");
        }}
      />

      <section className="card">
        <h2 className="card__title">Järjestelmä</h2>
        <dl className="kv">
          <div className={live.system.diskCritical ? "kv__row kv__row--fail" : "kv__row"}>
            <dt>Levy vapaana</dt>
            <dd className="num">
              {bytes(live.system.diskFreeBytes)} / {bytes(live.system.diskTotalBytes)}
              {live.system.diskCritical && " — kriittinen"}
            </dd>
          </div>
          <div className="kv__row">
            <dt>Muisti vapaana</dt>
            <dd className="num">
              {bytes(live.system.memFreeBytes)} / {bytes(live.system.memTotalBytes)}
            </dd>
          </div>
          <div className="kv__row">
            <dt>Kuorma</dt>
            <dd className="num">
              {live.system.load1.toFixed(2)} / {live.system.cpuCount} ydintä
            </dd>
          </div>
          <div className="kv__row">
            <dt>Viimeisin tapahtuma</dt>
            <dd>{since(live.match.lastEventAt, live.now)}</dd>
          </div>
        </dl>
      </section>

      {/* Last: set up once, then never touched during a match. */}
      <PushCard notify={notify} />
    </div>
  );
}
