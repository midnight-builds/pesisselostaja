/** The one thing every writing YouTube route says when there is no Google
 *  connection: HTTP 409. It is not a fault — it is a state with a next step,
 *  so it renders as an instruction with a button that goes there, never as a
 *  red "palvelinvirhe" the operator cannot act on.
 *
 *  The server's own sentence is kept underneath: it names the actual reason
 *  (never connected / refresh token expired in Testing mode), which the
 *  headline deliberately does not. */

interface Props {
  /** The server's Finnish sentence, verbatim. */
  detail: string | null;
  onGoToAuth: () => void;
}

export function AuthMissingNotice({ detail, onGoToAuth }: Props) {
  return (
    <div className="warnbox warnbox--fail">
      <strong>Google-yhteyttä ei ole muodostettu</strong>
      YouTube-toiminnot eivät ole käytettävissä ennen kuin tili on yhdistetty laitevirralla.
      {detail && <span className="warnbox__detail">{detail}</span>}
      <button type="button" className="btn btn--wide" onClick={onGoToAuth}>
        Siirry yhdistämään
      </button>
    </div>
  );
}
