import { useEffect, useRef, useState } from "react";

/** Copy-to-clipboard with a visible result.
 *
 *  Two things this must survive on the device it is used from:
 *
 *  1. `navigator.clipboard` exists only in a secure context. The app is served
 *     over the tailnet's real certificate so it normally does, but a fallback
 *     through a hidden textarea + execCommand keeps the button working if the
 *     app is ever opened over plain http (an IP, a port-forward) — the share
 *     message is useless if it cannot leave the phone.
 *  2. The button says whether it worked. A silent copy that failed means the
 *     operator pastes the PREVIOUS clipboard content into the team's chat. */

interface Props {
  /** Exact text to place on the clipboard. */
  text: string;
  label: string;
  className?: string;
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission refused or not a secure context — fall through.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  if (!ok) throw new Error("Kopiointi ei onnistunut — valitse teksti käsin.");
}

export function CopyButton({ text, label, className }: Props) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await writeClipboard(text);
      setState("done");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };

  return (
    <button type="button" className={`btn btn--ghost ${className ?? ""}`} onClick={() => void copy()}>
      {state === "done" ? "Kopioitu" : state === "failed" ? "Kopiointi ei onnistunut" : label}
    </button>
  );
}
