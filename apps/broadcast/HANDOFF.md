# Relay — handoff seuraavaa live-testiä varten

## TODO 2026-07-16: live-ajon (ottelu 144733) löydökset

> Kerätty ajon aikana, **ei toteutettu** — käyttäjän pyynnöstä vain kirjattu
> ylös seuraavaa kehityssessiota varten.

### 1. Aloitusselostus tulee aivan videon alkuun — harva katsoja ehtinyt paikalle

**Havainto (käyttäjä):** ensimmäinen selostus alkaa heti kun relay/ottelu
käynnistyy, mutta siinä vaiheessa harva on vielä ehtinyt avata videota.
Ehdotus: viivytä ensimmäistä selostusta esim. **20 s** relayn/videon
käynnistyksestä, jotta katsojat ehtivät kytkeytyä ennen kuin mitään sanotaan.

**Ei toteutettu.** Harkittava toteutuskohta: `commentaryLoop.ts`/`index.ts`
käynnistyspolku — esim. kertaluonteinen viive ennen ensimmäistä `speak()`-
kutsua. Huomioi suhde esipelitäytteeseen (HANDOFF 07-15 kohta 5,
"Tervetuloa"-fraasit ~90 s välein) — 20 s viive koskisi todennäköisesti vain
ihan ensimmäistä repliikkiä, ei koko täytemekanismia.

### 2. YouTube-virhe: "Please use a keyframe frequency of four seconds or less"

**Havainto (YouTube Studio -virheilmoitus livenä):** "Please use a keyframe
frequency of four seconds or less. Currently, keyframes are not being sent
often enough, which can cause buffering. The current keyframe frequency is
5.0 seconds. Note that ingestion errors can cause incorrect GOP (group of
pictures) sizes."

**Todennäköinen syy:** relay käyttää `-c:v copy` (`ffmpegMixer.ts:98`) —
video läpäisee koskemattomana lähteestä, joten keyframe-/GOP-väli tulee
suoraan puhelimen striimauskoodekilta; relay ei enkoodaa videota eikä siksi
päätä keyframe-taajuudesta pushivaiheessa. **Emme luultavasti voi korjata
tätä relay-puolella** ilman videon uudelleenkoodausta
(`-c:v libx264 -g <fps*4> -keyint_min <fps*4> ...`), mikä toisi CPU-kuormaa ja
enkoodausviivettä rajalliselle VM:lle — tietoinen tehokkuus/laatu-kompromissi,
ei ilmainen korjaus. Vaihtoehto: puhelimen striimaussovelluksen omista
asetuksista tiivistää GOP/keyframe-väli ≤4 s:iin (lähdepään korjaus, ei
relayn).

**Ei toteutettu / avoin selvitys.** Ennen toteutusta selvitettävä: kannattaako
re-encode ollenkaan (CPU-hinta vs. hyöty — YouTuben ilmoitus voi olla vain
varoitus eikä aina näy katsojalle bufferointina), vai onko helpompi ohjata
käyttäjää säätämään puhelimen striimaussovelluksen GOP-asetusta.

### 3. ElevenLabs lausui ylimääräisen siansaksasanan lyhyen fraasin alkuun

**Havainto (käyttäjä kuuli livenä, klo 6:46:29 UTC):** kohteessa kuului
"reewer lyömässä lappalainen" — mutta lokissa selostusteksti oli täysin
normaali `Selostus: Lyömässä Lappalainen.` (16–20 merkin klippi). Ylimääräinen
"reewer"-alku ei siis tullut meidän tekstistä vaan **ElevenLabs-synteesistä**.

**Todennäköinen selitys:** ElevenLabsin tunnettu taipumus hallusinoida
ylimääräisiä äänteitä/sanoja hyvin lyhyiden syötteiden alkuun tai loppuun
(erityisesti multilingual-malleilla). Meidän lyhyimmät fraasit ("Lyömässä X.",
"Vuorossa X.") ovat juuri tässä riskiluokassa.

**Ei toteutettu — korjausideoita seuraavaan sessioon:**
1. Pidennä lyhyimpiä fraaseja luonnollisella tavalla (esim. "Ja lyömässä nyt
   Lappalainen.") — pidempi konteksti vähentää hallusinointia.
2. Kokeile `previous_text`-parametria EL-pyyntöön (antaa mallille kontekstin
   ilman että sitä puhutaan ääneen) — voisi vakauttaa lyhyet klipit.
3. Seuraa toistuuko: yksittäistapaus voi olla satunnainen; jos toistuu
   nimenomaan lyhyillä fraaseilla, priorisoi 1/2.

### 4. ~2 min hiljainen jakso kesken pelin tuntui katsojasta selostuksen loppumiselta

**Havainto (käyttäjä livenä, klo ~6:49–6:52 UTC):** pelissä oli luonnollinen
tapahtumaköyhä rako 6:49:37 → 6:51:28 (~2 min ilman paloja/pisteitä/vaihtoja),
ja putken ~30–90 s viive päälle — katsojalle tauko venyi niin pitkäksi, että
se tuntui selostuksen loppumiselta ("nyt loppui selostukset"). Relay oli koko
ajan terve: sama ffmpeg-sessio, ei respawneja, synteesi jatkui heti kun
tapahtumia tuli.

**Idea (ei toteutettu):** harkitse periodisen tilannekuvan/täytefraasin
laukaisua jo ~2 min hiljaisuuden jälkeen kesken pelin — nykyinen periodinen
tilannekuva ei ehdi laueta näin lyhyeen rakoon. Sukua idle filler
-ajatukselle (ennen peliä -täyte on jo olemassa, `formatWelcomeFiller`);
tämä laajentaisi saman periaatteen käynnissä olevaan peliin. Punnittava
puuduttavuutta vastaan: liian tiheä tilannekuva toistaa itseään — ehkä
lyhyt kevytfraasi ("Tilanne edelleen 5, 0") tai vaihteleva varianttijoukko.

### 5. Loppuselostukseen "Kiitos katsojille"

**Käyttäjän toive (ottelun 144733 päätyttyä):** samaan selostukseen jossa
ottelun kerrotaan päättyneen (loppuyhteenveto / `formatMatchEndRecap`,
`packages/core/src/speech.ts`) voisi lisätä kiitoksen katsojille, esim.
"Kiitos katsojille." Ei toteutettu — pieni lisäys, sopii tehtäväksi samalla
kun loppuyhteenvetoa seuraavan kerran muokataan.

### 6. Ottelun 144737 valvomaton ajo (iltapäivä 16.7.) — onnistui päästä päähän

Ensimmäinen kokonaan valvomaton lähetys (operaattori poissa, agentin
15 min watchdog-ketju): käynnistys 6 min etuajassa, ottelu selostettiin
kokonaan (Pesä Ysit 7–7 KaKa, yksi jakso, tasapeli), loppuyhteenveto ehti
ulos ~85 s ennen lähteen loppua, relay sammutti itsensä siististi
12 min ikkunan umpeuduttua ja watchdog ajoi lopetussiivouksen. 3850
EL-merkkiä. Kaksi havaintoa:

1. **Nimikolliisiologiikka sai kunnon live-testin ja toimi**: kokoonpanossa
   sekä Amal että Amira Gazdali ja Hulda että Hilda Kivilahti — kaikki
   luettiin koko etunimellä oikein, myös saman fraasin sisällä ("sen löi
   Amira Gazdali, tuojana Amal Gazdali").
2. **Pieni parannusidea:** kun ottelu on jo päättynyt (`state.finished`) ja
   lähde EOF:ää, relay jää silti yrittämään lähdettä koko
   `RELAY_MAX_FAILURE_WINDOW_MS`-ikkunan (nyt 12 min) ennen itsesammutusta.
   Päättyneen ottelun jälkeen odotus on turha — voisi luovuttaa heti tai
   esim. 1–2 min kuluttua, kun `finished` on tosi. Harmiton mutta hidastaa
   siivousta ja pitää prosessia turhaan pystyssä. Kosmeettinen sivuhuomio
   samasta ajosta: pistefraasi alkoi pienellä kirjaimella ("… tuojana Amal
   Gazdali. tasan 7, 7.") — ei kuulu puheessa, mutta lokissa näkyy.

## TODO 2026-07-15: live-ajon (ottelu 144193) löydökset ja jatkokehitys

> **Kohdat 1, 2, 3, 4 sekä pollausvälin pudotus korjattu 2026-07-15**
> (samana päivänä, ilman live-testiä — vahvistus seuraavassa ottelussa).
> Kohdat 5–7 (C: RTMP-flap-testi, isommat selvitykset/management-view)
> jätettiin tietoisesti tekemättä, edellinen striimi toimi eikä niitä
> pidetty kiireellisinä.
>
> - **1 (selostus jatkui ottelun päätyttyä)**: `commentaryLoop.ts` ja
>   `apps/web/src/watcher.ts` vaikenevat nyt kokonaan `state.finished`-tilassa
>   (ei tilannekuvia, täytefraaseja eikä vaihtokuulutuksia) — video/relay
>   jatkuu koskemattomana. Herääminen: jos pistetilanne muuttuu päättymisen
>   jälkeen, `finished` nollautuu ja selostus jatkuu normaalisti. Loppuun
>   lisättiin yksi kertaluonteinen laajempi yhteenveto (`formatMatchEndRecap`
>   `speech.ts`:ssä): vuoroparien/jaksojen määrä tai ratkaisu supervuorossa/
>   kotiutuslyöntikilpailussa, riippuen ottelun päättymistavasta.
> - **2 (pelaajanimi "3 S Sukunimi")**: valittu vaihtoehto — puhutaan pelkkä
>   sukunimi ("Lyömässä Korhonen."); jos kokoonpanossa kaksi samaa sukunimeä,
>   lisätään koko etunimi ("Lyömässä Anna Korhonen."). API antaa koko
>   etunimen, ei vain alkukirjainta, joten törmäystapaus on yksiselitteinen.
>   Toteutus `resolvePlayerName`/`buildPlayerLookup` (`packages/core/src/speech.ts`).
>   Feed näyttää edelleen raakamuodon (tarkoituksellinen asymmetria).
> - **3 (tauko selostusten väliin)**: n. 700 ms hiljaisuus lisätty sekä
>   relayn `NarrationQueue`:hen (`narrationFifo.ts`, klippien väliin, ei
>   viimeisen klipin jälkeen) että web-appin `_drainQueue`-jonon purkuun.
> - **4 (lähdemaininta)**: "Tulospalvelun mukaan…" / "Tulospalveluun on
>   kirjattu…" lisätty pickVariant-varianteiksi tilannekuviin (idle- ja
>   summary-fraasit) ja pistetapahtumiin (juoksu, tuotu juoksu) — vain osaan
>   variantteja, ei jokaiseen.
> - **5:n loppuosa (esipelitäyte)**: `formatWelcomeFiller` puhuu
>   tervetuloa-/odotusfraaseja ~90 s välein ennen ottelun alkua (tunnistetaan
>   tyhjästä `online/{id}/events`-historiasta). Kenttänimi mukana
>   sellaisenaan `|`-merkkiin asti siivottuna (`stadiumSpeechName`) — käyttäjän
>   päätös leiripelien koodimaisille kenttänimille ("12 Tupos B | LEIRITUOTANTO"
>   → "12 Tupos B").
> - **Pollausväli**: `RELAY_POLL_INTERVAL`-oletus 6000 → 4000 ms
>   (`config.ts`). Ei runtime-säädettävä (control-tiedosto-laajennus jätetty
>   tekemättä) — jos tarve tihentää/harventaa lennossa toistuu, se on yhä
>   avoin jatkokehityskohta.
> - **Ei tehty**: kohta 5:n API-kenttätarkistus jäi epäolennaiseksi (kenttä
>   löytyy aina `stadium.name`:sta); kohta 6 (striimaava/osittainen API) ja
>   kohta 7 (management web view) ovat yhä avoimia selvityksiä; C-kokonaisuus
>   (RTMP-flap-testi, `SourceExhaustedError`-luovutusehdon korjaus) rajattiin
>   pois tästä sessiosta käyttäjän päätöksellä.
>
> Testit: `packages/core/test/subEventSpeech.test.ts` (sukunimipuhe,
> loppuyhteenveto, lähdemaininta, tervetuloafraasi), `apps/broadcast/test/narrationFifo.test.ts`
> (klippien välinen tauko). Koko suite: `npx vitest run` (61/61 vihreä).
> **Ei vielä vahvistettu oikealla live-ottelulla.**

Ensimmäinen tuotantoajo ElevenLabsilla onnistui: ~42 min, 86 selostusta,
3048 EL-merkkiä, 2 ohimenevää API-timeouttia, ei respawneja. Alla löydökset
ja käyttäjän toiveet, prioriteettijärjestyksessä. Vastaavat merkinnät ovat
myös agentin muistissa (memory/), mutta tämä tiedosto on kanoninen työlista.

> Huom. julkinen repo: älä lisää tähän tiedostoon oikeita pelaajanimiä
> (otteluissa alaikäisiä) — esimerkit alla ovat keksittyjä.

### 1. BUGI: selostus jatkuu ottelun päättymisen jälkeen

**Oire (todennettu lokista):** klo 11.09.40 relay selosti "Ottelu päättyi!
Ysit Kylmä voitti…", mutta klo 11.11.45 tuli vielä periodinen tilannekuva
"Tilanne on edelleen 4, 3, kun Ysit Kylmä johtaa peliä niukasti" — väärä
sekä ajoitukseltaan että sanamuodoltaan (peli ei ollut käynnissä).

**Haluttu käyttäytyminen (käyttäjä määritteli):**
1. Loppuselostuksen jälkeen ei enää mitään selostusta — ei tilannekuvia,
   täytefraaseja eikä vaihtokuulutuksia.
2. Poikkeus: jos pistetilanne muuttuu päättymisen jälkeen (kirjuri lopetti
   pelin liian ajoissa ja avaa sen uudelleen — harvinaista mutta
   mahdollista), selostus herää taas. Päättynyt-tila ei siis ole
   peruuttamaton portti.
3. Video jatkuu normaalisti kunnes lähde loppuu — vain selostus hiljenee,
   relay/ffmpeg ei sammu päättymistapahtumaan.
4. Ennen hiljaisuutta saa tulla yksi laajempi loppuyhteenveto (kohta 5).

**Toteutuskohta:** sama paikka joka tuottaa "Ottelu päättyi" -selostuksen;
koskee todennäköisesti sekä broadcast- että web-polkua (`packages/core` /
selostussilmukka) — tarkista molemmat.

### 2. Pelaajanimi puhutaan raakana ("Lyömässä 3 S Sukunimi")

**Oire:** API antaa pelaajan muodossa pelinumero + etunimen alkukirjain +
sukunimi, ja se menee TTS:lle sellaisenaan — EL lukee "3 S" epäselvästi
nielaisten. Koskee kaikkia fraaseja joissa pelaajanimi esiintyy: vaihto-
kuulutukset JA juoksuselostukset ("Juoksun löi 6 E Sukunimi, tuojana…"),
eli korjaa yksi yhteinen nimenmuotoilufunktio, ei fraaseja erikseen.

**Kaksi vaihtoehtoa (käyttäjä ei ole vielä valinnut — ehdota molemmat):**
1. Foneettinen auki kirjoitus: "Lyömässä kolme äs Sukunimi" (numero sanaksi,
   kirjain foneettisesti kuten KPL → Koo Pee Äl -korvaukset).
2. Vain sukunimi; etunimi kokonaan vain jos kokoonpanossa kaksi samaa
   sukunimeä. HUOM: API näyttää antavan vain alkukirjaimen — tarkista onko
   koko etunimi ylipäätään saatavilla ennen tämän valintaa.

**Toteutuskohta:** `packages/core/src/speech.ts`, feedi näyttää edelleen
raakamuodon (feed peilaa lähdettä — tarkoituksellinen asymmetria).

### 3. Pieni tauko peräkkäisten selostusten väliin

~0,5–1 s tauko selostusjonon purkuun, jotta rypäänä tulevat puheet (useita
tapahtumia samassa pollissa) erottuvat toisistaan. Yleensä erottuvuus on
hyvä — kyse on nimenomaan rypästilanteista. Toteutus jonon purkuun
(`apps/broadcast` commentaryLoop), EI puhetekstiin (SSML ei ole luotettava
EL/Piper-poluilla). Tarkista koskeeko sama web-appin puhejonoa.

### 4. Lähdemaininta osaan selostuksista

Osaan fraaseista "Tulospalvelun mukaan…" / "Tulospalveluun on kirjattu…",
jotta katsojille on selvää mistä tiedot tulevat ja miksi ne tulevat kuvaan
nähden myöhässä (~30–90 s). Vain osaan — jatkuva toisto puuduttaisi.
Luonteva toteutus: pickVariant-varianttijoukkoihin osaksi fraaseja
(tilannekuvat, pistetapahtumat). Ehdota muotoilut käyttäjälle ennen
toteutusta.

### 5. Esipelitäyte ja laajempi loppuyhteenveto

**Ennen peliä:** jos lähetys alkaa reilusti ennen ottelua, tervetuloa-
fraaseja ~1,5 min välein: "Tervetuloa katsomaan ottelua X vastaan Y,
pelikenttänä Z", "Odottelemme pelin alkua" jne. Kenttä-/paikkatieto: tarkista
saadaanko API:sta; jos ei, jätä kenttäfraasit pois — älä keksi paikkaa.

**Pelin jälkeen:** kertaluonteinen kokoava yhteenveto: "Peli loppui X:n
voittoon luvuin 4, 3. Pelissä pelattiin tänään 3 vuoroparia" tms.
Vuoroparien/jaksojen määrä päätellään tapahtumista — formaatit vaihtelevat
(leiripeleissä usein 1 jakso), älä oleta 2 jaksoa. Tämän jälkeen kohdan 1
hiljaisuussääntö.

### 6. Selvitys: striimaava/osittainen API

> **Selvitetty 15.7.2026** (frontendin main.js-analyysi + API-kokeet päättyneellä
> ottelulla 144202). Löydökset:
>
> - **Ei WebSocketia/SSE:tä.** Sivusto itse pollaa samaa
>   `online/{id}/events`-päätepistettä `setTimeout(…, 6e3)`-silmukalla (6 s).
>   ("SignalR"-osumat JS:ssä olivat Angularin `consumerOnSignalRead`-symboleja.)
> - **Delta-parametri on olemassa: `after=YYYY-MM-DD HH:mm:ss`** —
>   Europe/Helsinki-aikaa, välilyönnillä (frontend: `latestTimestamp
>   .tz("Europe/Helsinki").format("YYYY-MM-DD HH:mm:ss")`). Väärä muoto →
>   400 `{"error":"Virheellinen aikaleima"}`. Frontend käsittelee vastauksen
>   `reset`-lipun (palvelin voi palauttaa koko setin + reset). HUOM:
>   päättyneellä ottelulla `after` palautti aina koko historian — **vaikutus
>   pitää verifioida live-ottelua vasten** ennen käyttöönottoa.
> - **`skip-delay=true`-parametri on olemassa** (frontend lähettää jos
>   `window.skipDelay` asetettu) → API ilmeisesti viivästää tapahtumia
>   oletuksena. Jos toimii julkisella avaimella, tämä voi leikata
>   feed-viivettä — testaa live-ottelussa.
> - **Palvelinpuolen välimuisti ~5 s** (`cache-control: max-age=5`,
>   `x-pesis-cache`-header, Cloudflare edessä) → alle ~5 s polli ei tuo
>   uudempaa dataa. Nykyinen 4 s `RELAY_POLL_INTERVAL` osuu jo tähän rajaan.
> - **ETag/If-None-Match toimii** (304, 0 tavua) → halpa tapa pollata
>   tiheämminkin ilman 28 kt:n runkoja.
> - Rate-limitistä ei merkkejä (ei 429:iä lokeissa eikä kokeissa).
>
> Seuraava askel: live-ottelun aikana kokeile `after`- ja `skip-delay`-
> parametreja curlilla rinnan täyden haun kanssa; jos delta toimii, lisää
> ETag-ehdollinen haku + `after` commentaryLoopiin ja tihennä polli ~3 s:iin.

> **Live-vahvistus 16.7.2026 (ottelu 144733), curlilla rinnan käynnissä
> olevan relayn kanssa — relayä ei kosketettu, pelkkiä GET-pyyntöjä.**
> Kaikki kolme aiempaa oletusta vahvistuivat, yksi niistä päinvastaiseksi
> kuin päättyneellä ottelulla nähty:
>
> - **`after=` TOIMII OIKEANA DELTANA LIVE-OTTELUSSA** (toisin kuin
>   päättyneellä ottelulla, joka aina palautti koko historian). Pyyntö
>   `after=2026-07-16%2009%3A35%3A00` palautti 14 tapahtuman koko listan
>   sijaan vain 4 tuoretta tapahtumaa (id 1–4, klo 09:35:16 alkaen) — täysin
>   pudottaen edellisen vuoron 11 tapahtumaa. `reset` pysyi `null`:na koko
>   testin ajan. **Tämä oli aiemmin suurin avoin epävarmuus — nyt poistettu.**
> - **`skip-delay=true` leikkaa julkaisuviivettä mitattavasti.**
>   Samanaikainen rinnakkaisvertailu (kaksi curlia samassa hetkessä, eri
>   prosessit): ilman parametria tuorein tapahtuma oli 108 s vanha, parametrin
>   kanssa 83 s — n. 25 s (~25 %) vähemmän julkaisuviivettä yhdessä
>   mittauksessa, toisessa mittauksessa 123 s → 68 s (~45 %). Toimii julkisella
>   API-avaimella. Yhdistettävissä `after`-parametrin kanssa samassa
>   pyynnössä (testattu, molemmat voimassa yhtä aikaa).
> - **ETag/If-None-Match vahvistettu käytännössä**: peräkkäinen pyyntö 1 s
>   välein samalla `If-None-Match`-headerilla palautti `304` kun dataan ei
>   ollut tullut muutosta; toinen pyyntö uusien tapahtumien saavuttua
>   palautti `200` odotetusti.
>
> **Ei vielä toteutettu koodiin** — pelkkä curl-vahvistus, käyttäjän
> pyynnöstä ei koskettu käynnissä olevaan relayyn (src-muutos vaatisi
> restartin, joka katkaisisi live-lähetyksen hetkeksi). Seuraava askel on
> yhä 6:n alkuperäinen ehdotus: lisää `after`+`skip-delay`+ETag-ehdollinen
> haku `commentaryLoop.ts`:ään ottelun ulkopuolella, sitten vahvista
> uudella live-ajolla. Odotettu hyöty: tapahtuma→feed-julkaisuviive
> (pohjaosa ~123 s tässä ottelussa, ks. myös 6b) pienenee ehkä ~30–45 %;
> kokonaisviiveestä (~30–90 s puheeseen saakka) suurin osa on silti
> video-pipelinessä, joten tämä ei poista kokonaisviivettä, vain lyhentää
> API-osuutta siitä.

Alkuperäinen kysymys: nykyinen polli tuottaa katkonaisen rytmin ryppäissä.
Huom: kokonaisviiveestä valtaosa tulee video-pipelinesta — tämä parantaa
rytmiä, ei kokonaisviivettä.

#### 6b. Viiveanalyysi ottelusta 144202 (15.7.2026)

Vertailtiin API:n tapahtuma-aikaleimoja (`timestamp` = sekunteja ottelun
epochista) relayn lokin havaitsemishetkiin, 17 paloa + 11 juoksua:

- **Viiveen pohja ~130 s, hajonta 129–190 s.** Eli jokainen tapahtuma näkyy
  julkisessa API:ssa vasta ~2 min tapahtumahetken jälkeen, ja päälle tulee
  0–60 s jitteriä. Pollauksen osuus (≤ ~10 s) on tästä murto-osa.
- Pohjaviive sopii täsmälleen `skip-delay`-löydökseen: **API viivästänee
  julkista feediä ~2 min oletuksena.** Jos `skip-delay=true` toimii julkisella
  avaimella, se on ylivoimaisesti suurin yksittäinen parannus.
- 0–60 s jitter selittää käyttäjän havainnon "pitkä tauko, sitten 3–4
  selostusta putkeen": viiveikkunan ylittäneet tapahtumat vapautuvat
  ryppäänä samaan polliin (esim. ts 2085 ja 2086 molemmat selostettu
  14:07:04).
- HUOM mittauksen luonteesta: vertailu on kahden lähteen välinen — API:n
  `timestamp`-kenttä (kirjurin kirjaama) vs. relayn lokin speak-hetki.
  **Kirjurin oma viive ei ole havaittavissa eikä kuulu tähän lukuun:
  kirjurin aikaleima on meidän ground zero, muuta totuutta ei ole.**
  Jitter jakautuu siis vain kahteen mitattavissa olevaan osaan:
  API-puolen julkaisuviive (timestamp → näkyy feedissä) ja meidän
  havaitsemisviive (näkyy feedissä → speak). Erottelu vaatii first-seen-
  lokituksen (alla).

#### 6c. first-seen-lokitus viiveen erotteluun

> **Toteutettu 2026-07-15** (`commentaryLoop.ts`, ilman live-testiä).
> Ottelun epoch ei tule API:sta/metadatasta (`MatchMetadata.date` on vain
> päivämäärä ilman kellonaikaa) — se päätellään ajon aikana: koska
> julkaisuviive on aina ≥0, `havaitsemishetki − ts` on epochin yläraja
> jokaiselle first-seen-tapahtumalle, ja juokseva minimi (`matchEpochMs`)
> lähestyy todellista epochia ajon edetessä. Jää pysyvästi vinoutuneeksi
> alaspäin ensimmäisen havainnon todellisen viiveen verran (ei siis
> absoluuttinen kello), mutta hajonta/trendi saman ajon sisällä on
> luotettava. Loki kirjoitetaan `processEventsLive`:ssä ennen
> sub-event-silmukkaa, yksi rivi per tapahtuma jolla on aidosti uusi
> sormenjälki (`hasNewSubEvent`, jaettu muuttuja vaihtokuulutus-gatelle).
> Tyypit + `npx vitest run` (61/61) vihreitä. **Ei vielä vahvistettu
> live-ottelulla** — seuraava ajo näyttää toimiiko epoch-arvio käytännössä
> ja voiko datasta erotella API- vs. oman osuuden.

Pieni lisäys `commentaryLoop.ts`:n pollikäsittelyyn: kun tapahtuma-id
nähdään pollivastauksessa ensimmäistä kertaa, lokitetaan yksi rivi:

```
first-seen: id=38713041 ts=2376 delta=142s
```

missä `ts` on API:n timestamp (sekunteja ottelun epochista) ja `delta` =
first-seen-kellonaika miinus (ottelun epoch + ts). Tällä seuraavan
live-ajon lokista voi laskea suoraan:

- **API-julkaisuviive** = delta (timestamp → ensinäkymä feedissä), ja
- **meidän osuus** = speak-hetki miinus first-seen-hetki (pollirytmi +
  käsittely + synteesijono).

Toteutushuomiot: id-joukko on jo käytännössä olemassa
(`seenFingerprints`) — lokita vain kun fingerprint on aidosti uusi, yksi
rivi per tapahtuma (ei per sub-event), ei puhetta, pelkkä loki. Ottelun
epoch saadaan `match-started`-statista (ensimmäinen tapahtuma) tai
metadatasta. Rinnalle sama mittaus `skip-delay=true`-parametrilla
(erillinen curl-näytteistäjä riittää) kertoo suoraan paljonko skip-delay
leikkaa API-julkaisuviivettä.

Koodipuolen pienemmät parannukset (toissijaisia yllä olevaan nähden):

> **1 ja 2 korjattu 2026-07-15** (`commentaryLoop.ts`, ilman live-testiä).
> `speak()` ei enää `await`aa sinkkiä (TTS-synteesi + miksaus) inline, vaan
> luovuttaa sen omaan järjestyksen säilyttävään `synthQueue`-promise-jonoon;
> bokkipiito (dedupe, lastSpeechAt, announcementCount) tehdään yhä
> synkronisesti päätöshetkellä. Poll-silmukka pollaa nyt kiinteällä tahdilla
> (`nextPollAt`-ajastus unen sijaan) — jos yksi kierros ylittää pollausvälin,
> seuraava ajastetaan nykyhetkestä eikä ryppäänä. `API_TIMEOUT_MS` pudotettu
> 8000 → 4000 ms sekä käynnistys- että pollihakuihin (uusi `timeoutMs`-optio
> `packages/core/src/api.ts`:n `ApiOptions`:iin, oletus pysyy 8000:ssa muille
> kutsujille kuten web-appille). Tyypit + `npx vitest run` (61/61) vihreitä.
> **Ei vielä vahvistettu live-ottelussa** — vahvista seuraavassa ajossa ettei
> ryppäitä enää synny yhtä voimakkaasti.
>
> 3 on avoin.

1. ~~**Synteesi blokkaa pollin:**~~ ks. yllä.
2. ~~**Fetch-timeout 8 s on tarpeettoman pitkä**~~ ks. yllä.
3. ETag-ehdollinen haku (304) tekee tiheämmästäkin pollista halvan.

### 7. Management web view (isompi kokonaisuus, ideointi kesken)

Valvontanäkymä relaylle, saatavilla vain Tailscalen kautta (ei julkiseen
nettiin, ei Pages-deployhin): striimin tila (relay/ffmpeg/lähde), palvelimen
RAM/CPU/levytila (2 Gt raja kriittinen), lokivirheet esiin nostettuna, ja
täydellinen selostuslista kaksivaiheisella tilalla — teksti ilmestyy heti
kun tapahtuma tunnistetaan lähteestä ja rivi korostuu kun se oikeasti
puhutaan (tekee jonon ja viiveen näkyväksi). Lisäideoita: vaihtoselostuksen
on/off-kytkin UI:hin (nyt control-tiedosto), EL-merkkilaskuri, sydänäänen
ikä, respawn-historia. Suunnittele ja ehdota ennen toteutusta.

### 8. Synkroniset fs-kutsut poll-silmukassa jitteröivät narraation 20 ms -tickiä

**Löydös (koodikatselmus 2026-07-15, ei lokitodennettu):** Node on
yksisäikeinen, ja sama event loop ajaa sekä `NarrationFifo`n 20 ms
-framekirjoittimen (`narrationFifo.ts`, ffmpegin `amix` ei siedä nälkää)
että `CommentaryLoop`in poll-silmukan. Poll-silmukka teki joka kierroksella
(oletus 4 s) kaksi **synkronista** fs-kutsua, jotka blokkaavat koko event
loopin — myös FIFO-tickin — syscallin ajaksi:

1. `refreshRuntimeControls()`: `readFileSync(controlFile)` joka pollilla
   (`commentaryLoop.ts`).
2. `saveState()`: `writeFileSync(stateFile, JSON.stringify(...))` joka
   pollin lopussa (`nodeState.ts`). Serialisoitava `seenFingerprints`-Set
   kasvaa koko ottelun ajan, joten kirjoitus hidastuu pelin edetessä.

Jos levy-I/O tökkii edes kymmeniä millisekunteja (VM:n levy on rajallinen),
FIFO-tick myöhästyy saman verran → ffmpeg saa narraatioframen myöhässä →
mahdollinen kuultava jitter/katko mixissä, toistuvasti joka poll-sykli.
Kertaluonteiset käynnistyspolun sync-kutsut (`loadState`,
`loadPronunciations`, `writeControlFile`) ajavat ennen kuin FIFO tickaa,
ne eivät ole ongelma.

> **Korjattu 2026-07-15** (ilman live-testiä): per-poll-kutsut vaihdettu
> `fs/promises`-vastineisiin — `saveState` on nyt async (`writeFile`) ja
> `refreshRuntimeControls` lukee control-tiedoston `readFile`:lla; poll-
> silmukka awaitaa molemmat, jolloin FIFO-tick ajaa I/O:n aikana vapaasti.
> Käynnistyspolun sync-kutsut jätetty ennalleen (eivät kilpaile tickin
> kanssa). Vaikutusarvio maltillinen: ei selitä 6b:n 0–60 s jitteriä
> (se on API-julkaisuviivettä), vaan poistaa mahdollisen ms-luokan
> äänijitterin lähteen mixistä.

### Sivuhuomiot ajosta

- Kaksi "Hakuvirhe: This operation was aborted" -riviä (API-timeout) —
  relay toipui itsestään seuraavassa pollissa, ei toimenpiteitä.
- `npm run broadcast:dev` ei lataa `.env.relay`-tiedostoa (vain systemd-unit
  lataa EnvironmentFile-rivillä) — dry-run näyttää siksi Piper-äänen vaikka
  oikea ajo käyttää ElevenLabsia. Ei bugi, mutta hämäävä; dokumentoinnin
  arvoinen jos toistuu kysymyksenä.

## TODO 2026-07-14: live-testin (ottelu 144197) löydökset — ✅ KAIKKI KORJATTU

> **Ratkaistu 2026-07-14 (samana päivänä).** Kaikki 6 huomiota alla on korjattu:
> - **1 (fingerprint pudottaa paloja)** ja koko relayn v1→v2-migraatio:
>   commit `28c772c`. Relay lukee nyt `v2/src`:ää (kanoninen), ei kuollutta
>   `src/` (v1) -koodia; v2:n koordinaattipohjainen `eventFingerprint` +
>   `recomputeCurrentOutsKeyed`/`outsThroughSubEvent` hoitavat palot oikein.
> - **2 (formatScore väärä järjestys)**: commit `7e9e039` (`packages/core/src/speech.ts`).
> - **3, 4, 5 (relay-ottelu-skill)**: `.claude/skills/relay-ottelu/SKILL.md`
>   (gitignoressa, lokaali — muutokset työtiedostossa).
> - **6 (ffmpeg HLS-keepalive-lokitulva)**: commit `a13687e`.
>
> Molemmat puhebugit todennettu oikealla ottelun 144197 datalla: palot
> laskevat 1‑2‑3 vuoroittain ja vieraan johtaessa pisteet luetaan koti ensin
> (`3, 6, KaKa johtaa`). Regressiotestit: `test/v2-speech.test.ts`.
> **Ei vielä ajettu oikeassa live-relayssa migraation jälkeen** — seuraava
> live-testi vahvistaa end-to-end.
>
> Alkuperäiset löydöskuvaukset (juurisyineen) säilytetty alla historiaksi.

Testi: lähde `youtube.com/watch?v=4X--QV-ZuyA`, selostettu kohde
`youtube.com/watch?v=EHOVOWnmzK4` (stream key mxbf-…), ottelu-ID 144197
(Pesä Ysit, Lappeenranta = koti vs Kauhajoen Karhu = vieras). Kuusi
huomiota, kaikki tekstinä alla koska agentin sisäinen Task-lista ei säily
istuntojen välillä.

### 1. BUGI (kriittinen): eventFingerprint pudottaa paloja

**Oire:** relay sanoi "ensimmäinen palo joukkueelle Ysit Kylmä" kun joukkue
oli oikeasti saanut KOLMANNEN palon vuorossaan; myös KaKa:n paloja jäi
sanomatta kokonaan.

**Juurisyy (varmistettu API-datalla, match 144197):**
`src/speech.ts:521`:
```js
export function eventFingerprint(event: LiveEvent, subIndex: number): string {
  const sub = event.events[subIndex];
  if (!sub) return `${event.id}:${subIndex}`;
  return `${event.id}:${JSON.stringify(sub.texts)}`;
}
```
Sormenjälki sisältää vain `event.id` + sub-eventin tekstin, EI
vuorokoordinaatteja (team/batTurn/inning/period). `event.id` nollautuu joka
lyöntivuorolla (API palauttaa aina koko historian, id-sarjat toistuvat
vuoroittain), ja jokaisen Palo-tapahtuman teksti on identtinen:
`[{type:"event",text:"Palo",base:null},{type:"stat",out:1}]` (`out` on aina
1, ei kumulatiivinen). Eri vuorojen samalla `event.id`:llä oleva palo tuottaa
siis saman sormenjäljen → `isEventFullyProcessed`/`alreadySeen` tulkitsee sen
jo nähdyksi → sekä `currentOuts++` että itse selostus (`subEventToSpeech`)
ohitetaan (`continue`).

Simulaatio API-datasta (match 144197, tallennettu käsittelyn ajaksi
`/tmp/ev144197.json`): vuoro Ysit palot id 2/10/14 → id 2 ja 10 pudotettiin,
vain id 14 laskettiin "ensimmäiseksi". KaKa-vuorosta 2/3 paloa pudotettiin.

Tämä on **regressio** muistiinpanossa `reference-event-id-resets-per-turn`
kuvatusta bugista, jonka piti olla korjattu ("fingerprints MUST include turn
coords except period 3"). Korjaus on ilmeisesti kadonnut/regressoinut.

**Korjaus:** sisällytä vuorokoordinaatit sormenjälkeen, esim.
`${event.period}:${event.team}:${event.batTurn}:${event.id}:${JSON.stringify(sub.texts)}`
(varmista `LiveEvent`-tyypin kentät `src/types.ts`; huomioi period 3
-erikoistapaus, ks. muisti). **HUOM:** `speech.ts` on jaettu pääsovelluksen
(WatcherController) ja relayn kesken — sama bugi koskee molempia, korjaus
hyödyttää molempia. Lisää regressiotesti joka toistaa cross-turn
id-törmäyksen. Vahvista live-testin datalla fixtuuriksi **fiktiivisin
nimin** (ks. `feedback-fixtures-fictional-names`-muisti).

### 2. BUGI: formatScore sanoo pisteet väärässä järjestyksessä

**Oire:** puhe sanoi "6, 3, KaKa johtaa" vaikka ottelu on "Pesä Ysit (koti) -
KaKa (vieras)" — pitäisi olla "3, 6, KaKa johtaa" (kotijoukkueen pisteet
aina ensin, ottelujärjestyksessä).

**Juurisyy** (`src/speech.ts:68-72`):
```js
function formatScore(meta: MatchMetadata, homeRuns: number, awayRuns: number): string {
  if (homeRuns > awayRuns) return `${homeRuns}, ${awayRuns}, ${meta.home.shorthand} johtaa`;  // koti ensin (OK)
  if (awayRuns > homeRuns) return `${awayRuns}, ${homeRuns}, ${meta.away.shorthand} johtaa`;  // VIERAS ENSIN (väärä järjestys)
  if (homeRuns === 0 && awayRuns === 0) return "nolla nolla";
  return `${homeRuns}, ${awayRuns}, tasatilanne`;
}
```
Kun vieras johtaa, luvut menevät väärässä järjestyksessä. Vain tämä haara on
väärin; tasapeli- ja koti-johtaa-haarat tulostavat jo koti ensin.
`formatSituationSummary` (speech.ts:240) tekee tämän jo oikein — käytä
referenssinä.

**Korjaus:** tulosta AINA `${homeRuns}, ${awayRuns}` (koti ensin)
riippumatta kummalla on johto; vaihda vain "X johtaa"/"tasatilanne"-teksti
tilanteen mukaan. Auditoi kaikki `formatScore`-kutsukohdat (rivit
~198,219,301,306,311) + `formatPeriodsWon` (rivi 45-46, näyttää jo oikein
tarkistuksen arvoinen). Lisää regressiotesti: vieras johtaa → koti ensin
puheessa. Jaettu tiedosto, korjaus hyödyttää sekä relayta että pääsovellusta.

### 3. Skill relay-ottelu: selkeämpi Auto-start-ohje

Kohdassa 2 ("Luo toinen YouTube-lähetys") korosta vahvemmin, että Auto-start
(ja Auto-stop) PITÄÄ laittaa päälle jo lähetystä LUODESSA — sitä ei voi
kytkeä päälle enää jälkikäteen (`contentDetails.enableAutoStart`). Lisää
oire jonka operaattori näkee jos unohtaa: selostettu lähetys jää "Waiting
for <stream>" -tilaan vaikka relay pushaa dataa oikein (ffmpeg ESTAB, ei
respawneja). Korjaus: jos Auto-start unohtui, paina Studiossa "Go live"
käsin — feed on jo ingestissä, joten lähetys lähtee heti liveen. Testissä
2026-07-14 juuri tämä (unohtunut Auto-start) jätti kohdelähetyksen
odottamaan, ja käsin Go live korjasi sen.

### 4. Skill relay-ottelu: varmista lähde vs. kohde -sekaannus

Kohtaan 1 ("Kerää tarvittavat tiedot") lisää eksplisiittinen
varmistusvaihe: LÄHDE (`RELAY_YOUTUBE_URL`) = puhelimen alkuperäinen live
jota LUETAAN; KOHDE (videoId + stream key) = se toinen, selostettu lähetys,
johon PUSHATAAN. Näitä ei saa sekoittaa. Erityissääntö: jos käyttäjä antaa
vain YHDEN YouTube-linkin, älä oleta että se on lähde — kysy/varmista onko
se lähde vai kohde. Vihje: kentät kuten stream key, "näkyvyys: unlisted" ja
"thumbnail kopioitu" kuvaavat KOHDETTA, eivät lähdettä. Tausta: testissä
kohde (videoId EHOVOWnmzK4 + stream key + thumbnail) meni vahingossa
`RELAY_YOUTUBE_URL`:iin; oikea lähde oli eri video (4X--QV-ZuyA), joka
jouduttiin pyytämään erikseen.

### 5. Skill relay-ottelu: valmis YouTube Studio -linkki käyttäjälle

Kun relay on käynnistetty ja kohteen videoId tiedetään, tulosta käyttäjälle
valmis klikattava Studio-linkki muodossa
`https://studio.youtube.com/video/<VIDEO_ID>/livestreaming` (esim.
`https://studio.youtube.com/video/EHOVOWnmzK4/livestreaming`), jotta
käyttäjä pääsee heti tarkistamaan lähetyksen tilan / painamaan Go live
tarvittaessa. Lisää skillin kohtaan 5 ("Käynnistä ja varmista") ja/tai
AJON AIKANA -osioon. Älä kääri URLia `**`-merkkeihin (terminaali näyttää
kirjaimelliset asteriskit).

### 6. Relay: hiljennä ffmpegin HLS-keepalive-lokitulva

Loki tulvii ffmpegin varoituksia lähdepuolen (HLS-pull) keepalivesta:
"Cannot reuse HTTP connection for different host: rr1---sn-XXXX !=
rr1---sn-YYYY" + "keepalive request failed ... 'Invalid argument' ...
retrying with new connection", toistuen joka ~5 s segmentillä. Syy: YouTube
kiertää HLS-CDN-hostia playlistin sisällä, ja ffmpegin oletus
`-http_persistent 1` yrittää uudelleenkäyttää pysyvää yhteyttä eri
hostille → epäonnistuu, avaa uuden. Vaikutus: **ei toiminnallista haittaa**
— lähde pysyi reaaliajassa (segmentit etenivät tahdissa, ffmpeg vakaa, ei
respawneja, selostus miksautui normaalisti). Ongelma on vain se että
lokitulva hukuttaa alleen oikeat Selostus:/Palo:/Sydänääni-rivit ja
vaikeuttaa seurantaa. Korjaus: lisää HLS-inputin optioihin
`apps/broadcast/src/ffmpegMixer.ts` `buildFfmpegArgs`:iin `"-http_persistent", "0"`
(harkitse myös `-reconnect 1 -reconnect_streamed 1
-reconnect_delay_max 5` lähteen sitkeyteen). Aseta VAIN lähde-inputille
(ennen ensimmäistä `-i sourceUrl`), ei FIFO-inputille. Testaa ettei
keepalive-spam enää toistu ja että selostus yhä miksautuu. Src-muutos
committaa itsensä hookilla + vaatii relayn uudelleenkäynnistyksen (katkaisee
live-lähetyksen hetkeksi), joten tee ottelun ulkopuolella.

---

Kirjoitettu alun perin 2026-07-10 (PR #20), päivitetty samana päivänä toisen
live-testin (klo 11.46–12.45, ottelu 143280, KeKi Blue–IPV oli väärä pari —
oikea ottelu oli **PomPy / OuHu vastaan IPV**, video
`youtube.com/watch?v=LnCQlDETXUc`) tulosten ja sen jälkeisen bugikorjaus-
session perusteella.

## Nykytila

- **M0, M2, M4, M5 ✅** — RTMP-julkaisu oikeaan toiseen YouTube-lähetykseen
  testattu ensimmäistä kertaa onnistuneesti 2026-07-10 (ottelu 143280).
  Relay pyöri ~1h, kaksi määräaikaista URL-respawnia (15 min välein — ks.
  alla RELAY_URL_REFRESH_MS-bugi), ja jatkoi RTMP-pushia molempien jälkeen.
- **M3 ✅ korvakuulolta** — ääniraita kuunneltu oikeasti (ei vain
  rakennetta). Pääosin synkassa ja siisti. Yksi todellinen ongelma löytyi:
  selostus saattoi katketa kesken sanan juuri respawnin kohdalla — **korjattu
  tässä sessiossa**, ks. Korjatut bugit.
- **M6 osittain** — URL-rotaatio (15 min välein) tapahtui kahdesti testin
  aikana ja on nyt käytännössä katettu (respawn toimii, katko-ongelma
  korjattu). **Ei vielä testattu**: käyttäytyminen RTMP-push-katkoilla, tai
  alkuperäisen striimin katkeaminen kesken (ei vain sen loppuminen).
  Striimin **loppuminen** sen sijaan testattiin tahattomasti stream-testin
  lopussa ja paljasti ikuisen retry-luupin — **korjattu**, ks. alla.

## Korjatut bugit (tässä sessiossa, ilman erillistä live-testiä)

Kaikki kolme löytyivät 2026-07-10 live-testin lokeista
(`journalctl --user -u pesisselostaja-relay`, klo 11.46–12.45) ja korjattiin
jälkikäteen. Yksityiskohdat commit-viestissä.

1. **Palolaskuri saattoi nollautua kesken vuoron** (esim. `Palo: PomPy / OuHu
   1` → `2` → sitten taas `1` kolmannen palon sijaan, klo 12.04.07–12.04.45).
   Juurisyy: sekä `src/watcher.ts` (pääsovellus, ei vain relay!) että
   `apps/broadcast/src/commentaryLoop.ts` nollasivat `currentBatTeamId`/`currentOuts`
   ehdoitta jokaisella pollauksella koko tapahtumahistorian yli, koska
   `online/{id}/events` palauttaa aina kaiken historian eikä vain uudet
   tapahtumat. Yksittäinen jälkikäteen korjattu/eri järjestyksessä toistuva
   historiatapahtuma pystyi näin nollaamaan laskurin turhaan kesken vuoron.
   **Korjattu**: nollaus koskee nyt vain kyseisellä pollauksella *uusia*
   tapahtumia (`isEventFullyProcessed`, `src/speech.ts`). Regressiotesti
   `test/speech.test.ts`:ssä toistaa täsmälleen havaitun 2→1-bugin
   ottelun 143280 dataa vastaavalla synteettisellä tapahtumasarjalla —
   **toistettavissa ilman livepeliä**: `npx vitest run test/speech.test.ts`.
   Koska sama bugi oli `watcher.ts`:ssä, tämä koski myös pääsovelluksen
   HA/selainselostusta, ei pelkkää relayta.
2. **Selostus saattoi katketa kesken sanan respawnissa.** Määräaikainen
   URL-päivitys tappoi ffmpegin heti, vaikka FIFO:on oli juuri kirjoitettu
   ääntä jota ffmpeg ei ollut vielä ehtinyt lukea/enkoodata (Linux-putken
   puskuri, ~64 kt ≈ viimeiset ~300 ms selostusta). **Korjattu**:
   `FfmpegMixer` odottaa nyt selostusjonon tyhjenemistä (+ n. 500 ms
   valumamarginaali, enintään 10 s) ennen respawn-SIGTERM:iä. Ffmpeg-
   kaatumiset ja RTMP-katkot reagoivat yhä heti — vain itse ajastettu
   respawn odottaa.
3. **Ikuinen 30 s -retry-luuppi kun alkuperäinen lähde on oikeasti loppunut.**
   Nähtiin suoraan lokeista klo 12.44–12.45: yt-dlp epäonnistui kuusi kertaa
   peräkkäin, relay olisi jatkanut yrittämistä loputtomiin ilman käsin
   pysäytystä. **Korjattu**: `FfmpegMixer` luovuttaa (`SourceExhaustedError`)
   5 minuutin yhtäjaksoisen epäonnistumisen jälkeen, ja `index.ts` sammuttaa
   koko relay-prosessin siististi sen sijaan että jäisi silmukoimaan.

**Sivuhuomio (löytyi korjauksen yhteydessä):** `RELAY_URL_REFRESH_MS` ei
tehnyt mitään, vaikka se asetettiin `.env.relay`:iin edellisessä live-
testissä (arvoksi 14400000 = 4h) — `config.ts` ei koskaan lukenut sitä, joten
relay käytti koko testin ajan 15 min oletusta (näkyy lokeissa: respawnit
~902 s ja ~903 s kohdalla, ei ~4h). **Korjattu**: `RELAY_URL_REFRESH_MS`/
`--url-refresh-ms` on nyt oikeasti kytketty. Jos seuraavassa testissä
halutaan pidempi respawn-väli (esim. koko ottelun mittainen, jotta URL-
rotaatiota ei tarvitse testata joka kerta), aseta se `.env.relay`:iin.

## Opit edellisestä live-testistä

- **Auto-start/auto-stop**: relay käynnistettiin ja sammutettiin käsin
  `systemctl --user start/stop pesisselostaja-relay.service` juuri ennen/
  jälkeen ottelun, kuten suunniteltu — toimi odotetusti, ei automaatiota.
- **Viiveodotukset**: respawn (yt-dlp-resoluutio + ffmpeg-kylmäkäynnistys +
  FIFO-kättely) kestää useita sekunteja — tämä on odotettua, ei bugi
  sinänsä. Erota se korjatusta selostuskatko-bugista (yllä, kohta 2): lyhyt
  äänetön tauko respawnissa on normaalia, mutta sanan kesken katkeaminen ei
  ollut.

## Mitä pitää testata seuraavaksi (tärkeysjärjestyksessä)

1. **Vahvista korjaukset oikealla live-lähetyksellä — OSITTAIN TEHTY
   2026-07-14** (ottelu 144197): RTMP-push oikeaan toiseen lähetykseen
   toimi päästä päähän ~30 min ajan, ei respawneja (URL_REFRESH_MS=4h),
   ei kaatumisia. **Ei vielä nähty**: respawn-käyttäytymistä yhtään
   kertaa tässä testissä (väli oli liian pitkä), joten sanan kesken
   -katko-korjaus on yhä vahvistamatta oikealla ajolla. Jos alkuperäinen
   striimi joskus päättyy kesken testin, sammuuko relay siististi 5 min
   sisään sen sijaan että jäisi silmukoimaan — ei myöskään testattu (lähde
   ei loppunut kesken tämän testin).
2. **RTMP-push-katko / verkkotökkiminen** (M6, ei vielä koskaan testattu) —
   simuloi esim. sammuttamalla verkko hetkeksi kesken ajon, tarkista että
   respawn-backoff toimii eikä narration-jono kasva rajattomasti sinä
   aikana.
3. **Alkuperäisen striimin katkeaminen kesken** (ei loppuminen) — eri
   tilanne kuin testattu "striimi loppui pysyvästi": tässä yt-dlp saattaa
   yhä resolvata URLin, mutta itse HLS-luku katkeilee. Tarkista ettei tämä
   laukaise turhaan `SourceExhaustedError`-luovutusta liian herkästi.
   **⚠️ NYT NÄHTY LIVENÄ 2026-07-14 (ottelu 144203)** — ks. alla
   "Lähteen flappaus / respawn-loop-luovutus". Ongelma on päinvastainen kuin
   pelättiin: luovutus ei laukea *ollenkaan*, ei liian herkästi.
4. Jos aikaa jää: pidempi (>1h) ajo useilla respawneilla peräkkäin,
   varmistaaksesi ettei mikään vuoda/kasva ajan myötä (muistinkäyttö,
   `seenFingerprints`-koko jne).

## Avoimet kysymykset / jatkokehitys

### Poll-välin ajonaikainen säätö (esiin 2026-07-14, ottelu 144203)

Käyttäjä pyysi kesken live-ajon vaihtamaan API-pollausvälin 6 s → 3 s
lennossa. **Ei onnistu nykyarkkitehtuurilla ilman uudelleenkäynnistystä:**

- `pollInterval` luetaan kertaalleen käynnistyksessä
  (`RELAY_POLL_INTERVAL`-env / `--poll-interval`-flag, oletus 6000 ms,
  `config.ts`). Poll-silmukka lukee `this.config.pollInterval` joka kierroksella
  (`commentaryLoop.ts` ~156), mutta arvo on kiinteä config-objektissa.
- Ajonaikainen control-tiedosto (`.control-<ID>.json`,
  `refreshRuntimeControls`) kantaa **vain** `announceBatterChanges`-boolean.
  Poll-väliä se ei lue.
- Src-koodin muokkauskaan ei auta jo *käynnissä* olevaa prosessia ilman
  restartia (uusi koodi ei lataudu ajossa olevaan Node-prosessiin).

Vaihtoehdot jatkoa varten — **mietittävä ennen seuraavaa ottelua**:

1. **Laajenna control-tiedosto kattamaan myös `pollInterval`** (kuten
   `announceBatterChanges` nyt): lisää kenttä `refreshRuntimeControls`:iin,
   validoi järkevä alaraja (esim. ≥2000 ms ettei API:a hakata). Tämä antaisi
   aidon lennossa-säädön ilman katkoa. Suositeltu ratkaisu jos tarve toistuu.
2. **Hyväksy restart:** `RELAY_POLL_INTERVAL=3000` `.env.relay`:iin +
   `systemctl --user restart`. Katkaisee selostetun lähetyksen ~2–5 s
   (ffmpeg respawnaa); YouTube-lähetys selviää auto-stopin armonajassa.

Punnittavaa ennen kuin lasketaan väliä: hyöty on **pieni** (6→3 s pudottaa
tapahtuma→selostus-viiveestä ≤3 s, kun kokonaisviive on arkkitehtuurisesti
~30–90 s), ja live-events-endpoint palauttaa **aina koko historian** joka
pollilla (ks. muisti "live-events full history"), joten 3 s tuplaa
API-kuorman ja rate-limit-riskin. Päätös 2026-07-14: **jätettiin 6 s:iin**,
ratkaisutapa mietitään myöhemmin.

### Lähteen flappaus / respawn-loop ei laukaise luovutusta (VAHVISTETTU 2026-07-14, ottelu 144203)

**Oire livenä:** kesken ottelun ffmpeg alkoi päättyä **code=0, ajoaika
~33–34 s kellontarkasti**, respawnaten heti uudelleen — ja jatkoi tätä
kymmeniä minuutteja. Selostettuun lähetykseen tuli katko joka respawnissa.
Samaan aikaan pesistulokset.fi:n **tapahtumadata jatkui täysin normaalisti**
(palot, juoksut, tilanne päivittyi) — video ja data ovat eri kanavat.

**Juurisyy (varmistettu koodista):** `FfmpegMixer.start()` kutsuu
`spawnOnce()` ja **nollaa `failingSince = null` aina kun `spawnOnce` palaa
ilman poikkeusta** (`ffmpegMixer.ts:114`). `SourceExhaustedError`
(5 min luovutusikkuna) laukeaa **vain** jos `spawnOnce` *heittää*, mikä
tapahtuu ainoastaan kun:
  - yt-dlp ei resolvaa URLia, TAI
  - ffmpeg kuolee ennen FIFO-kättelyä (`raceResult === "died"`, ~rivi 168).

Kun lähde kuolee/jäätyy mutta YouTube tarjoaa yhä DVR-hännän, yt-dlp
resolvaa URLin, ffmpeg käynnistyy, lukee kiinteän DVR-ikkunan (~33 s),
osuu sen loppuun ja poistuu **code=0** → `spawnOnce` palaa normaalisti →
`failingSince` nollautuu → **respawn ikuisesti, luovutus ei laukea koskaan.**
Kellontarkka ~33 s cadence = sama DVR-ikkuna luetaan yhä uudelleen (video
käytännössä jäätynyt/loopaa), ei uutta segmenttiä.

**Miksei korjaus ole triviaali "lisää auto-kill":** samassa sessiossa lähde
myös **flappasi ja palautui** — se ei aina tarkoita pysyvää kuolemaa. Liian
aggressiivinen automaattitappo katkaisisi lähetyksen turhaan tilapäisen
katkon takia. Korjauksen pitää erottaa *flappaa-mutta-palautuu* tilanteesta
*kuollut/jäätynyt pysyvästi*.

**Korjausideoita (mietittävä ennen seuraavaa ottelua):**
1. **Erillinen "stalled source" -luovutusehto:** laske peräkkäiset lyhyet
   (<~60 s) code=0-exitit; jos niitä tulee N kpl / kestää yli M min ilman
   yhtään tervettä pitkää ajoa → luovuta (tai ainakin ilmoita operaattorille
   näkyvästi). Erillään resolve-failure-ikkunasta, joka ei tätä kata.
2. **Älä nollaa `failingSince` pelkästä `spawnOnce`-paluusta** vaan vasta
   *terveestä* ajosta (esim. `ranMs > 60000`, sama kynnys jolla backoff jo
   nollataan rivillä 196). Lyhyt code=0-loop kerryttäisi silloin
   luovutusikkunaa normaalisti.
3. **Operaattorin päätös vs. automaatti:** koska data jatkuu vaikka video
   jäätyy, "pitääkö lähetyksen kuolla" on osin toimituksellinen valinta.
   Harkitse selkeää **hälytystä** (näkyvä loki / push) automaattitapon sijaan
   tai lisäksi, ja jätä lopullinen kill operaattorille.

**Operaattorin väliaikaisohje** (kunnes korjattu): jos näet tämän kuvion
(kellontarkat ~33 s code=0-respawnit) ja varmistat lähteestä että video ei
enää etene, relay **ei sammu itsestään** — pysäytä käsin
(`systemctl --user stop pesisselostaja-relay.service`). Varo silti että
lähde voi flapata takaisin (näin kävi 144203:ssa) — tarkista kohdekuva
Studiosta ennen lopullista tappoa.

### ⚠️ VAKAVIN LÖYDÖS: selostus katosi kohteesta KOKONAAN flappauksen aikana (144203)

**Operaattorin havainto (luotettava, katsoi kohdelähetystä):** ottelun
**viimeiseen ~15 min flappausjaksoon ei tullut yhtään selostusta kohteen
videoon** — täysi hiljaisuus, ei edes osittaisia klippejä. Kaksi täyttä
service-restarttia **eivät auttaneet ääneen lainkaan** (auttoivat backoffiin
= respawn-gäppiin, mutta ei kuuluvaan selostukseen). Video pyöri koko ajan
katsojille (7 katsojaa), vain selostus puuttui.

**Tämä on ISOMPI ongelma kuin ajon aikana pääteltiin.** Silloin arvioitiin
että syy on backoff-gäpit + `amix=duration=first` katkaisee klipin lähteen
EOF:ssä → *pätkivä/osittainen* ääni. **Se selitys on riittämätön:** se
ennustaa osittaista ääntä, ei totaalista hiljaisuutta terveiden 33 s
ikkunoiden aikanakaan. Restartin jälkeen gäpit olivat ~1–4 s ja ffmpeg
pushasi 33 s kerrallaan — silti nolla selostusta. Vika on siis narraation
**toimituksessa ulostuloon respawnien yli**, ei pelkkä ajoitus.

**Hypoteeseja (EI vahvistettu — vaatii oman diagnoosin, ks. alla):**
- **a)** FIFO-narraatioinput ei kytkeydy `amix`:iin oikein ensimmäisen
  respawnin jälkeen → ffmpeg mixaa vain lähteen audiota, input 1 jää
  käytännössä hiljaiseksi. (`spawnOnce` avaa FIFO:n `Promise.race`:ssa
  lähteen avaamisen kanssa — epäillään kättely-/järjestysongelmaa kun input 0
  on flaky.)
- **b)** Narraatiojono soitetaan reaaliajassa (`narrationFifo.ts` tick 20 ms),
  ja koko putken ~30–90 s latenssi vs. 33 s ikkunat tarkoittaa, että kun
  klippi vihdoin on jonon kärjessä ja ffmpeg sattuu olemaan pystyssä, sessio
  onkin jo katkennut EOF:iin ennen kuin klipin kuuluva osa ehtii soida —
  systemaattisesti, joka syklissä.
- **c)** `amix=inputs=2:duration=first:normalize=0` pudottaa lyhyillä
  sessioilla narraatioinputin kokonaan (esim. input 1:n bufferointi ei ehdi
  tuottaa dataa ennen input 0:n EOF:ää).

**Seuraava askel (tärkein koko relayssa juuri nyt):** rakenna **flappaavan
lähteen integraatiotesti** — HLS/tiedostolähde joka EOF:ää ~33 s välein
toistuvasti — ja `--record-file`-ajolla **varmista päätyykö narraatioaudio
oikeasti ulostuloon**. Tämä skenaario (HANDOFF-testilista kohta 3) ei ollut
koskaan testattu, ja 144203 osoitti että se on rikki tavalla jota ei
staattisesti pystytty varmuudella paikantamaan. Ilman toistettavaa testiä
juurisyytä (a/b/c) ei kannata arvailla koodiin.

**Muistiinpano restart-mitigaatiosta:** ajon aikana pääteltiin että
service-restart nollaa backoffin ja palauttaa selostuksen. Backoffin se
nollasi (respawn-gäppi 30 s → ~1 s), **mutta kuuluvaa selostusta se ei
palauttanut** (operaattori vahvisti jälkikäteen). Älä siis luota restarttiin
selostuksen korjaajana — se on korkeintaan videon jatkuvuuden kannalta
neutraali, ja katsojariskin (lähetys voi pudota) takia sitä ei kannata
toistaa selostuksen toivossa.

### TODO 2026-07-14: flappaavan lähteen integraatiotesti rakennettu ja ajettu — a/b/c EI reprodusoitunut

Rakennettu `apps/broadcast/src/flapTest.ts` (`npm run broadcast:flap-test`): synteettinen
33 s -lähdefixture (värikartta + 220 Hz-siniääni), joka EOF:ää joka kerta
oikeasti kuten 144203:n jäätynyt DVR-ikkuna — ei yt-dlp:tä eikä verkkoa,
ks. `FfmpegMixer.resolveTestSource` (`apps/broadcast/docs/adr/0001-ffmpeg-mixer-test-source-seam.md`).
Selostusklippi on 2 s / 1000 Hz-siniääni joka 8. sekunti, riippumatta
sessiorajoista. `recordFile` indeksoidaan nyt sessioittain
(`indexedRecordPath`, `foo.mp4` → `foo.session0.mp4`, …) — muuten jokainen
respawn olisi `-y`-ylikirjoittanut edellisen session nauhoituksen; tämä oli
oma, aiemmin huomaamaton bugi minkä tahansa monirespawn-`--record-file`-ajon
kannalta, ei vain testin.

**Ajo 2026-07-14** (sessiot 33 s, 33 s, 90 s, 33 s, 33 s, respawn-välit
1.1/2.1/1.1/2.1 s — 90 s-sessio nollasi backoffin `ranMs>60000`-ehdolla,
joten kasvava-katto-kuvio [1→2→4→8→…→30 s] ei näy tässä ajossa koska se
vaatisi KAIKKIEN sessioiden olevan <60 s peräkkäin):

**Kaikki 29 selostusklippiä havaittiin kaikissa 5 sessiossa**, tasaisella
n. -22.3 dB:n tasolla (kynnysarvo -35 dB) — myös jokaisen respawnin jälkeen
ja 90 s-sessiossa. **Tämä EI tue mitään hypoteeseista (a)/(b)/(c)**
FfmpegMixerin/FIFOn/amixin tasolla paikallisella nauhoituksella. Raportti:
`apps/broadcast/run/flap-test-report.json` (gitignoroitu, `apps/broadcast/run/`).

**Tulkinta:** vika ei todennäköisesti ole paikallisessa
mix-/FIFO-/amix-putkessa näillä ehdoilla. Todennäköisimmät seuraavat
epäilyt, tärkeysjärjestyksessä:
1. **RTMP/YouTube-ingest-pää** — tätä testiä ei koskaan pushattu oikealle
   YouTubelle asti, vain paikalliseen tiedostoon. DESIGN.md:n testaamaton
   riski ("YouTuben ingest voi olla nirso keyframe-välistä `-c:v copy`:n
   kanssa") on nyt todennäköisin epäilty — respawnien toistuva
   video-discontinuiteetti voisi saada YouTuben ingestin pudottamaan/
   desynkkaamaan äänen omalla puolellaan tavalla jota paikallinen
   nauhoitus ei koskaan näe.
2. **Kertymäefekti pidemmällä ajolla** — 144203:ssa flappaus kesti ~15 min
   (kymmeniä respawneja); tämä testi ajoi vain 5 sykliä. Jokin
   muistivuoto/tilan kertymä (FIFO-jono, file descriptorit) voisi vaatia
   useampia toistoja manifestoituakseen.
3. **CommentaryLoop/PiperTts-ketju** — testi kutsuu
   `mixer.enqueueNarration()` suoraan valmiiksi syntetisoidulla PCM:llä,
   ei mene oikean pollaus-/synteesiketjun kautta. Jos vika on siellä
   (esim. piper-prosessi jää roikkumaan tai `sink`-kutsu epäonnistuu
   hiljaa juuri respawnin aikana), tämä testi ei sitä löydä.

**Seuraava askel:** ennen kuin epäillään enää FfmpegMixeria/FIFOa/amixia,
kokeile samaa flappaavaa lähdettä oikealla RTMP-pushilla paikalliseen
RTMP-vastaanottajaan (tai oikeaan YouTube-lähetykseen) sen sijaan että
nauhoitetaan paikalliseen tiedostoon — jos selostus katoaa vasta siellä,
epäily 1 vahvistuu. Toissijaisesti: aja `flapTest.ts` 15-20 syklillä
kertymäefektin poissulkemiseksi.

### Sivuhavainto: auto-stopin viive (144203)

Kun relay pysäytettiin ottelun päätyttyä, **kohdelähetys jäi Studiossa vielä
pitkäksi aikaa "live"-tilaan** ja päättyi lopulta siististi itsestään
(auto-stop). Eli auto-stop toimii, mutta **viiveellä** — älä hätäänny jos
kohde näyttää jatkuvan minuutteja pushin loputtua. Jos haluat päättää heti,
tee se käsin Studiosta.

### Lopputulos 144203

Ottelu selostettiin loppuun asti (loppulukemat kuuluivat lokissa klo 12:04:
"Ottelu päättyi! Ysit Kylmä voitti 3–1"). Datapuoli (pesistulokset API →
selostustekstit) toimi **moitteettomasti koko ajan** — palot, juoksut,
vuoroparit, tilannekuva päivittyivät oikein myös flappauksen aikana. Kaikki
illan ongelmat olivat **lähde-/mediaputkessa** (video-EOF + narraation
toimitus), eivät domain-/selostuslogiikassa.

## Miten ajetaan — nopea muistilista

- **Esitesti ilman RTMP:tä ensin**:
  `npm run broadcast:dev -- --match-id <ID> --youtube-url <alkuperäisen lähetyksen URL> --dry-run`
  (vain lokitus) tai `--record-file apps/broadcast/run/<nimi>.mp4` (oikea synteesi +
  miksaus paikalliseen tiedostoon).
- **Oikea RTMP-testi**: ks. [README.md](README.md) "Per-match workflow".
- **Levytila**: `df -h /` ennen ja aikana pitkiä ajoja — globaali sääntö on
  pysäyttää kaikki kirjoittavat operaatiot jos vapaata alle 2 Gt.
- **Roikkuvat prosessit**: `ps aux | grep -E "ffmpeg|apps/broadcast/src/index"` ennen
  uuden testin käynnistystä — varmista aina että edellinen ajo on oikeasti
  kuollut (`TaskStop`/`kill` + `ps`-tarkistus, ei pelkkä oletus).
- **Bugien toisto ilman livepeliä**: palolaskuri-regressio on nyt
  `test/speech.test.ts`:ssä (`isEventFullyProcessed`-kuvaus), aja
  `npx vitest run test/speech.test.ts`. Ottelun 143280 raakadata on
  saatavilla ajon aikana kirjoitetuista lokeista/`.state-143280.json`:sta,
  mutta itse API palauttaa ottelun päätyttyä vain lopullisen, siivotun
  historian — live-häiriötä ei voi enää uudelleentoistaa suoraan API:sta.

## Tausta

- Täysi arkkitehtuuri, päätökset ja koko riskilista: [DESIGN.md](DESIGN.md)
- Käyttöohje (asennus, per-match-workflow, vianetsintä): [README.md](README.md)
- Edellisen live-testin PR: #20 (mergetty mainiin, kuvaus sisältää
  ensimmäisessä testissä löydetyt bugit).
- Tämän session bugikorjaukset: commit "fix: relayn palolaskurin
  nollautuminen, selostuksen katko respawnissa, ikuinen retry".

## Rajaukset / muista

- `apps/broadcast/.env.relay` on gitignoroitu eikä säily committien välissä eikä
  aiempien sessioiden välillä tällä koneella — se pitää luoda uudelleen.
- Relay-palvelu **ei ole enabloitu boottiin** — käynnistä aina käsin per
  ottelu, sammuta ottelun jälkeen (`systemctl --user stop
  pesisselostaja-relay.service`) ja päätä molemmat YouTube-lähetykset.
- Alkuperäistä käyttäjän striimiä ei saa koskea missään vaiheessa — relay
  vain lukee sitä, ei koskaan kirjoita siihen.
