/** One labelled on/off row with a thumb switch.
 *
 *  Extracted from LiveControls because the notification preferences need the
 *  exact same affordance: a full-width tap target, since these are operated
 *  one-handed while looking at a field, not at the phone. */

interface Props {
  label: string;
  hint: string;
  on: boolean;
  disabled: boolean;
  onToggle: (value: boolean) => void;
}

export function ToggleRow({ label, hint, on, disabled, onToggle }: Props) {
  return (
    <button
      type="button"
      className="knob knob--toggle"
      disabled={disabled}
      onClick={() => onToggle(!on)}
      aria-pressed={on}
    >
      <span className="knob__text">
        <span className="knob__label">{label}</span>
        <span className="knob__hint">{hint}</span>
      </span>
      <span className={`switch ${on ? "switch--on" : ""}`}>
        <span className="switch__knob" />
      </span>
    </button>
  );
}
