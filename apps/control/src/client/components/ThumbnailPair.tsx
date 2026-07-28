import { useEffect, useState } from "react";
import type { ThumbnailRequest } from "../api";
import { fetchThumbnailPreview } from "../api";

/** Both thumbnail variants, side by side.
 *
 *  DESIGN.md's "esikatselu on totuus": /api/thumbnail/preview runs the exact
 *  same PIL composer as the render that is later uploaded, so what is on
 *  screen here is the file — not an approximation drawn in CSS. That is the
 *  whole reason this component fetches PNG bytes instead of styling a div.
 *
 *  Both variants are always shown, never one behind a toggle: the badge is the
 *  only difference between them and it is exactly the thing worth checking,
 *  and the headline shortening (templates.ts) has already lost an opponent's
 *  name once by overflowing — which is visible in the image and nowhere else. */

interface Props {
  headline: string;
  datetime: string;
  venue: string;
}

interface Variant {
  narrated: boolean;
  label: string;
}

const VARIANTS: Variant[] = [
  { narrated: false, label: "Normaali" },
  { narrated: true, label: "Selostettu tekoälyllä" },
];

export function ThumbnailPair({ headline, datetime, venue }: Props) {
  return (
    <div className="thumbs">
      {VARIANTS.map((variant) => (
        <Thumbnail
          key={variant.label}
          label={variant.label}
          request={{ headline, datetime, venue, narrated: variant.narrated }}
        />
      ))}
    </div>
  );
}

function Thumbnail({ label, request }: { label: string; request: ThumbnailRequest }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The object URL is revoked on every change of inputs — a preview refetched
  // on each keystroke of an override would otherwise leak a blob per render.
  useEffect(() => {
    let revoked: string | null = null;
    let stopped = false;
    setUrl(null);
    setError(null);
    fetchThumbnailPreview(request)
      .then((blob) => {
        if (stopped) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stopped = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.headline, request.datetime, request.venue, request.narrated]);

  return (
    <figure className="thumb">
      {url ? (
        <img className="thumb__img" src={url} alt={`Thumbnail-esikatselu: ${label}`} />
      ) : error ? (
        <p className="thumb__error">{error}</p>
      ) : (
        <p className="thumb__loading">Renderöidään…</p>
      )}
      <figcaption className="thumb__label">{label}</figcaption>
    </figure>
  );
}
