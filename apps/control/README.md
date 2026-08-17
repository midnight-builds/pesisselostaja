# @pesisselostaja/control — Ohjaamo

Mobiilikäyttöinen (iPhone Safari) ohjaussovellus, jolla koko broadcast-tuotanto
hoidetaan operaattorin puhelimesta: ottelun valinta, relayn elinkaari, live-valvonta ja
YouTube-ketju. Suunnitelma ja päätösten perustelut: `DESIGN.md`.

## Miksi tämä on oma palvelunsa

- **`apps/web` julkaistaan GitHub Pagesiin.** Hallinta ei voi olla siellä: se
  näkee stream keyt ja OAuth-tokenit.
- **Relay ajaa pinnatusta ajokopiosta `~/relay-deploy`.** Ohjaamo ajaa
  työpuusta, joten sen uudelleenkäynnistys ei kosketa käynnissä olevaa
  lähetystä — ohjaamoa saa päivittää kesken ottelun.
- **Ohjaamo ei ole lähetyksen elinehto.** Jos se kaatuu, relay jatkaa. Kaikki
  ohjaus menee tiedostojen kautta (`.env.relay`, `run/.control-<ID>.json`),
  ei prosessien välisenä yhteytenä.

## Ajaminen

```bash
npm run build -w @pesisselostaja/control     # client → dist/client
systemctl --user restart pesisselostaja-control.service
systemctl --user is-active pesisselostaja-control.service
```

Unit-tiedosto on `ops/pesisselostaja-control.service` (kopioi
`~/.config/systemd/user/`). Palvelin kuuntelee porttia 3002; pääsy tapahtuu
`tailscale serve`n kautta tailnetin HTTPS-osoitteessa, jonka `tailscale serve
status` kertoo (osoite on käyttöönottokohtainen).
HTTPS ei ole koristetta: ilman sitä iOS ei anna asentaa sovellusta
kotivalikkoon eikä salli push-ilmoituksia.

### Ympäristömuuttujat

Polut ja unit-nimi tulevat `src/server/config.ts`:stä ja ovat kaikki
ohitettavissa (`CONTROL_PORT`, `CONTROL_HOST`, `CONTROL_RELAY_ENV`,
`CONTROL_RELAY_RUN_DIR`, `CONTROL_RELAY_UNIT`, `CONTROL_DEPLOY_DIR`,
`CONTROL_STATE_DIR`). Näiden lisäksi:

| Muuttuja | Oletus | Mitä tekee |
|---|---|---|
| `CONTROL_HARD_STOP_SOURCE` | `false` | Saako hard stopin siivous (#123) lopettaa myös **raakalähetyksen**. Selostettu lähetys lopetetaan hard stopissa aina: se on kokonaan meidän, relay on ainoa joka siihen työntää, eikä sen sulkeminen vie mitään mikä ei ollut jo mennyttä. Raakalähetys on lipun takana, koska väärässä tilanteessa sen lopettaminen on peruuttamatonta — jos takarajapäättely osuu väärin, katkeaa lähetys jota yhä kuvataan ja katsotaan, eikä kuvauspuhelin ole tolpan päässä kenenkään ulottuvilla kesken ottelun. Normaalisti raakalähetyksen lopettaa kuvaaja itse StreamLabsista. Vain kirjaimellinen `"true"` on päällä. |

**Hard stopin siivous** laukeaa vain kun relay sammutti itsensä takarajan takia
(telemetrian `endReason === "hard_stop"`, ks. issue #123): ottelu oli päättynyt
tulospalvelun mukaan ja raakalähetys oireili. Se on ainoa tilanne, jossa
ohjaamo koskee **raakalähetykseen**.

**Hallittu lopetus** (issue #153) sulkee **selostetun lähetyksen** myös
normaalissa lopetuksessa: ehtona on että relayn telemetria kertoo sekä
`endReason === "ended"` että `match.finished`. Molemmat vaaditaan — pelkkä
`ended` tulee myös kesken ottelun kuolleesta raakalähetyksestä (akku, verkko),
ja `complete` silloin katkaisisi elävän lähetyksen katsojilta. Raakalähetykseen
ei tässä kosketa lainkaan, ei myöskään `CONTROL_HARD_STOP_SOURCE` päällä.

Kun kumpikaan ehto ei täyty (luovutus, vanha deploy joka ei kerro syytä,
vanhentunut status-tiedosto), ohjaamo ei transitoi mitään ja kohteen sulkee
YouTuben `enableAutoStop`. Siivous lokittaa mitkä lähetykset olivat live ja mitä
tehtiin tai jätettiin tekemättä ja miksi; sen epäonnistuminen ei koskaan estä
työn sulkemista.

## Testit

```bash
npm run test:ui -w @pesisselostaja/control                      # WebKit + Chromium
npm run test:ui -w @pesisselostaja/control -- --project=webkit  # vain Safarin moottori
npm run test:ui -w @pesisselostaja/control -- --headed --project=webkit
```

Selain­testit (`test-ui/`, Playwright) ajetaan **WebKitillä ensisijaisesti** —
kohde on iPhonen Safari, 393×853. Ne kasvavat käyttöliittymän tahdissa: jokainen
tilan PR tuo oman specinsä (#178). Nyt katettuna:

| Spec | Mitä se lukitsee |
|------|------------------|
| `smoke.spec.ts` | perusrenderöinti oikealla palvelimella, SSE-virta, käännetty nide |
| `statecard.spec.ts` | tilakortin tilat ja ottelun valinta |
| `valmistelu.spec.ts` | lähetysparin luonti, valmiustarkistus, 393 px:n leveys |
| `ajastettu.spec.ts` | käynnistysvahti, itsekorjaus, este käskymuodossa |
| `ottelu.spec.ts` | ottelunaikainen kertasilmäys: viisi tietoa, kaksi säätöä ja selostuslista **ilman sivun vieritystä** 393×853:ssa |

Testit käynnistävät oman palvelimen porttiin **3099** ja ohjaavat kaikki
kirjoitukset hakemistoon `.playwright-tmp/` (`CONTROL_STATE_DIR`,
`CONTROL_RELAY_ENV`, `CONTROL_RELAY_RUN_DIR`, `CONTROL_RELAY_UNIT`,
`CONTROL_DEPLOY_DIR`). **Ne eivät koske oikeaan `.env.relay`-tiedostoon eivätkä
oikeaan relay-yksikköön** — annettua unit-nimeä ei ole olemassa. `/api/**` on
mockattu ja `EventSource` korvattu testien ohjaamalla tuplalla; sivun tarjoaa
silti oikea palvelin, koska juuri staattisen tarjoilun rikkoutuminen (tyhjä
kuori) on tämän sovelluksen kertaalleen sattunut vika. Kuvakaappaukset:
`test-results/screenshots/`.

Yksikkötestit (`test/`, vitest) ajetaan erikseen.

## Rakenne

| Polku | Vastuu |
|-------|--------|
| `src/shared/` | Palvelimen ja clientin **sitova sopimus** (`types.ts`, `api.ts`). Muutos täällä rikkoo typecheckin molemmilla puolilla — se on tarkoitus. |
| `src/server/` | node:http-palvelin, SSE, JSON-tallennus, relay-ohjaus, pesistulokset-haut |
| `src/client/` | React + Vite -käyttöliittymä. **Ei navigaatiota:** kuori (`App.tsx`) renderöi yhden tilakortin ja sen alle ottelun valinnan. Ks. "Käyttöliittymä: yksi tilakortti" alla. |
| `tools/` | `pesaysit-thumbnail-compose.py` — thumbnailin PIL-komposiitti |
| `docs/` | Nykyisen YouTube-työnkulun kanoniset ohjeet ja templaatit |
| `assets/` | Operaattorin brändimedia + PWA-kuvakkeet. **Ei gitissä** (repo on julkinen). |
| `run/` | Ajonaikainen tila (työt, asetukset). Ei gitissä. |

## Käyttöliittymä: yksi tilakortti

Rakenne on piirretty uusiksi (kartta #168, rakennepäätös #173, pilkkominen
#178). **Välilehtiä ei ole** — kuusi välilehteä oli itse ongelma, ei niiden
sisältö. Etusivu on aina yksi kortti: *tämä ottelu, tässä tilassa*.

- **Kortin otsikkosana tulee työn tilasta** yhdestä sanamuotolähteestä,
  `src/shared/jobState.ts`. Sama lista on myöhemmin push-ilmoitusten otsikko,
  koska push on kortin tilasiirtymän projektio (#174) — sanamuotoa ei kirjoiteta
  kahteen paikkaan.
- **Ilman aktiivista ottelua etusivu on ottelun valinta.** Valinta *on* työn
  luonti: erillistä "Luo työ" -vahvistusta ei ole (#171). Päättyneen ottelun
  jälkeen valitsin palaa kortin alle.
- **Valinnan totuuslähde on palvelin.** Se mikä ottelu on valittu tulee
  SSE-virran `LiveState.job`-kentästä (`getActiveJob`, `src/server/jobs.ts`), ei
  selaimen tilasta: kaksi rinnakkaista työvalitsinta oli #129:n ja #165:n
  juurisyy. `getActiveJob` palauttaa myös luonnoksen — valinta näkyy heti — mutta
  **ei keskeneräistä työtä jonka ottelu alkoi yli kuusi tuntia sitten**, jotta
  eilinen työ ei esittäydy tämän päivän valintana. Lähetyspaikkaa pitävää työtä
  (arming/live) tämä ei koske.
- Selain pitää juuri luotua työtä näkyvillä siihen asti kunnes palvelin kertoo
  saman (aggregaattori tikittää 5 s välein). Palvelimen kehys voittaa aina.

### Valmistelu (#184)

Luonnos ja ajastettu työ ovat operaattorille **sama hetki** — ottelu on valittu,
lähetys ei ole alkanut — joten ne ovat yksi kortin sisältö (`PrepCard`), ei kaksi:

- **Esikatselu on pysyvästi painikkeen yläpuolella.** Se ei luo YouTubeen mitään
  (pelkkää tekstiä), joten sitä ei tarvitse pyytää napista. Otsikkotiedot, joita
  tulospalvelu ei tunne (#95), ovat kokoon taitettuna — normaalipolku on
  esikatselu + yksi nappi.
- **Lähetysparin luonti on ottelupäivän ainoa vahvistusta vaativa teko** (#171):
  peruuttamaton ja ulospäin näkyvä, siksi kaksoisnapautus. Erillistä "olen
  tarkistanut" -kytkintä ei ole: tuplaparin estää kone — kun työllä on jo pari,
  luontia ei tarjota.
- **Sidonta hoituu itsestään.** Nappia `.env.relay`:n kirjoittamiseen ei ole
  (#176). Valmiustarkistus (`POST /api/preflight`, aina työn id:llä, #155)
  korjaa väärän sidonnan **vain operaattorin valitsemaan otteluun** ja vain kun
  relay ei ole ajossa, ja näyttää tekonsa rivinä *"Korjattiin: …"* — hiljaista
  itsekorjausta ei tehdä. Itsekorjautuvasta esteestä ei lähde pushia (#174).
- **Rivit ovat operaattorin kieltä.** Käännös tehdään palvelimella
  (`toOperatorCheck`, `src/server/preflight.ts`), ja raaka rivi kulkee mukana
  `PreflightCheck.technical`-kentässä huoltoarkkia varten (#188). Env-avainten
  nimiä, tiedostopolkuja tai stream keytä ei näy käyttöliittymässä missään.

### Ottelun aikana (#186)

Ottelun aikana ohjaamo on **vianepäilyn kertasilmäys**, ei työpöytä (#170).
Kortin sisältö (`MatchGlance`) on täsmälleen se, mitä inventaario (#169) löysi
ottelun aikana katsotuksi ja kosketuksi — **viisi tietoa** (selostuksen tila,
raakalähetys, pistetilanne, jakso ja palot, sisävuoro) ja **kaksi säätöä**
(selostuksen ajoitus, vaihtoselostus) — sekä selostuslista diagnoosivälineenä.
Kaikki mahtuu 393 px:n ruudulle **ilman sivun vieritystä**; selostuslista on
ainoa vierivä lohko, koska sen pituutta ei voi tietää etukäteen.

- **Ohjaamosta relayyn on kaksi kosketuspintaa, ei kolmatta** (#172, #59):
  `.env.relay` ja relayn control-tiedosto. Säädöt menevät jälkimmäistä tietä
  (`POST /api/knobs`, `POST /api/knobs/delay-nudge`) ja purevat ajossa olevaan
  relayhin ilman uudelleenkäynnistystä. **Uutta HTTP-kanavaa relayyn ei saa
  rakentaa** — relay ajetaan pinnatusta deployista, joka voi olla ohjaamoa
  vanhempi.
- **Viiveen napit ovat suhteellisia** (±500 ms), eivät absoluuttisia:
  kalibrointi tehdään korvakuulolta kesken lähetyksen, joten nappi nimeää
  *oireen* ("Puhui liian aikaisin"), ei arvoa. Uusi arvo näkyy heti, leikattuna
  samaan 0…15 s -väliin kuin palvelimella, ja vanhenee kymmenessä sekunnissa
  ellei palvelin vahvista sitä.
- **Relayn tilannekuva uskotaan vain tuoreena.** `RelayTelemetry.at` verrataan
  palvelimen kelloon rajalla `TELEMETRY_STALE_MS` (`src/shared/types.ts`) —
  sama vakio molemmilla puolilla, koska pysähtyneen relayn levylle jättämä
  status näyttäisi muuten vihreää sen jälkeen kun mitään ei enää kuulu.
- **Koneen kieltä ei näytetä** (#176): palvelimen `headline` ja relayn
  `source.detail` (yt-dlp:n ja ffmpegin sanamuodot) eivät päädy korttiin.
  Jokaisella lähdetilalla on täsmälleen yksi operaattorin lause, ja uusi
  relayn lähdetila kaataa käännöksen typecheckissä sen sijaan että putoaisi
  hiljaa "ei tietoa" -riville (#103, #104).
- **Kaksi hälytysriviä** viiden tiedon yläpuolella, molemmat hiljaisia vikoja:
  levytilan loppuminen ja se, että ajossa oleva relay ajaa eri ottelua kuin
  ohjaamon työ (#118) — jolloin juuri nämä kaksi nappia lakkaavat vaikuttamasta
  mihinkään.

### Päättynyt (#187)

Ottelupäivän viimeinen näkymä (`EndedCard`) vastaa **yhteen kysymykseen: jäikö
jotain päälle?** Hard stopin siivous tehdään ilman operaattorin vahvistusta
(#171), joten ainoa asia joka pitää sen rehellisenä on että teot näkyvät
jälkikäteen — teko jota ei näytetä on teko jota ei voi tarkistaa.

- **Siivous on kirjattu tietona, ei pääteltävissä tilasta.** `Job.cleanup`
  (`src/shared/types.ts`) kertoo *milloin*, *mistä lopetus pääteltiin*
  (`indicators`) ja *mitä tehtiin* (`actions`). Työ suljetaan sillä sekunnilla
  kun relay sammuu, ja lähetykset ovat silloin vielä auki — siksi ehto on tämä
  kenttä eikä `status === "finished"`.
- **Tyhjä tekolista ei ole puuttuva siivous** vaan täysin normaali lopputulos:
  luovutuksessa, vanhalla deployllä ja kesken ottelun kuolleen raakalähetyksen
  jälkeen ohjaamo ei transitoi mitään, ja kohteen sulkee YouTuben
  `enableAutoStop`. Kortti sanoo sen ääneen, koska "ei rivejä" näyttäisi
  unohdukselta. Hallitussa lopetuksessa (#153) rivejä on tasan yksi:
  *"Selostettu lähetys suljettiin."*
- **Useampi riippumaton päättymisindikaattori** (#171): relayn oma lopetussyy,
  relayn havainto raakalähetyksestä ja tulospalvelun kirjaus ovat eri lähteitä,
  ja kortti luettelee ne erikseen. Vanhentuneesta status-tiedostosta ei väitetä
  lopetussyytä lainkaan — sama tuoreusvartija kuin siivouksella (#123).
- **Epäonnistunut teko on kortin ainoa käskymuotoinen rivi** ("Sulje selostettu
  lähetys YouTubessa itse"): silloin lähetys on yhä auki eikä sitä sulje kukaan
  muu. YouTuben oma virheteksti jää lokiin (#176).
- **Ilman siivousmerkintää kortti myöntää sen**: ajo päättyi ohjaamon ollessa
  alhaalla, sovittelu sulki työn jälkikäteen (#118), eikä lähetysten tilasta ole
  näyttöä. Vihreä "kaikki kiinni" olisi siinä tilanteessa valhe.
- **Jälkihoitoa ei ole** (#170): soittolista valitaan jo luontihetkellä (#177),
  joten kortissa ei ole nappeja — vain linkki tallenteeseen. Seuraavan ottelun
  valitsin on kortin alla, ja `getActiveJob` pitää juuri päättyneen työn
  näkyvissä saman kuuden tunnin säännön mukaan kuin keskeneräiset.

### Huoltoarkki (#188)

Kaikki mikä **ei** ole ottelupäivän polkua asuu hammasrattaan takana
(`ServiceSheet` + `components/service/`): Google-yhteys, ilmoitukset,
jakoviestin pohja ja loki. Ne eivät ole vähemmän tärkeitä — ilman niitä ei lähde
mitään — mutta ne ovat kerran tehtäviä ja rikkoutuessaan tarkistettavia, eivät
ottelun aikana käytettäviä (#170). Juuri siksi tilakortti pysyy yhtenä
silmäyksenä.

- **Arkki peittää ruudun kokonaan.** 393 px:n leveydellä puolikas arkki
  tarkoittaa, ettei kumpaakaan voi lukea. Se sulkeutuu taustasta, Escistä ja
  omasta napistaan.
- **Google-yhteys on yksi kuittausrivi**: "Google-yhteys kunnossa" ja kanavan
  nimi. Scopet, tokenin ikä ja client id eivät näy missään (#176), eikä
  käsisyöttökenttiä ole — uusinta käynnistää laitevirran, joka näyttää koodin ja
  osoitteen ja huomaa itse kun kirjautuminen valmistuu. **Kesken jäänyt
  laitevirta jatkuu itsestään** kun arkki avataan uudelleen, ja **vanhentunut
  koodi näytetään nappina eikä näkymänä**: muuten kortti jäisi tuijottamaan
  kuollutta koodia, eikä yhteyttä voisi enää uusia lainkaan — SSH-varapolkua ei
  ole.
- **Vanhenemisesta ja kiintiöstä tulee push, ei punainen rivi arkissa**
  (`src/server/authWatch.ts`). Refresh token vanhenee Testing-tilassa 7
  vuorokaudessa eli tyypillisesti ottelupäivien *välissä*, jolloin kukaan ei
  katso ohjaamoa. Vartija tarkistaa tunnin välein, lähettää vain reunalla (sama
  varoitus ei toistu tunneittain) eikä koske verkkoon lainkaan ilman tokenia —
  yhdistämätön ohjaamo ei siis kuluta kiintiötä eikä varoita puuttumisesta,
  koska se on valmistelun este ja siitä kertoo preflight.

  **Jokainen laji tunnistetaan omasta havainnostaan, ei terveydestä.**
  `health === "fail"` ei kelpaa vanhenemisen tunnusmerkiksi, koska sen nostavat
  myös loppunut kiintiö ja epäonnistunut tarkistus: silloin puhelimeen tulisi
  "uusi Google-yhteys" vaikka yhteydessä ei ole vikaa, ja jos operaattori
  tottelee, hän purkaa toimivan valtuutuksen ottelupäivän aattona. Siksi
  kiintiö luetaan kiintiöluvuista **ensin**, vanheneminen `tokenAgeDays`istä
  (ei `daysSinceSuccess`istä, joka ei enää kasva kun ohjaamo uusii access
  tokenin tunneittain) ja tavoittamattomuus omasta `checkFailed`-bitistään
  vasta kun se on kestänyt kaksi tarkistusta.
- **Loki on ohjaamon ainoa tekninen taso.** SSH:ta ei käytetä koskaan (#176),
  joten vianetsinnän on onnistuttava täältä: rivit näytetään koneen kielellä,
  ja mukana on palvelimen `headline` sekä levytila — samat, jotka ovat
  ottelupäivän polulla kiellettyjä.
- **Jakoviestin pohja ja kenttänimen siivous** tallentuvat osittaisella
  PATCHilla (#133), joten viestin muokkaus ei nollaa kytkimiä.

Tilakohtainen sisältö kasvoi tilakoneen järjestyksessä omissa PR:issään (#178):
valmistelu ja lähetysparin luonti (#184) → ajastettu-tila ja pushit (#185) →
ottelunaikainen kertasilmäys, viivesäätö ja selostuslista (#186) →
päättynyt-tila ja siivous (#187) → huoltoarkki (#188). Vanhat näkymät ja niiden
komponentit on poistettu; niitä ei ole säilytetty velvollisuudesta, ja tarvittava
pala poimitaan git-historiasta.

## Push-ilmoitukset

Ilmoitukset lähetetään palvelimelta selaimen push-palvelun kautta (`web-push`,
ainoa ajonaikainen riippuvuus — VAPID-JWT ja hyötykuorman salaus ovat kryptoa,
jota ei kirjoiteta itse). Neljä laukaisijaa, kaikki kytkettävissä pois
`POST /api/push/prefs`illa huoltoarkin kytkimillä (#188):

| Laukaisija | Ehto |
|-----------|------|
| Lähetys rikki | `health` on ollut `fail` yhtäjaksoisesti 60 s |
| Automaattinen korjaus | `notifyAutoFix()` — rajapinta valmiina, kutsuja tulee vaiheessa B |
| Valmistelu ja käynnistys | relay siirtyi ajoon, tai preflightissä oli esteitä |
| Lähetys katkesi | relay poistui ajosta kesken ottelun |
| Selostettu lähetys päättyi | työn **siivous kirjattiin** (`Job.cleanup`, #187) — ei siitä että työ sulkeutui |
| Google-yhteys vaatii tekoa | tokenin ikä ≥ 6 vrk, päivän kiintiöstä käytetty 80 %, tai yhteys tavoittamattomissa kaksi tarkistusta (`authWatch.ts`, #188) — `startup`-preferenssin alla, koska se estää valmistelun |

Hyvänä päivänä puhelin piippaa täsmälleen kolme kertaa (#174): *Lähetyspari
valmiina* → *Lähetys käynnistyi* → *Selostettu lähetys päättyi*. Otsikot tulevat
samasta sanamuotolähteestä kuin kortin otsikko (`src/shared/jobState.ts`), joten
kahta eriävää listaa ei voi syntyä.

Ilmoitus lähtee vain **tilan muutoksesta**, ei joka pollilla, ja sama aihe
enintään kerran 10 minuutissa (`src/server/notifications.ts`). Liika
ilmoittelu tarkoittaa, että käyttäjä lakkaa lukemasta niitä.

Tila levyllä: `run/vapid.json` (avainpari, luodaan kerran — **älä poista**, se
mitätöi kaikki tilaukset), `run/push-subscriptions.json` (laitteet; vanhentuneet
poistuvat itsestään kun push-palvelu vastaa 404/410) ja `run/push-prefs.json`.

**iPhonella ilmoitukset toimivat vasta kun sovellus on lisätty
kotivalikkoon** — se on iOS:n vaatimus, ei tämän sovelluksen. Jaa-painike →
"Lisää koti­valikkoon", avaa kuvakkeesta, ja vasta sitten "Ota ilmoitukset
käyttöön". Luvan kysely vaatii käyttäjän napautuksen. Testinappi lähettää
oikean push-ilmoituksen, jotta ketjun voi todeta toimivaksi kentällä ennen
ottelua.

## Suhde relayhin

Ohjaamo **ei muuta relayn koodia**. Se kirjoittaa kaksi tiedostoa ja lukee
kolmea lähdettä:

- kirjoittaa `apps/broadcast/.env.relay` (vain ottelukohtaiset avaimet;
  `ELEVENLABS_API_KEY` ja `RELAY_URL_REFRESH_MS` säilytetään koskemattomina)
- kirjoittaa `apps/broadcast/run/.control-<ID>.json` (relay lukee joka pollilla)
- lukee relayn telemetrian: `run/status-<ID>.json` ja `run/timeline-<ID>.ndjson`
- lukee `systemctl --user show`, `journalctl --user -u`, ja pesistulokset-API:n

### `sourceIngest` — lähteen tila YouTube-API:sta (#104 vaihe 1)

Ohjaamo on ainoa jolla on Google-tunnukset, joten se katsoo lähteen puolesta ja
relay lukee. Relay **ei** kysy Googlelta itse: kaksi refresh_tokenin päivittäjää
rikkoisi authin kesken ottelun, eikä lähetyksen jatkuminen saa riippua
Google-yhteydestä.

30 s välein ohjaamo hakee raakalähetyksen `lifeCycleStatus`in
(`liveBroadcasts.list`) ja siihen sidotun syötteen `streamStatus`in
(`liveStreams.list`), ja kirjoittaa havainnon control-tiedoston
`sourceIngest`-avaimeen (`observedAt`, `videoId`, tilat raakoina merkkijonoina,
`error`). Arvot julkaistaan sellaisinaan — **päätös kuuluu relaylle, ei
ohjaamolle**. Vain `streamStatus === "active"` tarkoittaa että dataa virtaa;
`null` ja vanhentunut `observedAt` tarkoittavat *ei tietoa*, eivät *poikki*.

Vaiheessa 1 relay ohittaa avaimen: käytös ei muutu. Vaihe 2 lukee sen ja
vaihtaa katvekuvaan.

Pollaus on portitettu tiukasti — työ tilassa `arming`/`live`, relay-yksikkö
ajossa **ja relayn oma telemetria (`run/status-<ID>.json`) kertoo että se ajaa
juuri tätä ottelua**, lähde-URL jäsentyy eikä ole sama kuin kohdevideo, Google-
token tallennettu, kiintiötä yli varauksen. Portin sulkeutuminen ei ole vika
vaan normaali lepotila, ja se näkyy ohjaamon Lähde-rivillä syynä.

`run/` on symlinkattu ajokopiosta työpuuhun, joten ohjaamo näkee samat
tiedostot jotka ajossa oleva relay kirjoittaa.

### `targetIngest` — kohteen tila YouTube-API:sta (#250)

Sama kuvio kohteelle eli selostetulle lähetykselle, mutta painoarvo on
päinvastainen: lähteestä relay on itse paras todistaja, kohteesta se ei tiedä
mitään — RTMP-työntö onnistuu myös kuolleeseen lähetykseen. 16.8.2026 (ottelu
136771) YouTuben autostop päätti selostetun lähetyksen kesken ottelun, relay
työnsi loppuottelun kuolleeseen kohteeseen eikä mikään huomannut.

30 s välein ohjaamo hakee kohteen `lifeCycleStatus`in ja siihen sidotun
striimin `streamStatus`in (kertoo ottaako YouTube meidän työntömme vastaan).
Havaintoa **ei** kirjoiteta control-tiedostoon — relay ei voi tehdä tiedolle
mitään — vaan se kulkee LiveStaten `targetIngest`-kenttänä tilakortille.
Tuore `complete`/`revoked`-havainto kesken ottelun, relayn ollessa ajossa, on
`fail`-tason vika: otsikko, Kohde-rivi, tilakortin hälytysrivi ja välitön
push-ilmoitus ("Selostettu lähetys kuoli") kertovat sen. Sääntö on jaettu
(`src/shared/targetHealth.ts`), jotta palvelin ja selain eivät voi erota.
Ottelun päätyttyä sama `complete` on normaali lopputila eikä hälytä.

Portit ovat samat kuin lähteen pollauksessa (työ `arming`/`live`, relay ajossa
juuri tätä ottelua, token, kiintiövaraus) — molemmat pollerit väistävät
itsenäisesti lähetysten luonnin kiintiötarpeen. Huomaa että kahden pollerin
yhteiskulutus on ~4 yksikköä / 30 s eli ~480/h: `sourceIngest.ts`:n
mitoituskommentin "yön yli ~3840" on nyt yhteissummana ~7680, joten pitkänä
leiripäivänä kiintiövaraus voi sulkea molemmat havainnot samaan aikaan —
silloin syy näkyy Lähde- ja Kohde-rivien notena, ei vikana.

Toipumispolku (uuden selostetun lähetyksen luonti kesken ottelun ja relayn
sidonta siihen) on issuen #250 kohta 2 eikä sisälly tähän: valvonta kertoo
tilanteen, korjaus on toistaiseksi käsityötä.

### Yksi totuuslähde (#97)

Kaikelle mitä sekä relay että ohjaamo tietävät, **relay on lähde**. Se on ainoa
joka tietää mitä oikeasti sanottiin, millä sanamuodolla, millä kokoonpanolla ja
kuuliko sitä kukaan. Ohjaamo lukee eikä päättele:

- **Selostuslista** tulee `timeline-<ID>.ndjson`istä. Rivi ilmestyy kun relay on
  sen päättänyt (`detected`) ja korostuu kun klippi on mennyt mikseriin
  (`spoken`). **Vaimennettu rivi** — relay puhui, mutta ffmpeg ei ollut
  kytkeytynyt — näkyy punaisena ja yliviivattuna: *se ei kuulunut kenellekään*.
- **Lähteen tila ja jonon pituus** tulevat `status-<ID>.json`ista. Lokista
  arvaaminen jätettiin varajärjestelmäksi vanhoja relay-buildeja varten.
- Ohjaamo laskee itse vain sen mitä relay ei voi tietää: levytila, kuorma,
  YouTube-tila, työjono ja tulostaulun oma luku pesistuloksesta.

Jos ajokopio on vanhempi kuin PR #93, telemetriaa ei ole eikä selostuslistalla
ole mitään näytettävää — lista sanoo sen ääneen sen sijaan että väittäisi
hiljaisuutta. Korjaus on `npm run relay:deploy`.

### Työ sidotaan ajossa olevaan otteluun (#118)

Työ ja relayn ajo ovat kaksi eri asiaa, ja ohjaamo sitoo ne yhteen **vain
relayn omalla näytöllä**: `run/status-<ID>.json` kertoo mitä relay ajaa.

- **Sidonta** (`arming` → `live`) tapahtuu vasta kun tuo tiedosto on olemassa
  ja sen kirjoitti tämä unit-ajo (mtime unitin käynnistyshetkeä myöhemmin).
  Relay kirjoittaa statuksen vielä sammuessaan, joten päättyneen ajon tiedosto
  näyttäisi muuten seuraavan ajon todisteelta koko minuutin ajan.
- **Eri ottelu ⇒ ei sidota lainkaan.** Puuttuva sidonta on parempi kuin väärä:
  väärään työhön sidottuna operaattorin säätimet kirjoittuvat väärän ottelun
  `run/.control-<ID>.json`-tiedostoon eikä ajossa oleva relay näe niitä
  koskaan. Ristiriita nousee otsikkoon ja Relay-riville, ja telemetria sekä
  selostuslista jätetään näyttämättä — *ei tietoa on parempi kuin väärän
  ottelun tieto*.
- **Sovittelu** sulkee slottiin jääneet työt, joihin laskeva reuna ei yllä
  (ohjaamo käynnistettiin uudelleen relayn sammuttua). Se vaatii aina näytön:
  relay ajossa ⇒ on tiedettävä mitä; relay alhaalla ⇒ 30 s ennen kuin ajo
  tulkitaan päättyneeksi, jottei relayn oma restart vapauta slottia kesken
  lähetyksen. Sovittelu yrittää myös hard stopin siivousta (#123), mutta sen
  omat vartijat ratkaisevat: relayn status saa olla korkeintaan 90 s vanha.
  **Käytännössä siivous onnistuu vain jos ohjaamo on takaisin pystyssä noin
  minuutissa.** Pidempi katko ⇒ selostettu lähetys ja raakalähetys jäävät päälle ja ne on
  lopetettava käsin. Se on tietoinen raja: vanhentuneen syyn perusteella
  sammuttaminen voisi katkaista lähetyksen joka on vasta alkamassa.
- **Odottava työ vanhenee tunnissa.** `arming`-tilassa oleva työ, jolle ei ole
  käynnistetty relayta tuntiin (`ARMING_STALE_MS`, `jobs.ts`), perutaan
  automaattisesti. Aikaisin armaaminen ja kuvaajan odottelu on siis normaalia,
  mutta **edellisenä iltana armattu työ ei ole aamulla enää voimassa** — se
  jäi ennen jumiin ja esti seuraavan ottelun aktivoinnin (#101).

## Jaettava viesti

Jaettava viesti (WhatsApp-ryhmiin) muodostuu `run/share-template.json`ista.
Tiedosto kirjoitetaan oletuksineen käynnistyksessä, ja se luetaan **joka
pyynnöllä** — muokkaus näkyy seuraavassa esikatselussa ilman
uudelleenkäynnistystä. Paikkamerkit: `{time}`, `{matchup}`, `{watchUrl}`,
`{narratedWatchUrl}`, `{matchUrl}`. Tuntematon paikkamerkki jää näkyviin, jotta
kirjoitusvirhe huomataan esikatselusta eikä lähetetystä viestistä.

Ottelupari on **sama kuin otsikossa**, eli **kotijoukkue ensin ja vierasjoukkue
toisena** myös silloin kun Pesä Ysit on vieraana (#223). Kun luontikortissa on
annettu koti- ja vierasjoukkueen esitysnimet ("IPV", "Pesä Ysit F-pojat"),
viesti käyttää niitä eikä tulospalvelun raakoja nimiä; kentät vaihtavat vain
nimen, eivät järjestystä. Tulospalvelun osoite on monikkomuodossa
(`/ottelut/<id>`), kuten palvelu itse sen kirjoittaa.

Viestin saa **milloin tahansa** työn elinkaaren aikana:
`GET /api/jobs/:id/share` (#131); tilakortin kopiointinappi on valmistelutilassa
(#184). Se muodostetaan uudelleen työn linkeistä eikä talleteta luontihetkellä,
joten mallin vaihtaminen kesken leiripäivän näkyy myös jo luoduissa töissä.
Ennen lähetysten luontia viestissä on paikkamerkit ja `linksReady` on `false` —
silloin tilakortti ei näytä viestiä lainkaan: puolivalmis viesti ryhmächatissa on
pahempi kuin viesti, jota ei vielä ole.

## Pysyväisasetukset

Pysyväisasetukset yhdessä paikassa (#133): `GET /api/settings` ja osittainen
`PATCH /api/settings`. Talletus jakautuu samoihin `run/`-tiedostoihin kuin
ennenkin, joten hätätilassa ne voi yhä korjata tiedostoselaimella — sivu on
normaali tie, ei ainoa tie. Käyttöliittymä on huoltoarkissa (#188).

| Kortti | Tiedosto |
|---|---|
| Jaettava viesti (aloitusrivi + linkkirivit) | `run/share-template.json` |
| Kenttänimen siivous (kaksi kytkintä) | `run/venue-cleanup.json` |

**PATCH on osittainen**, ja se on tarkoituksellista: käyttöliittymä lähettää
vain sen kortin jota operaattori muokkasi. Muuten kesken jäänyt muokkaus
toisessa kortissa tallentuisi sivutuotteena, kun hän painaa tallenna toisessa.

**Mikä EI ole täällä:** relayn ottelunaikaiset säätimet (selostus päälle/pois,
viive, pollausväli). Ne menevät relayn control-tiedostoon ja kuuluvat
ottelunaikaiseen tilakorttiin (#186), koska ne ovat *ohjausta kesken lähetyksen*
eivätkä asetuksia. Sama rajaus on issuessa. Lähetysten näkyvyys ja soittolista taas
valitaan luonnin yhteydessä, koska ne ovat lähetyskohtaisia valintoja.
Käynnistysikkunan pituus (`NEAR_WINDOW_MS`) on yhä koodivakio.

## Kenttänimen siivous

Tulospalvelun kenttänimi on sisäisessä muodossaan: `01 - Viinijärven
pallokenttä, tekonurmi 1| LEIRITUOTANTO`. Kenttänumero ja tuotantomerkintä
siivotaan oletuksena pois otsikosta, kuvauksesta, thumbnailista ja
jakoviestistä (#132) — yhdessä paikassa, `templateInputFromMatch`issa, koska
kenttänimi haarautuu siitä neljään suuntaan.

Säännöt ovat coressa (`venueDisplayName`), joten **selostus puhuu saman nimen
kuin otsikkoon kirjoitetaan**: aiemmin puhe kuului muodossa "nolla viisi viiva
Liperin kirkonkylän kenttä viisi" (#101).

Kytkimet ovat `run/venue-cleanup.json`issa samalla idiomilla kuin jakoviestin
pohja — oletukset levylle käynnistyksessä, luku joka pyynnöllä:

```json
{ "stripFieldNumber": true, "stripQualifier": true }
```

Vain kirjaimellinen `false` sammuttaa säännön; roska tai merkkijono `"false"`
tarkoittaa oletusta. Kytkimet ovat huoltoarkissa (#133, #188).
