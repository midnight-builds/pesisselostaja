/** Push triggers: turns LiveState *transitions* into a handful of
 *  notifications per broadcast.
 *
 *  The whole design constraint is restraint. The live aggregator publishes a
 *  new state every 5 seconds; a notification per poll would train the operator
 *  to swipe them away without reading, and then the one that mattered — the
 *  stream is dead and nobody is watching the phone — gets swiped away too.
 *  So three rules hold everywhere in this file:
 *
 *    1. Only edges. A condition that is still true on the next poll is not
 *       news; it was news once.
 *    2. A failure must PERSIST before it is announced. Half the "failures" a
 *       poll-based view sees heal themselves inside one cycle.
 *    3. Same tag at most once per suppression window, no matter what.
 *
 *  It attaches to the aggregator as an ordinary subscriber (index.ts), so
 *  live.ts's own logic is untouched: a bug in here can drop notifications, but
 *  it cannot change what the phone renders. */

import type { LiveState, NotificationPrefs, PreflightResult } from "../shared/types.js";
import { blockedPushTitle, jobArrivalPush, jobEndedPush } from "../shared/jobState.js";
import { sendPushDetailed } from "./push.js";
import { createStore } from "./store.js";

/** How long health must stay "fail" before we call it broken. The fast poll is
 *  5 s, so this is twelve consecutive failing observations — long enough that a
 *  single slow systemctl, one journald hiccup or a relay restarting itself
 *  cannot buzz the phone, short enough that a genuinely dead stream is reported
 *  while there is still a match left to save. */
const FAIL_CONFIRM_MS = 60_000;

/** Hard ceiling on repeats of the same tag. Even if the state machine somehow
 *  flaps, one phone buzz per subject per 10 minutes is the most it can produce. */
const REPEAT_SUPPRESS_MS = 10 * 60 * 1000;

const DEFAULT_PREFS: NotificationPrefs = {
  broken: true,
  autoFix: true,
  startup: true,
  ended: true,
};

const prefsStore = createStore<NotificationPrefs>("push-prefs.json", DEFAULT_PREFS);

export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  // Merged over the defaults so a hand-edited or older file missing a key
  // reads as "on" rather than silently disabling a trigger.
  return { ...DEFAULT_PREFS, ...(await prefsStore.read()) };
}

export async function setNotificationPrefs(patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  return prefsStore.update((current) => ({ ...DEFAULT_PREFS, ...current, ...patch }));
}

// ------------------------------------------------------------- send with tag

const lastSentAt = new Map<string, number>();
/** Milloin tagia viimeksi YRITETTIIN turhaan. Erillään onnistuneesta
 *  lähetyksestä, koska se rajoittaa eri asiaa: toistoa, ei vaimennusta. */
const lastFailedAt = new Map<string, number>();

/** Kuinka kauan odotetaan ennen kuin epäonnistunutta lähetystä yritetään
 *  uudelleen. Ilman tätä katkoksen aikana yritettäisiin joka tikillä (5 s) —
 *  mutta 10 minuutin vaimennus taas olisi sama vika kuin ennenkin. Minuutti on
 *  lyhyt suhteessa otteluun ja pitkä suhteessa push-palvelun huonoon hetkeen. */
const RETRY_AFTER_FAIL_MS = 60_000;

/** Send with the repeat guard. Returns whether it actually went out.
 *
 *  Vaimennusleima asetetaan VASTA onnistuneen toimituksen jälkeen (#205).
 *  Ennen se asetettiin ennen lähetystä ja palautusarvo oli aina `true`, vaikka
 *  `sendPush` nielee 5xx:t, aikakatkaisut ja DNS-virheet. Yksi hukkunut
 *  "Lähetys katkesi" vaiensi siis myös "Lähetys rikki" -pushin koko episodin
 *  ajaksi: puhelin ei piipannut kertaakaan, vaikka lähetys oli kuollut ja
 *  ottelu kesken — juuri se tapaus, jota varten koko mekanismi on olemassa.
 *
 *  "Meni perille" = vähintään yksi tilaus otti sen vastaan. Nolla tilausta on
 *  siis myös epäonnistuminen; se on rehellisempi kuin merkitä ilmoitetuksi
 *  jotain, jota kukaan ei nähnyt. */
async function notify(tag: string, title: string, body: string): Promise<boolean> {
  const previous = lastSentAt.get(tag);
  const now = Date.now();
  if (previous !== undefined && now - previous < REPEAT_SUPPRESS_MS) return false;
  const failed = lastFailedAt.get(tag);
  if (failed !== undefined && now - failed < RETRY_AFTER_FAIL_MS) return false;
  const result = await sendPushDetailed(title, body, { tag });
  if (result.sent === 0) {
    lastFailedAt.set(tag, now);
    return false;
  }
  lastSentAt.set(tag, now);
  lastFailedAt.delete(tag);
  return true;
}

// ------------------------------------------------------- transition tracking

interface Memory {
  /** null until the first observation: a control-server restart while a
   *  broadcast is already running must not read as "the relay just started". */
  relayActive: boolean | null;
  /** When the current unbroken run of health === "fail" began. */
  failSince: number | null;
  /** Whether this fail episode has already been announced. */
  failNotified: boolean;
  /** `<jobId>:<status>` of the previous observation, `null` when there was no
   *  job. `undefined` until the first observation — same restart rule as
   *  `relayActive`: a control-server restart while a job is already scheduled
   *  must not read as "the pair was just created". */
  jobKey: string | null | undefined;
  /** Sen työn id, jonka siivous on nähty kirjattuna, `null` kun sellaista ei
   *  ole. `undefined` ensimmäiseen havaintoon asti — sama uudelleen-
   *  käynnistyssääntö kuin yllä: eilen päättyneen ottelun siivousmerkintä ei
   *  ole tänään uutinen. */
  endedKey: string | null | undefined;
}

const memory: Memory = {
  relayActive: null,
  failSince: null,
  failNotified: false,
  jobKey: undefined,
  endedKey: undefined,
};

/** Test seam: the module keeps process-lifetime state, so a test that drives
 *  two scenarios in a row needs a way back to a clean slate. */
export function resetNotificationState(): void {
  memory.relayActive = null;
  memory.failSince = null;
  memory.failNotified = false;
  memory.jobKey = undefined;
  memory.endedKey = undefined;
  lastSentAt.clear();
  lastFailedAt.clear();
}

function matchLabel(state: LiveState): string {
  const job = state.job;
  if (!job) return "Ei aktiivista työtä";
  return `${job.home} – ${job.away}`;
}

/** Käynnistys on yksi tapahtuma kahdella reunalla (työn tila / relayn tila),
 *  joten sillä on yksi tagi. Muut siirtymät ovat työkohtaisia. */
const BROADCAST_STARTED_TAG = "broadcast-started";

function pushTag(state: LiveState): string {
  if (!state.job) return BROADCAST_STARTED_TAG;
  return state.job.status === "live" ? BROADCAST_STARTED_TAG : `job:${state.job.id}:${state.job.status}`;
}

/** Ilmoituksen leipäteksti työn saapuessa tilaan.
 *
 *  Otsikko nimeää subjektin, leipäteksti lupaa mitä seuraavaksi tapahtuu (#174).
 *  "Käynnistyy itsestään" on tarkoituksella suora lupaus: se on koko syy, miksi
 *  operaattorin ei tarvitse jäädä katsomaan ruutua käynnistysikkunassa — ja
 *  lupauksen kattaa käynnistysvahti kortin puolella (#185). */
function arrivalBody(state: LiveState): string {
  const who = matchLabel(state);
  switch (state.job?.status) {
    case "scheduled":
      return `${who} — selostus käynnistyy itsestään, kun raakalähetys alkaa.`;
    case "live":
      return `${who} — selostettu lähetys on ajossa.`;
    default:
      return who;
  }
}

/** Päättymispushin leipäteksti (#174, #187).
 *
 *  Kaksi lajia, ja järjestys on tärkeä: jos jokin jäi tekemättä, se on ainoa
 *  asia jonka operaattorin pitää lukea — auki jäänyt lähetys työntää tyhjää
 *  kunnes joku sulkee sen. Muuten kerrotaan MISTÄ lopetus pääteltiin, koska
 *  juuri se erottaa hallitun lopetuksen katkenneesta yhteydestä. */
function endedBody(state: LiveState): string {
  const who = matchLabel(state);
  const cleanup = state.job?.cleanup;
  const failed = cleanup?.actions.find((action) => !action.ok);
  if (failed) return `${who} — ${failed.detail ?? failed.what}`;
  const indicators = cleanup?.indicators ?? [];
  return indicators.length > 0 ? `${who} — ${indicators.join(" ")}` : `${who} — ottelu on ohi.`;
}

/** Called for every state the aggregator publishes.
 *
 *  The returned promise NEVER rejects — a push service outage must not
 *  propagate into the poller — so the aggregator can treat this as a plain
 *  void subscriber and ignore it. It is returned only so a test can await one
 *  observation before asserting on the next. */
export function observeLiveState(state: LiveState): Promise<void> {
  return observe(state).catch((err) => {
    console.error("[control] ilmoituslogiikka kaatui:", err);
  });
}

async function observe(state: LiveState): Promise<void> {
  const prefs = await getNotificationPrefs();
  // Server time from the payload, not Date.now(): the same clock that produced
  // the state should decide how long it has been failing.
  const now = Number.isFinite(Date.parse(state.now)) ? Date.parse(state.now) : Date.now();

  const wasActive = memory.relayActive;
  const isActive = state.relay.active;
  memory.relayActive = isActive;

  // --- Työ siirtyi tilasta toiseen: push on tilakortin siirtymän projektio.
  //
  // Sama sanamuotolähde kuin kortilla (`shared/jobState.ts`, #174): mitä
  // operaattori näkee lukitusnäytöllä, sen hän näkee kortin otsikkona kun avaa
  // ohjaamon. Tiloja on seitsemän mutta pusheja kaksi — arvo `null` on oletus,
  // ja hiljaisuus on siksi tämän kohdan tavallisin lopputulos.
  const jobKey = state.job ? `${state.job.id}:${state.job.status}` : null;
  const previousJobKey = memory.jobKey;
  memory.jobKey = jobKey;
  if (prefs.startup && previousJobKey !== undefined && jobKey !== null && jobKey !== previousJobKey) {
    const title = state.job ? jobArrivalPush(state.job.status) : null;
    if (title) {
      await notify(pushTag(state), title, arrivalBody(state));
    }
  }

  // --- Relay siirtyi ajoon.
  //
  // Sama tapahtuma kuin työn siirtymä `live`-tilaan, mutta eri reunalta nähtynä:
  // ajastimen ajossa nämä osuvat eri pollille (relay käynnistetään ennen kuin
  // työ leimataan käyntiin), ja käsikierroksella työtä ei ole lainkaan. Siksi
  // MOLEMMAT käyttävät samaa tagia: toistosuoja päästää läpi sen, kumpi ehti
  // ensin, eikä puhelin piippaa yhdestä käynnistyksestä kahdesti.
  if (prefs.startup && wasActive === false && isActive) {
    await notify(
      BROADCAST_STARTED_TAG,
      jobArrivalPush("live") ?? "Lähetys käynnistyi",
      `${matchLabel(state)} — relay on ajossa.`
    );
  }

  // --- Selostus katkesi kesken ottelun.
  //
  // Relayn poistuminen ajosta on kaksi hyvin eri asiaa. Kun ottelu on ohi, se
  // on normaali lopetus, eikä siitä piipata tässä: päivän kolmas push lähtee
  // vasta siivouksen jälkeen (alempana, #174). Kesken ottelun sama reuna on
  // vika, jonka takia operaattorin on käveltävä puhelimen luo nyt.
  let announcedMidMatchStop = false;
  if (prefs.ended && wasActive === true && !isActive && state.job && !state.match.finished) {
    announcedMidMatchStop = await notify(
      "relay-ended",
      "Lähetys katkesi",
      `${matchLabel(state)} — selostus ei ole enää ajossa, mutta ottelu on kesken.`
    );
  }

  // --- Selostettu lähetys päättyi: päivän kolmas ja viimeinen push (#174).
  //
  // Ehto EI ole työn siirtyminen `finished`-tilaan vaan siivouksen kirjaus
  // (#187): työ suljetaan sillä sekunnilla kun relay sammuu, ja lähetykset ovat
  // silloin vielä auki. Siivouksesta kertova push ennen siivousta olisi lupaus,
  // jonka operaattori tarkistaa vasta kotona.
  const endedKey = state.job?.status === "finished" && state.job.cleanup ? state.job.id : null;
  const previousEndedKey = memory.endedKey;
  memory.endedKey = endedKey;
  if (prefs.ended && previousEndedKey !== undefined && endedKey !== null && endedKey !== previousEndedKey) {
    await notify(`job:${endedKey}:ended`, jobEndedPush(), endedBody(state));
  }

  // --- Lähetys rikki eikä korjaantunut.
  if (state.health === "fail") {
    if (memory.failSince === null) {
      memory.failSince = now;
      memory.failNotified = false;
    }
    // A mid-match stop we just announced IS this failure. Marking the episode
    // as announced keeps the phone from buzzing twice about one event a minute
    // apart — the second buzz would carry no information the first didn't.
    if (announcedMidMatchStop) memory.failNotified = true;

    if (prefs.broken && !memory.failNotified && now - memory.failSince >= FAIL_CONFIRM_MS) {
      memory.failNotified = true;
      await notify("health-fail", "Lähetys rikki", state.headline);
    }
  } else {
    // Recovery is only ever reported for a failure we actually reported. Left
    // out, an operator who got "Lähetys rikki" would have no way to learn from
    // the phone that it healed — and would drive back to the field for nothing.
    if (memory.failNotified && prefs.broken) {
      await notify("health-recovered", "Lähetys taas kunnossa", state.headline);
    }
    memory.failSince = null;
    memory.failNotified = false;
  }
}

// ------------------------------------------------------------ direct triggers

/** Preflight ran and something blocks the start.
 *
 *  Called from runControlPreflight rather than from the route, so the automatic
 *  arming path in phase B (source goes live -> preflight -> start) gets the
 *  notification for free. A blocker found there is the whole reason this
 *  trigger exists: nobody is looking at the screen at that moment. A manual
 *  re-run within the suppression window stays quiet, because the operator who
 *  tapped the button is already reading the result. */
export async function notifyPreflightBlockers(
  result: PreflightResult,
  jobId: string | null = null
): Promise<void> {
  if (result.blockers === 0) return;
  const prefs = await getNotificationPrefs();
  if (!prefs.startup) return;
  // Kolmen luokan sääntö (#174): ohjaamon itse korjaamat rivit eivät ole
  // esteitä eivätkä piippaa — `blockers` laskee vain ne, jotka jäivät.
  // Jäljelle jäävä on käskymuodossa, koska se odottaa nimenomaan operaattoria.
  const failed = result.checks.filter((check) => check.status === "fail");
  const subject = failed[0]?.name ?? `${result.blockers} estettä`;
  const detail = failed.map((check) => check.detail).join(" ");
  // Tagi on työkohtainen (#205): kiinteä tagi vaimensi seuraavan esteen 10
  // minuutiksi, ja PrepCard ajaa valmiustarkistuksen joka mountissa. Klo 9:00
  // avattu ohjaamo saattoi siis vaientaa klo 9:05 tulevan käynnistyksen
  // esteen kokonaan — eikä ajastin lähetä omaa pushia, koska se luottaa
  // preflightin lähettävän täsmälleen yhden.
  await notify(
    `preflight-blocked:${jobId ?? "-"}`,
    blockedPushTitle(subject),
    detail.length > 0 ? detail : result.summary
  );
}

/** The scheduler acted (or refused to act) without anybody watching.
 *
 *  Additive on purpose: the scheduler could have called sendPush directly, but
 *  then its messages would sit outside the repeat guard above and a job stuck
 *  in "source live, preflight blocked" would buzz the phone every 30 seconds.
 *  Routed through notify() they inherit the one-per-tag-per-window ceiling like
 *  everything else.
 *
 *  Gated on `startup`, because every scheduler message is of that class —
 *  valmistelu ja käynnistys (or the reason it did not happen). Callers pass a
 *  tag that distinguishes the KIND of event and the job it concerns, so a
 *  clash on job A does not suppress a preflight block on job B. */
export async function notifySchedulerAction(
  tag: string,
  title: string,
  body: string
): Promise<boolean> {
  const prefs = await getNotificationPrefs();
  if (!prefs.startup) return false;
  return notify(`scheduler:${tag}`, title, body);
}

/** Google-yhteys vaatii tekoa: vanheneminen tai kiintiö (#176, #188).
 *
 *  Luokitellaan `startup`-preferenssin alle, koska tämä on valmistelun este —
 *  se estää lähetysparin luonnin, ei käynnissä olevaa lähetystä. Tagi on
 *  lajikohtainen, jotta vanhenemisvaroitus ei vaienna kiintiövaroitusta:
 *  ne vaativat eri teon. Reunaehdon (ei toistoa kun tilanne pysyy samana)
 *  hoitaa vartija itse, tämä vain lähettää. */
export async function notifyAuthAlert(kind: string, title: string, body: string): Promise<boolean> {
  const prefs = await getNotificationPrefs();
  if (!prefs.startup) return false;
  return notify(`auth:${kind}`, title, body);
}

/** An automatic repair was carried out.
 *
 *  Nothing calls this yet — automatic repair is phase B (DESIGN.md: "UI korjaa
 *  itse ja kertoo jälkikäteen"). The interface exists now so that when the
 *  repair lands it does not also have to invent a notification path, and so
 *  the operator's preference toggle for it is already wired end to end.
 *
 *  `what` is the action in the imperative past ("Relay käynnistettiin
 *  uudelleen"), `detail` the reason it was needed. */
export async function notifyAutoFix(what: string, detail: string): Promise<void> {
  const prefs = await getNotificationPrefs();
  if (!prefs.autoFix) return;
  // Distinct tag per repair kind: two different automatic fixes inside the
  // window are two different facts, and suppressing the second would hide it.
  await notify(`autofix:${what}`, "Automaattinen korjaus", `${what} — ${detail}`);
}
