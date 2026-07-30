/** Kenttänimen siivous esitettävään muotoon.
 *
 *  Tulospalvelu antaa kenttänimen sisäisessä muodossaan, jossa on kaksi
 *  katsojalle tarkoittamatonta osaa:
 *
 *    `01 - Viinijärven pallokenttä, tekonurmi 1| LEIRITUOTANTO`
 *     └┬─┘                                     └──────┬──────┘
 *      kenttänumero                    tuotantomerkintä
 *
 *  Kummallakin on oma historiansa. Putkiliite oli jo siivottu puheesta
 *  (`stadiumSpeechName`), muttei ohjaamon otsikoista — 30.7.2026 luotujen
 *  lähetysten otsikoissa luki `… 30.7.2026 01 - Viinijärven pallokenttä,
 *  tekonurmi 1|`, katkaistuna kesken merkinnän (#132). Kenttänumeroa ei taas
 *  siivottu mistään, ja puhuttuna se kuului muodossa "nolla viisi viiva
 *  Liperin kirkonkylän kenttä viisi" (#101:n sivuhavainto).
 *
 *  Molemmat ovat sama raakamerkkijono, joten siivous on yksi funktio, jota
 *  sekä selostus että ohjaamon otsikot käyttävät. Coressa, koska tämä on
 *  puhdasta domain-logiikkaa ilman levyä tai DOMia.
 *
 *  Säännöt ovat erikseen kytkettävissä: tulospalvelun merkinnät vaihtelevat
 *  sarjoittain, eikä sokea siivous saa olla ainoa vaihtoehto (#132). */

export interface VenueNameOptions {
  /** Pudota johtava kenttänumero (`01 - `, `12 `). Oletus päällä. */
  stripFieldNumber?: boolean;
  /** Pudota kaikki ensimmäisestä `|`-merkistä alkaen. Oletus päällä. */
  stripQualifier?: boolean;
}

/** Johtava kenttänumero: 1–3 numeroa, joita seuraa joko ajatusviiva
 *  välilyönteineen tai pelkkä välilyönti.
 *
 *  Loppuosan on alettava kirjaimella, jotta pelkkä numeroista koostuva nimi tai
 *  `2024 - 2025` -tyylinen jakso ei jää tyhjäksi eikä puolikkaaksi. Leirimuodon
 *  `12 Tupos B` on nimenomaan se tapaus, jossa erotin on pelkkä välilyönti. */
const FIELD_NUMBER = /^\d{1,3}\s*(?:-\s*)?(?=\p{L})/u;

/** Kenttänimi esitettävässä muodossa. Tyhjä syöte (tai kokonaan siivoutuva)
 *  palautuu tyhjänä merkkijonona — kutsuja päättää mitä se tarkoittaa, koska
 *  puheessa kenttä jätetään silloin mainitsematta ja otsikossa käytetään
 *  kaupunkia. */
export function venueDisplayName(raw: string | null | undefined, opts: VenueNameOptions = {}): string {
  if (!raw) return "";
  const { stripFieldNumber = true, stripQualifier = true } = opts;
  let name = raw;
  if (stripQualifier) name = name.split("|")[0];
  name = name.trim();
  if (stripFieldNumber) name = name.replace(FIELD_NUMBER, "");
  // Putkiliitteen edellä on usein pilkku tai viiva, joka jää roikkumaan kun
  // liite lähtee ("… tekonurmi 1, | LEIRITUOTANTO").
  return name.replace(/[\s,;-]+$/, "").trim();
}
