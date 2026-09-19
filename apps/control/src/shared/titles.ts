/** Otsikon pituusrajat. Nämä ovat `shared`issa eivätkä `server/templates.ts`:ssä,
 *  koska sekä palvelimen otsikonrakentaja että käyttöliittymän merkkilaskuri
 *  tarvitsevat saman luvun — ja selain ei saa vetää sisäänsä koko
 *  templates-moduulia pelkän vakion takia. Kaksi käsin kirjoitettua lukua
 *  eroaisivat toisistaan hiljaa: laskuri näyttäisi vihreää samalla kun palvelin
 *  jo lyhentää (#316, #317). */

/** YouTuben oma raja on 100 merkkiä; pidemmät katkeavat myös mobiilinäkymässä.
 *  Runbook sallii pitkien seuranimien lyhentämisen nimenomaan otsikossa. */
export const TITLE_MAX_LENGTH = 100;

export const NARRATED_PREFIX = "Selostettu ";

/** Raakalähetyksen otsikon budjetti, kun otsikkoa käytetään **lähetysparin**
 *  pohjana. Selostettu otsikko on sama teksti `NARRATED_PREFIX`illä varustettuna,
 *  joten tasan 100 merkin raakaotsikosta tulisi 111 merkin selostettu otsikko —
 *  jonka YouTube hylkää. Hylkäys kaataa parin luonnin VASTA kun raakalähetys on
 *  jo luotu, ja #204:n kompensaatio poistaa senkin, joten operaattori menettää
 *  molemmat (#316). Budjetti lasketaan siksi pidemmästä eli selostetusta
 *  otsikosta, ja pari pysyy toistensa kopioina etuliitettä lukuun ottamatta. */
export const PAIR_TITLE_MAX_LENGTH = TITLE_MAX_LENGTH - NARRATED_PREFIX.length;
