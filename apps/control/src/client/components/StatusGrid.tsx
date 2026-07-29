import { useState } from "react";
import type { ChainStatus } from "../../shared/types";

/** Six lamps in a grid. The detail sentence costs vertical space, so it only
 *  appears for the row the operator taps. */

interface Props {
  chain: ChainStatus[];
}

export function StatusGrid({ chain }: Props) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = chain.find((c) => c.key === openKey) ?? null;

  if (chain.length === 0) return null;

  return (
    <section className="grid-card">
      <div className="lamps">
        {chain.map((row) => (
          <button
            key={row.key}
            type="button"
            className={`lamp lamp--${row.health} ${openKey === row.key ? "lamp--open" : ""}`}
            onClick={() => setOpenKey(openKey === row.key ? null : row.key)}
            aria-expanded={openKey === row.key}
          >
            <span className="lamp__dot" />
            <span className="lamp__label">{row.label}</span>
          </button>
        ))}
      </div>
      {open && (
        <p className={`lamp__detail lamp__detail--${open.health}`}>
          <strong>{open.label}:</strong> {open.detail}
        </p>
      )}
    </section>
  );
}
