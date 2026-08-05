/** Google-yhteyden vartija: vanheneminen ja kiintiö puhelimeen (#176, #188).
 *
 *  Päätös #176 kääntyi tähän tiedostoon: **vanhenemisesta ja kiintiöstä tulee
 *  push-varoitus**, ei huoltoarkin punainen rivi jota kukaan ei käy katsomassa.
 *  Ero on koko juttu. Refresh token vanhenee Testing-tilassa 7 vuorokaudessa,
 *  eli tyypillisesti *ottelupäivien välissä* — se on juuri se vika, joka on
 *  huomattava lauantaina eikä kentällä sunnuntaina. Kiintiö taas kuluu
 *  luonteista ja katsotaan aina liian myöhään, koska sen loppuminen näkyy vasta
 *  kun lähetysparin luonti epäonnistuu.
 *
 *  Kaksi sääntöä pitävät tämän hiljaisena:
 *
 *   1. **Vain reuna.** Kun sama varoitus on yhä totta tunnin päästä, se ei ole
 *      uutinen. Muistissa pidetään edellinen laji, ja push lähtee vain kun
 *      tilanne huononee — paluu kuntoon nollaa muistin ilman piippausta.
 *   2. **Ei yhteyttä, ei kutsuja.** Ilman tokenia terveystarkistus ei koske
 *      verkkoon (googleAuth.getAuthHealth), joten yhdistämätön ohjaamo ei
 *      kuluta kiintiötä eikä varoita puuttumisesta: yhdistämättömyys on
 *      valmistelun este ja siitä kertoo preflight, ei tämä.
 *
 *  Varoitus on käskymuodossa (#174): sen lukija on ihminen, jonka on tehtävä
 *  jotain, ja teko tehdään ohjaamon huollossa. */

import type { AuthHealth } from "./googleAuth.js";
import { getAuthHealth, TOKEN_WARN_AGE_DAYS } from "./googleAuth.js";
import { notifyAuthAlert } from "./notifications.js";

/** Kun kiintiöstä on käytetty tämän verran, lähetysparin luonti on vaarassa:
 *  luonti + sidonta + thumbnailit maksavat satoja yksiköitä, ja ne on
 *  tehtävä ennen ottelua eikä sen jälkeen. */
const QUOTA_WARN_SHARE = 0.8;

export type AuthAlertKind = "expiry" | "quota" | "unreachable";

export interface AuthAlert {
  kind: AuthAlertKind;
  title: string;
  body: string;
}

/** Kuinka monta peräkkäistä epäonnistunutta terveystarkistusta vaaditaan ennen
 *  kuin siitä piipataan. Tarkistusväli on tunti, joten kaksi tarkoittaa "vika
 *  on kestänyt tunnin" — DNS-piikki tai YouTuben hetkellinen häiriö ei ylitä
 *  tätä, katkennut valtuutus ylittää aina. */
const UNREACHABLE_CONFIRM_CHECKS = 2;

/** Puhdas päättelysääntö: terveysraportti sisään, varoitus tai hiljaisuus ulos.
 *
 *  Erillään ajastimesta, koska juuri tämä on se osa, joka on oltava oikein:
 *  liian herkkä sääntö kouluttaa operaattorin pyyhkäisemään varoitukset pois,
 *  ja **väärään tekoon neuvova varoitus on pahempi kuin ei varoitusta**.
 *
 *  Järjestys on merkitsevä eikä satunnainen. `health === "fail"` EI kelpaa
 *  vanhenemisen tunnusmerkiksi, koska sen nostavat myös loppunut kiintiö ja
 *  epäonnistunut tarkistus — kumpikaan ei parane uudelleenkirjautumisella, ja
 *  neuvo "uusi yhteys" johtaisi operaattorin purkamaan toimivan valtuutuksen
 *  ottelupäivän aattona. Siksi jokainen laji tunnistetaan omasta
 *  havainnostaan: kiintiö kiintiöluvuista, vanheneminen tokenin iästä ja
 *  tavoittamattomuus `checkFailed`istä. */
export function authAlert(health: AuthHealth, consecutiveCheckFailures = 0): AuthAlert | null {
  // Yhdistämätön ohjaamo ei varoita: se on valmistelun este (preflight), ei
  // yllättävä muutos huonompaan.
  if (!health.connected) return null;

  // Kiintiö ensin: se on ainoa laji, jonka voi tunnistaa suoraan luvuista, ja
  // se nostaa terveyden failiin ilman että yhteydessä on mitään vikaa.
  const { used, limit } = health.quota;
  if (limit > 0 && used / limit >= QUOTA_WARN_SHARE) {
    const share = Math.round((used / limit) * 100);
    return {
      kind: "quota",
      title: share >= 100 ? "YouTube-kiintiö on lopussa" : "Varaudu kiintiön loppumiseen",
      body:
        share >= 100
          ? "Päivän YouTube-kiintiö on käytetty loppuun — lähetysparia ei voi luoda ennen kuin se nollautuu."
          : `Päivän YouTube-kiintiöstä on käytetty ${share} % — lähetysparin luonti voi epäonnistua tänään.`,
    };
  }

  // Vanheneminen mitataan tokenin IÄSTÄ myöntämisestä, ei viimeisestä
  // onnistuneesta päivityksestä. Ohjaamo pollaa lähteen tilaa taustalla ja
  // uusii access tokenin noin tunnin välein, joten `daysSinceSuccess` ei
  // käytännössä koskaan kasva — pelkkään siihen nojaava sääntö olisi kuollutta
  // koodia, ja koko lupaus "varoitus ENNEN katkeamista" jäisi lunastamatta.
  // Testing-tilan refresh token kuolee 7 vrk myöntämisestä (googleAuth.ts).
  const age = Math.max(health.tokenAgeDays ?? 0, health.daysSinceSuccess ?? 0);
  if (age >= TOKEN_WARN_AGE_DAYS) {
    return {
      kind: "expiry",
      title: "Uusi Google-yhteys",
      body: `Google-yhteyden myöntämisestä on ${Math.round(age)} vrk ja se voi katketa lähipäivinä. Uusi se ohjaamon huollosta ennen seuraavaa ottelua.`,
    };
  }

  // Tavoittamattomuus vasta kun se on kestänyt: yksittäinen verkkopiikki ei
  // kerro mitään, mutta peruutettu valtuutus näyttää täsmälleen samalta eikä
  // saa jäädä huomaamatta ottelupäivien välissä.
  if (health.checkFailed && consecutiveCheckFailures >= UNREACHABLE_CONFIRM_CHECKS) {
    return {
      kind: "unreachable",
      title: "Tarkista Google-yhteys",
      body: "Google-yhteyttä ei ole saatu tarkistettua tuntiin. Avaa ohjaamon huolto ja katso, toimiiko yhteys.",
    };
  }

  return null;
}

/** Tunti on tarkoituksella pitkä: vanheneminen mitataan vuorokausissa ja
 *  kiintiö nollautuu kerran päivässä, joten tiheämpi tarkistus ei löytäisi
 *  aiemmin mitään — se vain kuluttaisi kiintiötä itse (channels.list). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Ensimmäinen tarkistus vasta hetken kuluttua bootista: käynnistyksessä on
 *  jo tekemistä, eikä tämä ole kiireellinen. */
const FIRST_CHECK_DELAY_MS = 60 * 1000;

interface WatchDeps {
  readHealth: () => Promise<AuthHealth>;
  send: (alert: AuthAlert) => Promise<unknown>;
  intervalMs?: number;
  firstDelayMs?: number;
}

/** Testisauma: sama vartija ilman ajastinta, jotta reunakäytös voidaan ajaa
 *  läpi askel kerrallaan. */
export function createAuthWatch(deps: Pick<WatchDeps, "readHealth" | "send">) {
  let announced: AuthAlertKind | null = null;
  let checkFailures = 0;

  return {
    async check(): Promise<AuthAlert | null> {
      let health: AuthHealth;
      try {
        health = await deps.readHealth();
      } catch {
        // getAuthHealth ei heitä verkkovirheestä — se raportoi sen
        // `checkFailed`inä — joten tänne päätyy vain odottamaton vika.
        // Hiljaisuus on silloin oikein: seuraava tarkistus tulee tunnin
        // päästä, ja ottelupäivänä preflight sanoo saman.
        return null;
      }
      checkFailures = health.checkFailed ? checkFailures + 1 : 0;
      const alert = authAlert(health, checkFailures);
      if (!alert) {
        announced = null;
        return null;
      }
      if (announced === alert.kind) return null;
      announced = alert.kind;
      await deps.send(alert);
      return alert;
    },
  };
}

/** Käynnistää vartijan omalle ajastimelleen. Palauttaa pysäyttimen. */
export function startAuthWatch(deps: Partial<WatchDeps> = {}): () => void {
  const watch = createAuthWatch({
    readHealth: deps.readHealth ?? (() => getAuthHealth()),
    send: deps.send ?? ((alert) => notifyAuthAlert(alert.kind, alert.title, alert.body)),
  });
  const run = () => {
    void watch.check().catch((err) => console.error("[control] Google-yhteyden vartija kaatui:", err));
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    run();
    interval = setInterval(run, deps.intervalMs ?? CHECK_INTERVAL_MS);
    interval.unref?.();
  }, deps.firstDelayMs ?? FIRST_CHECK_DELAY_MS);
  // Kumpikaan ajastin ei saa pitää prosessia hengissä omin voimin.
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
