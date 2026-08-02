/** PROTOTYPE — wayfinder-tiketti #173, kartta #168. HEITTOPOIS-KOODI.
 *
 *  Kolme rakenteeltaan erilaista luonnosta uudesta ohjaamosta 393 px:n
 *  ruudulle, vaihdettavissa kelluvasta palkista tai ?variant=A|B|C.
 *  Ei oikeaa dataa, ei oikeita mutaatioita — kaikki nimet keksittyjä.
 *
 *  A — "Tilakortti": ei navigaatiota lainkaan; yksi kortti jonka sisältö ja
 *      ainoa päänappi seuraavat työn tilaa. Huolto hammasrattaan takana.
 *  B — "Vaihejana": ottelupäivä pystysuorana vaihejanana (ajastus →
 *      käynnistys → ottelu → valmis); kaksi välilehteä: Ottelu / Huolto.
 *  C — "Kojelauta": kertasilmäys ensin — kiinteä tilanauha ylhäällä,
 *      "Seuraavaksi"-toimintopalkki alhaalla, huolto ⋯-arkissa.
 */
import { useEffect, useState, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Keksitty tila (fiktiiviset joukkueet ja pelaajat)                   */
/* ------------------------------------------------------------------ */

type Phase = "no_match" | "scheduled" | "arming" | "live" | "done";

const PHASES: Array<{ id: Phase; label: string }> = [
  { id: "no_match", label: "Ei ottelua" },
  { id: "scheduled", label: "Ajastettu" },
  { id: "arming", label: "Käynnistysikkuna" },
  { id: "live", label: "Ottelu käynnissä" },
  { id: "done", label: "Valmis" },
];

const FAKE = {
  match: "Kaislarannan Kaiku – Myrskylahden Myrsky",
  series: "P12 Itä · Kenttä 2",
  start: "12:30",
  score: { home: 3, away: 2, period: "2. jakso", palot: "2. palo", batting: "Myrskylahti sisällä" },
  delayMs: 4000,
  narration: [
    { t: "12:47:10", text: "Juoksun löi Aaltola, tuojana Virtapuro.", state: "puhuttu" },
    { t: "12:47:41", text: "Toinen palo.", state: "puhuttu" },
    { t: "12:48:02", text: "Vuorossa Säteri.", state: "jonossa" },
  ],
  matches: [
    { id: 1, name: "Kaislarannan Kaiku – Myrskylahden Myrsky", info: "P12 Itä · 12:30 · Kenttä 2" },
    { id: 2, name: "Utuniemen Usva – Salamasaaren Salama", info: "P12 Itä · 14:00 · Kenttä 2" },
    { id: 3, name: "Hiljanharjun Hehku – Pyryvaaran Pyry", info: "T12 Länsi · 12:30 · Kenttä 4" },
  ],
};

/* ------------------------------------------------------------------ */
/* Yhteiset pikkukappaleet                                             */
/* ------------------------------------------------------------------ */

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="proto-card">
      {title && <h3 className="proto-card__title">{title}</h3>}
      {children}
    </section>
  );
}

/** Viisi ottelunaikaista faktaa + kaksi säätöä (#169:n käyttötiheysjako). */
function LiveGlance({ delay, setDelay }: { delay: number; setDelay: (n: number) => void }) {
  const [vaihto, setVaihto] = useState(true);
  return (
    <>
      <div className="proto-glance">
        <div className="proto-glance__health proto-glance__health--ok">Kaikki kunnossa</div>
        <div className="proto-glance__facts">
          <span>Selostus: <b>puhuu</b></span>
          <span>Raakalähetys: <b>live</b></span>
          <span className="proto-glance__score">
            <b>{FAKE.score.home}–{FAKE.score.away}</b> · {FAKE.score.period} · {FAKE.score.palot}
          </span>
          <span>{FAKE.score.batting}</span>
        </div>
      </div>
      <div className="proto-knobs">
        <div className="proto-knob">
          <span>Viive</span>
          <button onClick={() => setDelay(delay - 500)}>−500</button>
          <b className="proto-knob__val">{delay} ms</b>
          <button onClick={() => setDelay(delay + 500)}>+500</button>
        </div>
        <label className="proto-knob">
          <span>Vaihtoselostus</span>
          <input type="checkbox" checked={vaihto} onChange={() => setVaihto(!vaihto)} />
        </label>
      </div>
      <Card title="Selostuslista">
        {FAKE.narration.map((n, i) => (
          <div key={i} className={`proto-narr proto-narr--${n.state}`}>
            <span className="proto-narr__t">{n.t}</span>
            <span>{n.text}</span>
            <span className="proto-narr__state">{n.state}</span>
          </div>
        ))}
      </Card>
    </>
  );
}

function MatchPicker({ onPick }: { onPick: () => void }) {
  return (
    <Card title="Valitse ottelu">
      {FAKE.matches.map((m) => (
        <button key={m.id} className="proto-match" onClick={onPick}>
          <b>{m.name}</b>
          <span className="proto-muted">{m.info}</span>
        </button>
      ))}
    </Card>
  );
}

const MAINT_ITEMS = ["Asetukset", "Google-valtuutus", "Ilmoitukset", "Loki", "Videot"];

function MaintList() {
  return (
    <>
      {MAINT_ITEMS.map((m) => (
        <button key={m} className="proto-match">
          <b>{m}</b>
        </button>
      ))}
    </>
  );
}

/** Tilakohtainen otsikko + ainoa seuraava teko (#170: tila kertoo mitä näytetään). */
const STATE_COPY: Record<Phase, { word: string; detail: string; action: string | null }> = {
  no_match: { word: "Ei aktiivista ottelua", detail: "Valitse päivän ottelu, niin ohjaamo hoitaa loput.", action: null },
  scheduled: {
    word: "Ajastettu",
    detail: `Lähetyspari luotu. Ajastin käynnistää selostuksen, kun kuvaus alkaa ~${FAKE.start}.`,
    action: null,
  },
  arming: {
    word: "Odottaa kuvausta",
    detail: "Ajastin tarkkailee raakalähetystä. Saat ilmoituksen, kun lähetys on käynnissä — mitään ei tarvitse tehdä.",
    action: "Käynnistä käsin (jos ajastin luovuttaa)",
  },
  live: { word: "Lähetys käynnissä", detail: "", action: null },
  done: {
    word: "Ottelu valmis",
    detail: "Selostus ja lähetykset päättyivät itsestään. Tallenne on soittolistassa.",
    action: null,
  },
};

/* ------------------------------------------------------------------ */
/* Variantti A — Tilakortti                                            */
/* ------------------------------------------------------------------ */

function VariantA({ phase, setPhase }: VariantProps) {
  const [maint, setMaint] = useState(false);
  const [delay, setDelay] = useState(FAKE.delayMs);
  const c = STATE_COPY[phase];
  return (
    <div className="proto-col">
      <header className="proto-head">
        <div>
          {phase !== "no_match" && <div className="proto-muted">{FAKE.series} · {FAKE.start}</div>}
          <h2>{phase === "no_match" ? "Ohjaamo" : FAKE.match}</h2>
        </div>
        <button className="proto-gear" onClick={() => setMaint(true)} aria-label="Huolto">⚙</button>
      </header>

      <Card>
        <div className={`proto-state proto-state--${phase}`}>{c.word}</div>
        {c.detail && <p className="proto-muted">{c.detail}</p>}
        {c.action && <button className="proto-secondary">{c.action}</button>}
      </Card>

      {phase === "no_match" && <MatchPicker onPick={() => setPhase("scheduled")} />}
      {phase === "scheduled" && (
        <Card title="Jakoviesti">
          <p className="proto-muted">Katso {FAKE.match} suorana… <button className="proto-secondary">Kopioi</button></p>
        </Card>
      )}
      {phase === "live" && <LiveGlance delay={delay} setDelay={setDelay} />}
      {phase === "done" && (
        <Card>
          <button className="proto-secondary" onClick={() => setPhase("no_match")}>Seuraava ottelu</button>
        </Card>
      )}

      {maint && (
        <div className="proto-sheet" onClick={() => setMaint(false)}>
          <div className="proto-sheet__panel" onClick={(e) => e.stopPropagation()}>
            <h3>Huolto</h3>
            <MaintList />
            <button className="proto-secondary" onClick={() => setMaint(false)}>Takaisin</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Variantti B — Vaihejana                                             */
/* ------------------------------------------------------------------ */

const B_STEPS: Array<{ id: Phase; label: string }> = [
  { id: "scheduled", label: "Ajastus" },
  { id: "arming", label: "Käynnistys" },
  { id: "live", label: "Ottelu" },
  { id: "done", label: "Valmis" },
];

function VariantB({ phase, setPhase }: VariantProps) {
  const [tab, setTab] = useState<"match" | "maint">("match");
  const [delay, setDelay] = useState(FAKE.delayMs);
  const order = B_STEPS.findIndex((s) => s.id === phase);
  return (
    <div className="proto-col proto-col--b">
      <div className="proto-col__scroll">
        {tab === "maint" ? (
          <MaintList />
        ) : phase === "no_match" ? (
          <MatchPicker onPick={() => setPhase("scheduled")} />
        ) : (
          <>
            <header className="proto-head"><h2>{FAKE.match}</h2></header>
            {B_STEPS.map((s, i) => {
              const state = i < order ? "past" : i === order ? "now" : "future";
              return (
                <div key={s.id} className={`proto-step proto-step--${state}`}>
                  <span className="proto-step__dot">{state === "past" ? "✓" : i + 1}</span>
                  <div className="proto-step__body">
                    <b>{s.label}</b>
                    {state === "now" && (
                      <div className="proto-step__content">
                        <p className="proto-muted">{STATE_COPY[phase].detail}</p>
                        {STATE_COPY[phase].action && <button className="proto-secondary">{STATE_COPY[phase].action}</button>}
                        {phase === "live" && <LiveGlance delay={delay} setDelay={setDelay} />}
                      </div>
                    )}
                    {state === "past" && <span className="proto-muted">valmis</span>}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
      <nav className="proto-tabs">
        <button className={tab === "match" ? "on" : ""} onClick={() => setTab("match")}>Ottelu</button>
        <button className={tab === "maint" ? "on" : ""} onClick={() => setTab("maint")}>Huolto</button>
      </nav>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Variantti C — Kojelauta                                             */
/* ------------------------------------------------------------------ */

function VariantC({ phase, setPhase }: VariantProps) {
  const [maint, setMaint] = useState(false);
  const [delay, setDelay] = useState(FAKE.delayMs);
  const c = STATE_COPY[phase];
  if (phase === "no_match") {
    return (
      <div className="proto-col">
        <header className="proto-head">
          <h2>Ohjaamo</h2>
          <button className="proto-gear" onClick={() => setMaint(!maint)}>⋯</button>
        </header>
        {maint ? <MaintList /> : <MatchPicker onPick={() => setPhase("scheduled")} />}
      </div>
    );
  }
  return (
    <div className="proto-col proto-col--c">
      <div className="proto-strip">
        <div className="proto-strip__row1">
          <span className="proto-strip__health">OK</span>
          <b className="proto-strip__score">{FAKE.score.home}–{FAKE.score.away}</b>
          <span className="proto-muted">{FAKE.score.period}</span>
          <span className="proto-strip__spacer" />
          <button className="proto-gear" onClick={() => setMaint(true)}>⋯</button>
        </div>
        <div className="proto-strip__row2">
          <span>{FAKE.match}</span>
          <span className="proto-strip__spacer" />
          <button onClick={() => setDelay(delay - 500)}>−</button>
          <span>{delay} ms</span>
          <button onClick={() => setDelay(delay + 500)}>+</button>
        </div>
      </div>
      <div className="proto-col__scroll">
        {phase === "live" ? (
          <Card title="Selostuslista">
            {FAKE.narration.map((n, i) => (
              <div key={i} className={`proto-narr proto-narr--${n.state}`}>
                <span className="proto-narr__t">{n.t}</span>
                <span>{n.text}</span>
                <span className="proto-narr__state">{n.state}</span>
              </div>
            ))}
          </Card>
        ) : (
          <Card><p className="proto-muted">{c.detail}</p></Card>
        )}
      </div>
      <div className="proto-nextbar">
        {c.action ? <button className="proto-primary">{c.action}</button> : <span>{c.word} — ei tekoja juuri nyt</span>}
      </div>
      {maint && (
        <div className="proto-sheet" onClick={() => setMaint(false)}>
          <div className="proto-sheet__panel" onClick={(e) => e.stopPropagation()}>
            <h3>Huolto</h3>
            <MaintList />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kuori: varianttivaihdin + tilavaihdin                               */
/* ------------------------------------------------------------------ */

interface VariantProps { phase: Phase; setPhase: (p: Phase) => void }

const VARIANTS = [
  { key: "A", name: "Tilakortti", comp: VariantA },
  { key: "B", name: "Vaihejana", comp: VariantB },
  { key: "C", name: "Kojelauta", comp: VariantC },
];

function readVariant(): number {
  const v = new URLSearchParams(location.search).get("variant");
  const i = VARIANTS.findIndex((x) => x.key === v);
  return i >= 0 ? i : 0;
}

export function PrototypeView() {
  const [idx, setIdx] = useState(readVariant);
  const [phase, setPhase] = useState<Phase>("live");

  const go = (next: number) => {
    const i = (next + VARIANTS.length) % VARIANTS.length;
    setIdx(i);
    const url = new URL(location.href);
    url.searchParams.set("variant", VARIANTS[i].key);
    history.replaceState(null, "", url);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "ArrowLeft") go(readVariant() - 1);
      if (e.key === "ArrowRight") go(readVariant() + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const V = VARIANTS[idx].comp;
  return (
    <div className="view proto-root">
      <style>{PROTO_CSS}</style>
      <div className="proto-phasebar">
        {PHASES.map((p) => (
          <button key={p.id} className={phase === p.id ? "on" : ""} onClick={() => setPhase(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="proto-stage">
        <V phase={phase} setPhase={setPhase} />
      </div>
      <div className="proto-switcher">
        <button onClick={() => go(idx - 1)} aria-label="Edellinen">←</button>
        <span>{VARIANTS[idx].key} — {VARIANTS[idx].name}</span>
        <button onClick={() => go(idx + 1)} aria-label="Seuraava">→</button>
      </div>
    </div>
  );
}

/* Prototyypin oma CSS — proto-etuliite, nojaa :root-tokeneihin. */
const PROTO_CSS = `
.proto-root { display: flex; flex-direction: column; gap: 8px; min-height: 100%; }
.proto-phasebar { display: flex; gap: 4px; overflow-x: auto; padding: 4px; background: repeating-linear-gradient(45deg, #333 0 8px, #222 8px 16px); border-radius: 8px; }
.proto-phasebar button { flex: 0 0 auto; font-size: 11px; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); }
.proto-phasebar button.on { background: var(--primary); color: var(--primary-ink); }
.proto-stage { flex: 1; max-width: 480px; width: 100%; margin: 0 auto; }
.proto-switcher { position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; background: #000; color: #fff; border: 2px solid #fff; border-radius: 999px; padding: 6px 12px; z-index: 60; box-shadow: 0 4px 16px rgba(0,0,0,.5); font-size: 13px; }
.proto-switcher button { background: none; border: none; color: #fff; font-size: 16px; padding: 2px 6px; }
.proto-col { display: flex; flex-direction: column; gap: 10px; padding-bottom: 120px; }
.proto-head { display: flex; align-items: start; gap: 8px; }
.proto-head h2 { margin: 0; font-size: 18px; }
.proto-head > div { flex: 1; }
.proto-gear { font-size: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; min-width: 44px; min-height: 44px; color: var(--ink); }
.proto-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius, 10px); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.proto-card__title { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.proto-muted { color: var(--muted); font-size: 13px; }
.proto-state { font-size: 20px; font-weight: 700; }
.proto-state--live { color: var(--ok); }
.proto-state--arming { color: var(--warn); }
.proto-primary { background: var(--primary); color: var(--primary-ink); border: none; border-radius: 10px; min-height: 48px; font-size: 15px; font-weight: 600; width: 100%; }
.proto-secondary { background: var(--panel-2); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; min-height: 44px; padding: 0 12px; }
.proto-match { display: flex; flex-direction: column; align-items: start; gap: 2px; text-align: left; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; min-height: 44px; color: var(--ink); width: 100%; margin-bottom: 6px; }
.proto-glance { background: var(--panel); border: 1px solid var(--ok); border-radius: 10px; padding: 10px 12px; }
.proto-glance__health--ok { color: var(--ok); font-weight: 700; }
.proto-glance__facts { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; margin-top: 4px; }
.proto-glance__score b { font-size: 16px; }
.proto-knobs { display: flex; gap: 8px; }
.proto-knob { flex: 1; display: flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; font-size: 13px; justify-content: space-between; }
.proto-knob button { min-width: 40px; min-height: 36px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); color: var(--ink); }
.proto-knob__val { font-variant-numeric: tabular-nums; }
.proto-narr { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; font-size: 13px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.proto-narr--jonossa { color: var(--muted); font-style: italic; }
.proto-narr__t { color: var(--faint); font-variant-numeric: tabular-nums; }
.proto-narr__state { color: var(--faint); font-size: 11px; }
.proto-sheet { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 50; display: flex; align-items: end; }
.proto-sheet__panel { background: var(--bg); border-radius: 16px 16px 0 0; padding: 16px; width: 100%; max-width: 480px; margin: 0 auto; max-height: 75vh; overflow: auto; }
.proto-step { display: flex; gap: 10px; }
.proto-step__dot { flex: 0 0 28px; height: 28px; border-radius: 999px; display: grid; place-items: center; border: 1px solid var(--line); background: var(--panel); font-size: 13px; }
.proto-step--now .proto-step__dot { background: var(--primary); color: var(--primary-ink); border-color: var(--primary); }
.proto-step--past .proto-step__dot { color: var(--ok); border-color: var(--ok); }
.proto-step--future { opacity: .45; }
.proto-step__body { flex: 1; padding-bottom: 14px; border-left: 0; display: flex; flex-direction: column; gap: 6px; }
.proto-step__content { display: flex; flex-direction: column; gap: 8px; }
.proto-tabs { position: fixed; bottom: 0; left: 0; right: 0; display: flex; background: var(--panel); border-top: 1px solid var(--line); z-index: 40; }
.proto-tabs button { flex: 1; min-height: 52px; background: none; border: none; color: var(--muted); font-size: 14px; }
.proto-tabs button.on { color: var(--primary); font-weight: 700; }
.proto-col--b .proto-col__scroll, .proto-col--c .proto-col__scroll { display: flex; flex-direction: column; gap: 10px; }
.proto-strip { position: sticky; top: 0; z-index: 30; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.proto-strip__row1, .proto-strip__row2 { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.proto-strip__health { color: var(--ok); font-weight: 700; }
.proto-strip__score { font-size: 18px; }
.proto-strip__spacer { flex: 1; }
.proto-strip__row2 button { min-width: 36px; min-height: 32px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); color: var(--ink); }
.proto-nextbar { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: var(--bg); border-top: 1px solid var(--line); z-index: 40; max-width: 480px; margin: 0 auto; text-align: center; color: var(--muted); font-size: 13px; }
`;
