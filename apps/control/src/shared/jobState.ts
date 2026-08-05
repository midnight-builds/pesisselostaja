/** Yksi sanamuotolähde työn tilalle.
 *
 *  Ohjaamon etusivu on yksi tilakortti, jonka otsikko seuraa työn tilaa
 *  (#173), ja push-ilmoitus on saman siirtymän projektio — sama otsikkoteksti
 *  kuin kortissa (#174). Siksi sanat asuvat `shared/`:ssa: selain lukee ne
 *  korttiin, palvelin samat sanat pushin otsikoksi (#185), eikä kahta
 *  eriävää listaa pääse syntymään.
 *
 *  Tässä on VAIN se sana, joka nimeää tilan. Selittävä lause tarvitsee
 *  kellonaikoja ja Suomen aikavyöhykkeen, jotka ovat selaimen puolella
 *  (`client/format.ts`) — se muotoillaan siellä.
 *
 *  Sanat ovat ketjun sanastoa (`CONTEXT.md`): *selostettu lähetys* on se,
 *  jonka ohjaamo tuottaa, *raakalähetys* se, jota kuvauspuhelin työntää.
 *  Kumpaakaan ei sanota pelkkänä "lähetyksenä" silloin kun kumpi niistä on
 *  kyse ratkaisee. */

import type { JobStatus } from "./types.js";

/** Kortin sävy — kertoo CSS:lle miltä tila näyttää, ei mitä se tarkoittaa. */
export type JobStateTone = "idle" | "prep" | "wait" | "live" | "done" | "fail";

export interface JobStateWord {
  /** Kortin otsikko ja pushin otsikko. */
  word: string;
  tone: JobStateTone;
}

/** Ei työtä lainkaan: etusivu on ottelun valinta (#173). */
export const NO_JOB_STATE: JobStateWord = { word: "Ei aktiivista ottelua", tone: "idle" };

const WORDS: Record<JobStatus, JobStateWord> = {
  draft: { word: "Valmistelu kesken", tone: "prep" },
  // "Ajastettu" kertoi kellosta, ei siitä mikä on valmiina. Tila, johon työ
  // siirtyy lähetysparin luonnista, ON pari — ja koska pushin otsikko on saman
  // siirtymän projektio samasta sanamuotolähteestä (#174), kortin otsikon on
  // oltava se teksti, jonka operaattori näkee myös lukitusnäytöllä.
  scheduled: { word: "Lähetyspari valmiina", tone: "wait" },
  arming: { word: "Odottaa kuvausta", tone: "wait" },
  live: { word: "Selostettu lähetys käynnissä", tone: "live" },
  finished: { word: "Selostettu lähetys päättyi", tone: "done" },
  failed: { word: "Lähetys keskeytyi", tone: "fail" },
  cancelled: { word: "Peruttu", tone: "idle" },
};

export function jobStateWord(status: JobStatus): JobStateWord {
  return WORDS[status];
}

/** Pushin otsikko silloin kun työ SAAPUU tähän tilaan (#174).
 *
 *  Hyvänä päivänä puhelin piippaa täsmälleen kolme kertaa: lähetyspari on
 *  valmiina, lähetys käynnistyi, selostettu lähetys päättyi. Tässä ovat kaksi
 *  ensimmäistä; päättymisen push kuuluu #187:aan, koska se saa tulla vasta kun
 *  siivous on tehty — sitä tietoa ei ole työn tilassa vaan siivouspolussa.
 *
 *  Otsikko on tilan oma sana silloin kun se kelpaa lukitusnäytölle sellaisenaan
 *  ("Lähetyspari valmiina"). Käynnistyksessä ei kelpaa: kortti kuvaa vallitsevaa
 *  tilaa ("Selostettu lähetys käynnissä"), push kertoo että jokin juuri
 *  tapahtui. Molemmat asuvat tässä samassa taulukossa, jotta niitä ei voi
 *  päivittää eri suuntiin.
 *
 *  `null` = tähän tilaan saapuminen ei ole pushin arvoinen. Se on oletus:
 *  jokainen ilmoitus, joka ei kerro mitään uutta, opettaa operaattorin
 *  pyyhkäisemään ilmoitukset lukematta. */
const ARRIVAL_PUSH: Record<JobStatus, string | null> = {
  draft: null, // operaattori valitsi ottelun juuri itse — hän tietää.
  scheduled: WORDS.scheduled.word,
  arming: null, // sekunteja ennen käynnistystä; oma pushinsa olisi kohinaa.
  live: "Lähetys käynnistyi",
  finished: null, // #187: vasta siivouksen jälkeen.
  failed: null, // este-pushit kulkevat blockedPushTitle():n kautta.
  cancelled: null, // operaattorin oma teko.
};

export function jobArrivalPush(status: JobStatus): string | null {
  return ARRIVAL_PUSH[status];
}

/** Esteen push-otsikko (#174, kolmen luokan sääntö).
 *
 *  Itsestään korjautuva este ei tuota pushia lainkaan; operaattoria vaativa
 *  tuottaa täsmälleen yhden, ja se on käskymuotoinen. Kriittisyys kannetaan
 *  otsikon verbimuodolla: toteava otsikko on tiedoksi, käskevä tarkoittaa
 *  "katso nyt". `subject` on se yksi asia, jota odotetaan — ei virheen teksti.
 *
 *  Sama muotti kummallakin puolella, jotta lukitusnäytön otsikot ovat
 *  tunnistettavasti samaa perhettä eivätkä satunnaisia lauseita. */
export function blockedPushTitle(subject: string): string {
  return `Valmistelu odottaa: ${subject}`;
}

/** Tiloja, joissa ottelupäivä on ohi tämän työn osalta ja seuraava ottelu saa
 *  valita. Sama sääntö ratkaisee sekä sen, näytetäänkö ottelunvalinta kortin
 *  alla, että sen, saako uuden työn luonti syrjäyttää tämän. */
export function isJobClosed(status: JobStatus): boolean {
  return status === "finished" || status === "failed" || status === "cancelled";
}

/** Kuinka kauan ottelun alusta se on yhä valittavissa — ja kuinka kauan sitä
 *  varten tehty keskeneräinen työ on yhä *tämän päivän* valinta.
 *
 *  Ottelu kestää parisen tuntia ja sitä selostetaan livenä, joten kuusi tuntia
 *  aloituksesta on ottelu jota ei enää selosteta. Sama vakio on molemmilla
 *  puolilla tarkoituksella: palvelin ei tarjoa vanhentunutta työtä valinnaksi
 *  (`getActiveJob`, #165), eikä valitsin tarjoa ottelua jonka valinta katoaisi
 *  siihen sääntöön. Kaksi eri rajaa tuottaisi täsmälleen sen umpikujan, jossa
 *  napautus ei tee mitään eikä mikään kerro miksi. */
export const SELECTABLE_AFTER_START_MS = 6 * 60 * 60_000;

/** Onko ottelu (tai sitä varten tehty keskeneräinen työ) yhä valittavissa.
 *  `startsAt` puuttuu käsin syötetyiltä ottelu-ID:iltä; silloin ratkaisee se
 *  aika, joka tiedetään — työn luontihetki. */
export function isSelectableStart(startsAt: string | null | undefined, now: number): boolean {
  if (!startsAt) return true;
  const at = Date.parse(startsAt);
  if (!Number.isFinite(at)) return true;
  return now - at < SELECTABLE_AFTER_START_MS;
}
