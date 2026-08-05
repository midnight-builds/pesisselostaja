---
name: relay-ottelu
description: >
  Backup and diagnostics for a Pesisselostaja broadcast. The primary way to run
  a match day is the ohjaamo (control app) UI on the operator's phone — this
  skill is NOT that path. Use it only when the ohjaamo cannot do the job: it is
  unreachable or broken, its Google authorization has expired, the relay needs
  deploying or starting by hand, a running broadcast needs troubleshooting from
  the logs, or the whole chain must be run manually in YouTube Studio. Also use
  when the user asks to schedule / start / stop / operate a broadcast
  ("ajasta peli", "aloita lähetys", "lopeta lähetys", "laita selostus pois") —
  in that case point them at the ohjaamo first and only fall back here.
---

# Varapolku ottelupäivään

**Ohjaamon käyttöliittymä ajaa ottelupäivän. Tämä ohje ei aja sitä.** Kartta
#168 vei ketjun käyttöliittymään asti: operaattori tekee koko päivän puhelimen
ruudulta yhtenä tilakorttina, ilman agenttia ja ilman terminaalia. Jos ajat
ottelun tämän ohjeen kautta, olet ohittanut sen mitä varten ohjaamo tehtiin.

Tämä tiedosto on siis kaksi asiaa, ei kolmatta:

1. **Osoitin ohjaamoon** — mitä operaattori tekee ja missä järjestyksessä, jotta
   osaat neuvoa oikein kysymättä.
2. **Varapolut** — mitä tehdään kun ohjaamo ei riitä.

## Kun käyttäjä pyytää lähetyksen ajamista

Anna ohjaamon osoite ja kerro mitä hän tekee siellä. **Älä aja ketjua
agenttina** — älä luo lähetyksiä, kirjoita `.env.relay`:tä tai käynnistä relayta
hänen puolestaan — ellei jokin varapolun ehdoista täyty tai hän nimenomaan
pyydä sitä sen jälkeen kun olet kertonut että ohjaamo osaa sen itse.

> Sama sääntö toiseen suuntaan: **käyttäjän eksplisiittinen pyyntö voittaa tämän
> dokumentin.** Jos hän pyynnön kuultuaan sanoo "tee se silti käsin", tee — mutta
> sano ristiriita ääneen ensin, älä korvaa pyyntöä hiljaa "vastaavalla"
> toteutuksella. Juuri niin meni 30.7.2026, ja lähetysten luonti valui takaisin
> ulkopuoliseen palveluun.

**Osoite:** ohjaamo on portissa **3002**, ja käytettävä osoite on tailnetin
HTTPS-osoite — `tailscale serve status` kertoo sen. Älä anna `IP:3002`: HTTPS on
iOS-asennuksen ja push-ilmoitusten ehto. **Portti 3001 on eri projekti**, joka
vastaa harhaanjohtavilla 404:llä.

**Termit ovat repon juuren `CONTEXT.md`:ssä** — raakalähetys, selostettu
lähetys, tulospalvelun ottelusivu, ajastushetki, käynnistysikkuna. Käytä niitä.
Älä kirjoita "lähde-URL" ilman määrettä: se on kaatanut kaksi dokumenttia.

---

# Mitä ohjaamo tekee (operaattorin polku)

Etusivu on **yksi tilakortti**, jonka otsikko ja ainoa päänappi seuraavat työn
tilaa. Navigaatiota ei ole. Sanamuodot tulevat yhdestä lähteestä
(`apps/control/src/shared/jobState.ts`), ja push-ilmoitus on saman siirtymän
projektio — pushin otsikko on sama teksti kuin kortissa.

| Tila | Mitä operaattori näkee ja tekee |
|---|---|
| *Ei aktiivista ottelua* | Etusivu on ottelun valinta. **Valinta ON työn luonti** — erillistä "Luo työ" -nappia ei ole. Ottelu-ID tai tulospalvelun ottelusivun osoite käy myös. |
| *Valmistelu kesken* | Esikatselu otsikoista on pysyvästi näkyvissä. **"Luo lähetyspari"** on ainoa vahvistusta vaativa teko koko päivässä — kaksoisnapautus, koska se on peruuttamaton ja ulospäin näkyvä. Ohjaamo luo molemmat lähetykset, kirjoittaa stream keyn työhön ja muodostaa kolmen linkin jakoviestin. Valmiustarkistus ajetaan itsestään ja **korjaa sidonnan itse** rivinä *"Korjattiin: …"*. |
| *Lähetyspari valmiina* | Kortti on **käynnistysvahti**, ei käynnistysnappi: se vastaa yhteen kysymykseen — käynnistyykö selostus itsestään. Vahti kytkee itsensä päälle jos se on pois. Laukaisin on **raakalähetyksen meneminen liveksi, ei kello**. |
| *Odottaa kuvausta / käynnissä* | Kertasilmäys 393 px:ssä ilman vieritystä: viisi tietoa, kaksi säätöä (**selostusviive ±**, pelaajanvaihtojen selostus päälle/pois) ja selostuslista. Säädöt astuvat voimaan ilman relayn uudelleenkäynnistystä. |
| *Selostettu lähetys päättyi* | Vastaa yhteen kysymykseen: jäikö jotain päälle. Siivous on kirjattu tieto — mitä tehtiin ja mistä lopetus pääteltiin. |
| Huolto | Hammasrattaan takana: Google-yhteys yhtenä kuittausrivinä, ilmoitusten tilaus ja kytkimet, jakoviestin pohja, loki. **Loki on ohjaamon ainoa tekninen taso.** |

Hyvänä päivänä puhelin piippaa **kolmesti**: *Lähetyspari valmiina* →
*Lähetys käynnistyi* → *Selostettu lähetys päättyi*. Muuta ei tarvitse tehdä.

**UI:ssa ei ole käsikäynnistys- eikä pysäytysnappia** — se on tarkoitus, ei
puute. Käynnistyksen tekee vahti ja lopetuksen itsesammutus. Kummankin
ohittaminen on varapolku, alla.

## Kuvaaja

Kuvauspuhelimessa on **StreamLabs**, kirjautuneena samaan YouTube-tiliin kuin
ohjaamon valtuutus. Kuvaaja **valitsee ennakkoon ajastetun raakalähetyksen
listasta** — mitään ei syötetä käsin. Siksi "lähde-URLin löytämisongelmaa" ei
ole olemassa; jos joku kuvailee sellaista, oletus on väärä.

---

# Kolme sääntöä, jotka pätevät kummallakin polulla

1. **Raakalähetykseen ei kirjoiteta ottelun ollessa kesken.** Ainoa sallittu
   kirjoitus on hard stopin siivous päättyneen ottelun jälkeen (#123), ja sekin
   vain kun ohjaamon `CONTROL_HARD_STOP_SOURCE` on päällä. Siivouksen tekee
   ohjaamo itse; sinä et transitoi lähetyksiä käsin.
2. **Uptime voittaa siisteyden.** Ottelun ollessa kesken kuollut raakalähetys voi
   palata — älä pysäytä relayta.
3. **Levytila alle 2 Gt → pysäytä kaikki kirjoittavat operaatiot heti** ja
   ilmoita käyttäjälle (globaali sääntö).

## Mitä on koeteltu ja mitä ei

Ole rehellinen käyttäjälle tästä; älä esitä koettelematonta varmana.

| Osa | Tila |
|---|---|
| Relay + selostus | Koeteltu useassa lähetyksessä |
| **Uusi käyttöliittymä kokonaisuudessaan** (#183–#188, mainissa 5.8.2026) | **EI koeteltu livenä lainkaan.** Mikään ketjun osa ei ole kulkenut tilakortin läpi oikeassa ottelussa |
| Lähetysparin luonti | Ajettu vanhalla UI:lla 30.7.–1.8.2026, toimi. #162 (stream key ei tallentunut) korjattu #184:ssä, **korjaus koettelematta**. Käsin kirjoittamisen varapolkua ei enää ole: käsikentät poistuivat (#176) |
| Ohjaamon luoma pari päästä päähän | **Koeteltu kahdesti** vanhalla UI:lla: 31.7.2026 (145918) ja 1.8.2026 (136745, 104 min) |
| **Käynnistysvahti (ajastin)** | **EI koeteltu livenä.** Molemmat aiemmat ajot käynnistettiin käsin. Uudessa UI:ssa vahti on ainoa käynnistystapa |
| **Itsesammutus** normaalilla `ended`-polulla | **Koeteltu kahdesti** (31.7. ja 1.8.2026): ffmpeg code=0 → lähde päättynyt → siisti sammutus. YouTuben AutoStop sulki molemmat lähetykset. 1.8. loppuselostuksesta työn sulkemiseen 67 s |
| **Hard stopin siivous** | **EI koeteltu livenä** (#123 korjattu koodissa) — molemmat lopetukset tulivat normaalina polkuna |

Kun jokin näistä ajetaan ensi kertaa, **kirjaa mikä takkuaa** — se on kartan
#168 jäljellä oleva sisältö.

## Missä mikäkin ajaa

- **Relay ei aja tästä työpuusta** vaan pinnatusta ajokopiosta `~/relay-deploy`.
  Työpuun muutokset — myös juuri mergatut — eivät ole lähetyksessä mukana ennen
  `npm run relay:deploy`ta. Haaranvaihto täällä ei siis koskaan katkaise ajossa
  olevaa lähetystä.
- Lokin luku, varoitusmerkit ja vianetsintä:
  `.claude/skills/relay-ottelu/seuranta-ja-vianetsinta.md`.
- Tekninen tausta: `apps/broadcast/README.md`, `apps/control/README.md`.

**Lukuja ei toisteta tässä ohjeessa.** Oletusarvot elävät koodissa
(`apps/broadcast/src/config.ts`, `ffmpegMixer.ts`, `commentaryLoop.ts`,
ohjaamon `scheduler.ts`) ja näkyvät käynnistyslokissa; tarkista arvo sieltä
äläkä muistista.

---

# Varapolut

Jokainen näistä on merkki viasta. **Kirjaa se** — ohjaamon pitäisi osata tämä
itse, ja se mitä se ei osaa on seuraava tiketti.

## V1. Deploy ennen käynnistystä

Tämä ei ole varapolku vaan ylläpitoa, eikä sitä ole ohjaamossa: jos main on
muuttunut sitten viime ajon, relay ajaa yhä vanhaa koodia.

```bash
npm run relay:deploy          # oletus origin/main; -- <ref> muulle
```

Skripti kieltäytyy, jos relay on ajossa. **Kirjaa deployattu commit ylös** — se
on ainoa tapa tietää jälkikäteen mitä koodia lähetys ajoi.

## V2. Käsikäynnistys, kun vahti ei laukea

Vain kun raakalähetys on jo livenä eikä selostus ole käynnistynyt. Katso ensin
kortin käynnistysvahdin rivit: *"Käynnistysvahti seuraa ottelua X – Y, ei tätä"*
tarkoittaa että käsikäynnistys menisi väärään otteluun — korjaa sidonta, älä
ohita sitä.

```bash
curl -X POST http://127.0.0.1:3002/api/relay/start     # ohjaamon kautta, sidonta ohjaamon tiedosta
systemctl --user start pesisselostaja-relay.service    # ohjaamon ohi, lukee .env.relay
```

Ensimmäinen on turvallisempi: se ei luota `.env.relay`:n sisältöön, joka voi
osoittaa eiliseen otteluun (#155). Vahvista:
`systemctl --user is-active pesisselostaja-relay.service` → `active`.

## V3. Pysäytys, kun itsesammutus ei tullut

**Ottelun ollessa kesken älä pysäytä** (sääntö 2). Ottelun jälkeen:

```bash
systemctl --user stop pesisselostaja-relay.service
ps aux | grep -E "ffmpeg|apps/broadcast/src/index" | grep -v grep   # varmista
```

Palvelu **ei** ole enabloitu boottiin — se on aina käsikäynnistys per ottelu.

## V4. Säädöt ilman ohjaamoa

Samat kaksi säädintä kuin kortissa, suoraan control-tiedostoon, jonka relay
lukee joka pollissa. Useita avaimia voi kirjoittaa yhtä aikaa, ja pois jätetyt
säilyvät ennallaan. Tarkka polku on käynnistyslokissa:

```bash
echo '{"announceBatterChanges": false, "narrationDelayMs": 5000}' \
  > apps/broadcast/run/.control-<ID>.json
```

Ohjaamosta relayyn on **täsmälleen kaksi sallittua kosketuspintaa** —
`.env.relay` ja tämä control-tiedosto. Uutta HTTP-kanavaa ei rakenneta (#59).

Selostusviive kohdistaa selostuksen kuvaan, ja **selostus voi osua kuvan
kummallekin puolelle**: jos se kuuluu *ennen* kuin tilanne näkyy videolla,
kasvata; jos se laahaa, pienennä. Oikea arvo **varmistetaan kuulemalla kesken
lähetyksen** — videopolun oma viive vaihtelee lähetyksittäin, joten älä säädä
ennakkoon minkään kirjatun luvun perusteella.

**Odotettavaa, ei vikaa:** respawnien lyhyt äänetön tauko, ja hetki ffmpegin
ensikytkeytymisestä ennen ensimmäistä selostusta.

**Seuranta:** `journalctl --user -u pesisselostaja-relay -f`, ja
`seuranta-ja-vianetsinta.md` lokirivien tulkintaan.

---

# V5. Koko ketju käsin YouTube Studiossa

**Vain kun ohjaamo tai sen YouTube-valtuutus ei toimi.** Tässä polussa
operaattori luo lähetykset itse ja arvot kirjoitetaan käsin
`apps/broadcast/.env.relay`:hin.

## V5.1 Kerää arvot

| Arvo | Mistä | Env-avain |
|------|-------|-----------|
| **Ottelu-ID** | tulospalvelun ottelusivu | `RELAY_MATCH_ID` |
| **Raakalähetyksen URL** | raakalähetyksen katselu-URL | `RELAY_YOUTUBE_URL` |
| **Stream key** | **selostetun** lähetyksen ingest-avain, Studiosta | `RELAY_STREAM_KEY` |
| RTMP-URL | oletus `rtmp://a.rtmp.youtube.com/live2` käy lähes aina | `RELAY_RTMP_URL` |

> **⚠️ Älä sekoita näitä.** Jos käyttäjä antaa vain **yhden** YouTube-linkin,
> **älä oleta että se on raakalähetys** — kysy kummasta on kyse. Vihje: *stream
> key*, *"näkyvyys: unlisted"* ja *"thumbnail kopioitu"* kuvaavat **selostettua
> lähetystä**, eivät raakalähetystä.

## V5.2 Luo selostettu lähetys Studiossa

1. Puhelimen oma live käyntiin normaalisti (= raakalähetys). Sen saa myös
   **ajastaa** myöhemmäksi — relay osaa odottaa.
2. Studiossa **uusi, toinen** live-lähetys selostetulle striimille.
3. **Laita "Auto-start" ja "Auto-stop" päälle jo lähetystä LUODESSA.**
   `contentDetails.enableAutoStart` **ei ole kytkettävissä päälle jälkikäteen**.
   - **Oire jos Auto-start unohtuu:** selostettu lähetys jää tilaan *"Waiting
     for stream"* vaikka relay pushaa oikein. **Korjaus:** paina Studiossa
     **"Go live" käsin**.
4. Kopioi **stream key** (ja RTMP-ingest-URL jos ei oletus).

## V5.3 Kirjoita `.env.relay`

```
RELAY_MATCH_ID=<ottelu-id>
RELAY_YOUTUBE_URL=<raakalähetyksen URL>
RELAY_RTMP_URL=rtmp://a.rtmp.youtube.com/live2
RELAY_STREAM_KEY=<selostetun stream key>

# Operaattorin valinta: harvempi pakotettu respawn kuin koodin oletus.
RELAY_URL_REFRESH_MS=14400000

# Aloitetaanko pelaajanvaihtojen selostus pois? Poista rivi jos päällä.
# RELAY_ANNOUNCE_BATTER_CHANGES=false

# EI ottelukohtainen — säilytä sama arvo ottelusta toiseen.
ELEVENLABS_API_KEY=<säilytä entinen arvo>
```

**`ELEVENLABS_API_KEY` ja `RELAY_URL_REFRESH_MS` eivät ole ottelukohtaisia** —
kopioi ne vanhasta tiedostosta sellaisenaan, älä kysy käyttäjältä uutta.
`.env.relay` on gitignoressa (stream key + API-avain) — älä committaa sitä.
Vanhat arvot tiedostossa ovat tyypillisesti edellisen ottelun jämiä; älä käytä
niitä varmistamatta.

Anna käyttäjälle heti valmis Studio-linkki selostettuun lähetykseen (älä kääri
URLia `**`-merkkeihin):

https://studio.youtube.com/video/<VIDEO_ID>/livestreaming

## V5.4 Preflight ja käynnistys ilman ohjaamoa

```bash
npm run broadcast:preflight                       # lukee apps/broadcast/.env.relay
npm run broadcast:preflight -- /polku/toinen.env  # muu env-tiedosto
RELAY_MATCH_ID=1234 npm run broadcast:preflight   # pelkkä ottelutarkistus
```

Skripti lukee `.env.relay`:n **samalla tavalla kuin systemd** ja päättyy
itsestään. Rivien tulkinta: `✓` kunnossa · `⚠` lue mutta ei este · `✗` este.

- `Lähde … ei vielä livenä, ajastettu alkavaksi (~N min) — relay odottaa` on
  `✓`, ei ongelma.
- `Tapahtumat … 0 tapahtumaa — ottelua ei ole vielä avattu` on normaali ennen
  ottelun alkua.
- Levytila-`✗` = globaali pysäytyssääntö.
- **Sidontarivi on se, joka pysäyttää käynnistyksen** ennen kuin selostus menee
  väärään otteluun (#155). Ilman sitä kaikki muut rivit voivat kuvata eilistä
  ottelua ja näyttää silti vihreiltä — niin kävi 31.7.2026.

```bash
npm run relay:deploy
systemctl --user start pesisselostaja-relay.service
journalctl --user -u pesisselostaja-relay -f
```

Lokista pitäisi näkyä: konfiguraatio, "Pelaajanvaihtojen selostus:
PÄÄLLÄ/POIS (vaihda ajon aikana: …)" **← poimi tästä control-tiedoston polku
talteen**, ottelun nimet, "Selostussilmukka käynnissä…" ja joko "Käynnistetään
ffmpeg…" tai "Lähde ei ole vielä livenä… Tarkistetaan uudelleen…".

Syvempään testiin on `--dry-run` (`apps/broadcast/README.md`), mutta **se ei
pääty itsestään** — käytä vain jos preflight ei riitä.

## V5.5 Siivous käsipolun jälkeen

**Siivoa päättyneen ottelun arvot pois `.env.relay`:stä**, jotta jämät eivät
päädy seuraavaan lähetykseen: tyhjennä `RELAY_MATCH_ID`, `RELAY_YOUTUBE_URL`,
`RELAY_STREAM_KEY` ja kohteen videoId-kommentit, mutta **jätä
`ELEVENLABS_API_KEY` ja `RELAY_URL_REFRESH_MS` paikalleen**.

Ohjaamon polulla ohjaamo kirjoittaa nämä itse, eikä käsin siivousta tarvita.
