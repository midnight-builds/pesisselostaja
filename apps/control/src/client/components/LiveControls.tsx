import type { ControlKnobs, RelayProcess } from "../../shared/types";
import { duration } from "../format";
import { ConfirmButton } from "./ConfirmButton";
import { ToggleRow } from "./ToggleRow";

/** Everything that changes the running broadcast. Two rules shape the layout:
 *  stopping the relay is confirmed (uptime first), and the delay nudges are
 *  the biggest buttons on the screen because they are used mid-match, one
 *  handed, while watching the field. */

const POLL_PRESETS_MS = [2000, 3000, 5000, 8000, 12000];

interface Props {
  relay: RelayProcess;
  knobs: ControlKnobs | null;
  busy: boolean;
  onRelay: (action: "start" | "stop" | "restart") => void;
  onKnobs: (patch: Partial<ControlKnobs>) => void;
  onNudge: (deltaMs: number) => void;
}

export function LiveControls({ relay, knobs, busy, onRelay, onKnobs, onNudge }: Props) {
  return (
    <>
      <section className="card">
        <h2 className="card__title">Ajoitus</h2>
        <p className="delay__value num">
          {knobs ? `${knobs.narrationDelayMs} ms` : "–"}
          <span className="delay__unit">selostusviive</span>
        </p>
        <div className="delay__buttons">
          <button
            type="button"
            className="btn btn--nudge"
            disabled={busy || !knobs}
            onClick={() => onNudge(500)}
          >
            <span className="btn__big">Puhui liian aikaisin</span>
            <span className="btn__sub">viive +500 ms</span>
          </button>
          <button
            type="button"
            className="btn btn--nudge"
            disabled={busy || !knobs}
            onClick={() => onNudge(-500)}
          >
            <span className="btn__big">Puhui liian myöhään</span>
            <span className="btn__sub">viive −500 ms</span>
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Ohjaimet</h2>
        {!knobs && <p className="muted">Ohjausavaimia ei luettavissa (relay ei ole ajossa).</p>}

        <ToggleRow
          label="Vaihtoselostus"
          hint="Lyöjän vaihdot kuulutetaan"
          on={knobs?.announceBatterChanges ?? false}
          disabled={busy || !knobs}
          onToggle={(v) => onKnobs({ announceBatterChanges: v })}
        />
        <ToggleRow
          label="Delta-haku"
          hint="Pois päältä = täyshaku joka pollilla"
          on={knobs?.deltaFetch ?? false}
          disabled={busy || !knobs}
          onToggle={(v) => onKnobs({ deltaFetch: v })}
        />

        <div className="knob">
          <span className="knob__label">Pollausväli</span>
          <div className="chips">
            {POLL_PRESETS_MS.map((ms) => (
              <button
                key={ms}
                type="button"
                className={`chip ${knobs?.pollIntervalMs === ms ? "chip--on" : ""}`}
                disabled={busy || !knobs}
                onClick={() => onKnobs({ pollIntervalMs: ms })}
              >
                {ms / 1000} s
              </button>
            ))}
          </div>
          {knobs && !POLL_PRESETS_MS.includes(knobs.pollIntervalMs) && (
            <p className="field__hint">Nykyinen: {knobs.pollIntervalMs} ms</p>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Relay</h2>
        <p className="muted">
          {relay.activeState}
          {relay.active && relay.uptimeSec != null ? ` · ${duration(relay.uptimeSec)}` : ""}
          {relay.deployedCommit ? ` · ${relay.deployedCommit.slice(0, 7)}` : ""}
          {relay.nRestarts != null && relay.nRestarts > 0 ? ` · ${relay.nRestarts} restarttia` : ""}
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || relay.active}
            onClick={() => onRelay("start")}
          >
            Käynnistä
          </button>
          <ConfirmButton
            label="Uudelleenkäynnistä"
            confirmLabel="Vahvista: katkaisee lähetyksen"
            disabled={busy || !relay.active}
            onConfirm={() => onRelay("restart")}
          />
          <ConfirmButton
            label="Pysäytä"
            confirmLabel="Vahvista: pysäytä relay"
            disabled={busy || !relay.active}
            onConfirm={() => onRelay("stop")}
          />
        </div>
      </section>
    </>
  );
}
