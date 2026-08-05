import { useEffect, useRef, useState } from "react";

/** Destructive actions (stopping a running relay) get a second tap.
 *  A pocket touch must never cut a live broadcast — and the armed state
 *  disarms itself after a few seconds so a forgotten tap is harmless. */

const ARM_MS = 5000;

interface Props {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}

export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className }: Props) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };

  const handle = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    disarm();
    onConfirm();
  };

  return (
    <button
      type="button"
      className={`btn ${armed ? "btn--danger-armed" : "btn--danger"} ${className ?? ""}`}
      onClick={handle}
      disabled={disabled}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
