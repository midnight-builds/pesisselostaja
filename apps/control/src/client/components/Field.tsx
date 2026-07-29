import { useId, useState } from "react";

/** Labelled text input with an optional hint. Secrets (stream keys) render
 *  masked with a reveal toggle — the phone is often held up in public. */

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  secret?: boolean;
  inputMode?: "text" | "url" | "numeric";
  autoComplete?: string;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  secret,
  inputMode = "text",
  autoComplete = "off",
}: Props) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const masked = secret === true && !revealed;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {secret && (
          <button type="button" className="field__reveal" onClick={() => setRevealed(!revealed)}>
            {revealed ? "Piilota" : "Näytä"}
          </button>
        )}
      </label>
      <input
        id={id}
        className="field__input"
        type={masked ? "password" : "text"}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="field__hint">{hint}</p>}
    </div>
  );
}
