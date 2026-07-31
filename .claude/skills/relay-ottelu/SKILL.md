---
name: relay-ottelu
description: >
  Operator runbook for running a Pesisselostaja broadcast end to end from the
  ohjaamo (control app): schedule the pair of YouTube broadcasts, start the
  commentated stream for a live pesäpallo match, control it during the match
  (turn narration / batter-change announcements on/off), and shut it down
  cleanly. Use when the user wants to schedule / start / stop / operate a
  broadcast, "ajasta peli", "aloita lähetys", "lopeta lähetys", "laita selostus
  pois", or invokes /relay-ottelu.
---

# Ottelupäivän ajaminen

**Ohjaamo omistaa koko ketjun** (issue #124): ottelun valinnasta lähetysten
luontiin, käynnistykseen, ajonaikaiseen ohjaukseen ja siivoukseen. Ohjaamo on
tässä oletus, ei vaihtoehto — käsityökierros YouTube Studiossa on **poikkeuspolku
(polku B)**, jota käytetään vain kun ohjaamo tai sen YouTube-valtuutus ei toimi.

**Termit ovat repon juuren `CONTEXT.md`:ssä** — raakalähetys, selostettu lähetys,
tulospalvelun ottelusivu, ajastushetki, käynnistysikkuna. Käytä niitä. Älä
kirjoita "lähde-URL" ilman määrettä: se on kaatanut kaksi dokumenttia.

## Kolme sääntöä ennen kaikkea muuta

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
| Ohjaamon ottelulista, työjono, preflight, käsikäynnistys | Koeteltu |
| Ohjaamon lähetysparin **luonti** | Ajettu 30.7.2026 (ottelu 145905, kaksikin kertaa). Toimi; puutteet kirjattu #130–#132 |
| **Ohjaamon luoma pari päästä päähän** (StreamLabs poimii raakalähetyksen → relay ajaa sen) | **Koeteltu kerran**: 31.7.2026, ottelu 145918. Toimi. Löydöt: #154, #155 |
| **Ajastimen automaattinen käynnistys** | **EI koeteltu livenä**, oletuksena pois (#124 vaihe 2) |
| **Itsesammutus** normaalilla `ended`-polulla | **Koeteltu 31.7.2026**: ffmpeg code=0 → respawn ajastettu → lähde päättynyt havaittu → siisti sammutus 3 s kuluttua. Ohjaamo sulki työn (`finished`) ja YouTuben AutoStop sulki molemmat lähetykset |
| **Hard stopin siivous** | **EI koeteltu livenä** (#123 korjattu koodissa) — 31.7. lopetus tuli normaalina polkuna, ei hard stopina |

Kun jokin näistä ajetaan ensi kertaa, **kirjaa mikä takkuaa** — se on #124:n
vaiheen 1 koko sisältö.

## Missä mikäkin ajaa

- **Ohjaamo** on portissa **3002**. Käytä tailnetin HTTPS-osoitetta
  (`tailscale serve status` kertoo sen), älä `IP:3002` — HTTPS on iOS-asennuksen
  ja push-ilmoitusten ehto. **Portti 3001 on eri projekti**, joka vastaa
  harhaanjohtavilla 404:llä.
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

# POLKU A (oletus): ohjaamo

Operaattorin ainoa pakollinen tehtävä on **valita ottelu**. Kaikki muu on
ohjaamon työtä. Kehitysaikana valinta voi kulkea agentin kautta — "ajasta peli"
tarkoittaa ajastusta **ohjaamon välinein**, samaa polkua, ei käsikierrosta.

> Jos käyttäjä pyytää ajastusta ja jokin dokumentti tai handoff näyttää ohjaavan
> käsikierrokseen, **sano ristiriita ääneen ja kysy** — älä korvaa pyyntöä
> hiljaa "vastaavalla" toteutuksella. Juuri niin meni 30.7.2026 aamulla, ja
> lähetysten luonti valui takaisin sille ulkopuoliselle palvelulle, jonka
> korvaaminen on #124:n koko tavoite.

## A1. Ajastushetki — työ ja lähetykset (esim. edellisenä iltana)

**Ottelut-välilehti.** Valitse päivä, rajaa suodattimilla, napauta ottelua (tai
useaa) → **"Luo työ"**. Jos ottelu ei ole listalla, "Ottelu-ID tai osoite"
-kortti ottaa vastaan tulospalvelun ottelusivun osoitteen tai pelkän ID:n →
**"Luo työ ID:stä"**.

**YouTube-välilehti → "Lähetysten luonti".**

1. Valitse **"Mille ottelulle"** (= äsken luotu työ).
2. Täytä joukkue-/tapahtumakentät ja **esikatsele**. Esikatselu ei luo mitään
   YouTubeen — otsikot, kuvaus, jakoviesti ja thumbnail näkyvät ennen kuin
   mitään on olemassa.
3. Tarkista tekstit ja kuvat, rastita **"Olen tarkistanut tekstit ja kuvat"**.
4. **"Luo lähetykset"** — tämä on **peruuttamaton ja ulospäin näkyvä**.

Ohjaamo luo **molemmat** lähetykset yhdellä kertaa
(`createBroadcastPair`, `apps/control/src/server/youtube.ts`):

- **raakalähetys** omalla stream keyllä StreamLabsia varten, ja
- **selostettu lähetys**, johon relay työntää.

Työlle kirjautuu samalla raakalähetyksen katselu-URL sekä selostetun videoId ja
stream key. **Operaattorin ei tarvitse kopioida mitään käsin** — jos huomaat
kopioivasi stream keytä, olet vahingossa polulla B.

Molempien katselu-URLit ovat olemassa heti (`liveBroadcasts.insert` palauttaa
video-id:n saman tien). Kolmas linkki, tulospalvelun ottelusivu, tulee ottelun
ID:stä.

## A2. Jakoviesti

Ohjaamo muodostaa jakoviestin, jossa on **kolme linkkiä**: raakalähetys,
selostettu lähetys ja tulospalvelun ottelusivu. Kortti "Jaettava viesti",
kopiointinappi vieressä.

**Raakalähetys ei ole piilotettu** — sen linkki jaetaan katsojille selostetun
rinnalla (unlisted = linkin saaneet näkevät). Älä kuvaile sitä "piilotetuksi".

## A3. Kuvaaja

Kuvauspuhelimessa on **StreamLabs**, kirjautuneena samaan YouTube-tiliin kuin
ohjaamon valtuutus. Kuvaaja **valitsee sovelluksesta ennakkoon ajastetun
raakalähetyksen listasta** — mitään ei syötetä käsin, eikä kuvaaja luo
lähetystä itse. Kuvaajan video ilmestyy siihen samaan URLiin, joka on jo
jakoviestissä.

Tästä syystä "lähde-URLin löytämisongelmaa" ei ole olemassa. Jos joku kuvailee
sellaista, oletus on väärä.

## A4. Käynnistys

Kaksi tapaa. **Käsikäynnistys on yhä ensisijainen**, kunnes ajastin on nähty
oikeassa käytössä.

**Käsin — Työ-välilehti:**

1. **"Lähde ja kohde"** — tarkista että raakalähetys ja selostettu ovat oikein
   päin. (LÄHDE = raakalähetys, jota *luetaan*. KOHDE = selostettu, johon
   *pushataan*.)
2. **"Preflight"** — aja se. Tämä on ainoa esitarkistus; älä tee käsin
   `df`/`ps`/`systemctl`-kierrosta. `✓` kunnossa · `⚠` lue mutta ei este ·
   `✗` este.
   - `Lähde … ei vielä livenä, ajastettu alkavaksi (~N min) — relay odottaa`
     on `✓`, ei ongelma.
   - `Tapahtumat … 0 tapahtumaa — ottelua ei ole vielä avattu` on normaali
     ennen ottelun alkua.
   - Levytila-`✗` = globaali pysäytyssääntö.
3. **Deployaa ennen käynnistystä**, jos main on muuttunut sitten viime ajon:
   `npm run relay:deploy` (oletus `origin/main`; `-- <ref>` muulle). Skripti
   kieltäytyy, jos relay on ajossa. **Kirjaa deployattu commit ylös** — se on
   ainoa tapa tietää jälkikäteen mitä koodia lähetys ajoi.
4. **"Käynnistä relay"**. Nappi on lukossa, jos preflightissä on esteitä tai
   relay on jo ajossa.

**Ajastimella — Työ-välilehden alaosa, "Ajastin":** ajastin vahtii
käynnistysikkunassa raakalähetystä ja käynnistää relayn heti kun kuvaaja
aloittaa. Laukaisin on **lähteen meneminen liveksi, ei kello**.

Ajastin on **oletuksena pois**, ja pois ollessaan se laskee koko päätöksen
silti näkyviin ("Olisi tehnyt: …"). Se on tarkoitus: **katso että se on
oikeassa ottelun tai parin ajan ennen kuin kytket sen päälle**
(`apps/control/src/server/scheduler.ts` kuvaa säännöt). Se ei koskaan käynnistä
mitään, jos toinen työ on auki, jos preflightissä on esteitä tai jos levytila
on kriittinen.

## A5. Ajon aikana

Ohjaamon **Live**-välilehti: tila, pisteet, selostuslista, säätimet,
ilmoitukset. Säädöt menevät samaan control-tiedostoon, jonka relay lukee joka
pollissa — muutos astuu voimaan ilman uudelleenkäynnistystä.

| Säädin | Mitä tekee |
|-------|------------|
| Pelaajanvaihtojen selostus | "Vuorossa X" päälle/pois. Jos ne tulevat väärässä kohtaa, ota pois — palot, pisteet, jaksotapahtumat ja periodinen tilannekuva jatkuvat normaalisti. |
| Selostusviive | Selostuksen kohdistus kuvaan. Jos kuulet selostuksen **ennen** kuin tilanne näkyy videolla, kasvata. Oikea arvo **varmistetaan kuulemalla**; videopipelinen viive vaihtelee lähetyksittäin. |
| Delta-haku | Pois palauttaa täyshaut, jos delta käyttäytyy oudosti (selostuksia puuttuu, toistuvia "Delta-epäkonsistenssi → täyshaku" -rivejä). Päälle myös nollaa automaattisen katkaisijan. |
| Pollausväli | Rajataan koodin alarajaan. |

Ilman ohjaamoa sama onnistuu kirjoittamalla suoraan
`apps/broadcast/run/.control-<ID>.json` (tarkka polku käynnistyslokissa);
useita avaimia voi kirjoittaa yhtä aikaa, ja pois jätetyt säilyvät ennallaan:

```bash
echo '{"announceBatterChanges": false, "narrationDelayMs": 5000}' \
  > apps/broadcast/run/.control-<ID>.json
```

**Odotettavaa, ei vikaa:** kokonaisviive tapahtumasta selostukseen ~30–90 s
(arkkitehtuurinen, `apps/broadcast/README.md`). Respawnien lyhyt äänetön tauko.
Ensimmäistä selostusta odotetaan hetki ffmpegin ensikytkeytymisestä, jotta
katsojat ehtivät paikalle.

**Seuranta:** `journalctl --user -u pesisselostaja-relay -f`, ja
`seuranta-ja-vianetsinta.md` lokirivien tulkintaan.

## A6. Lopetus ja siivous

**Ottelun ollessa kesken älä pysäytä.**

Kun ottelu on ohi, lopetuksen pitäisi tapahtua itsestään:

- Relay sammuttaa itsensä, kun raakalähetys päättyy (`ended`), tai hard stopin
  takarajalla (#123): ottelu päättynyt **ja** hiljaisuutta **ja** raakalähetys
  oireilee. Ottelu päättyneenä on ehdoton portti — hard stop ei voi laueta
  kesken ottelun.
- Ohjaamo sulkee työn laskevalla reunalla, ja tekee hard stopin siivouksen
  (selostettu lähetys ja — lipun ollessa päällä — raakalähetys) vain kun telemetria
  kertoo `endReason === "hard_stop"`. Normaalissa lopetuksessa selostetun sulkee YouTuben
  `enableAutoStop`, eikä raakalähetykseen kosketa.

> **Tarkista silti itse, että ajo todella loppui.** Mitään tästä ketjusta ei ole
> koeteltu livenä. 30.7.2026 lopetus **ei** toiminut: raakalähetys jäi liveksi
> ilman dataa, ja operaattori joutui lopettamaan sen käsin.

Jos ajo jää pystyyn:

```bash
systemctl --user stop pesisselostaja-relay.service
ps aux | grep -E "ffmpeg|apps/broadcast/src/index" | grep -v grep   # varmista
```

Palvelu **ei** ole enabloitu boottiin — se on aina käsikäynnistys per ottelu.

---

# POLKU B (poikkeus): käsityö YouTube Studiossa

**Käytä tätä vain kun ohjaamo tai sen YouTube-valtuutus ei toimi.** Jos päädyt
tänne, se on vika — kirjaa se, koska se on #124:n mittari.

Tässä polussa operaattori luo lähetykset itse ja arvot kirjoitetaan käsin
`apps/broadcast/.env.relay`:hin.

## B1. Kerää arvot

| Arvo | Mistä | Env-avain |
|------|-------|-----------|
| **Ottelu-ID** | tulospalvelun ottelusivu | `RELAY_MATCH_ID` |
| **Raakalähetyksen URL** | raakalähetyksen katselu-URL | `RELAY_YOUTUBE_URL` |
| **Stream key** | **selostetun** lähetyksen ingest-avain, Studiosta | `RELAY_STREAM_KEY` |
| RTMP-URL | oletus `rtmp://a.rtmp.youtube.com/live2` käy lähes aina | `RELAY_RTMP_URL` |

> **⚠️ Älä sekoita näitä.** Jos käyttäjä antaa vain **yhden** YouTube-linkin,
> **älä oleta että se on raakalähetys** — kysy kummasta on kyse. Vihje: *stream
> key*, *"näkyvyys: unlisted"* ja *"thumbnail kopioitu"* kuvaavat **selostettua
> lähetystä**, eivät raakalähetystä. (Aiemmassa testissä selostetun URL meni
> vahingossa `RELAY_YOUTUBE_URL`:iin.)

## B2. Luo selostettu lähetys Studiossa

1. Puhelimen oma live käyntiin normaalisti (= raakalähetys). Sen saa myös
   **ajastaa** myöhemmäksi — relay osaa odottaa.
2. Studiossa **uusi, toinen** live-lähetys selostetulle striimille.
3. **Laita "Auto-start" ja "Auto-stop" päälle jo lähetystä LUODESSA.**
   `contentDetails.enableAutoStart` **ei ole kytkettävissä päälle jälkikäteen**.
   - **Oire jos Auto-start unohtuu:** selostettu lähetys jää tilaan *"Waiting
     for stream"* vaikka relay pushaa oikein. **Korjaus:** paina Studiossa
     **"Go live" käsin**.
4. Kopioi **stream key** (ja RTMP-ingest-URL jos ei oletus).

## B3. Kirjoita `.env.relay`

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

## B4. Preflight ja käynnistys ilman ohjaamoa

```bash
npm run broadcast:preflight                       # lukee apps/broadcast/.env.relay
npm run broadcast:preflight -- /polku/toinen.env  # muu env-tiedosto
RELAY_MATCH_ID=1234 npm run broadcast:preflight   # pelkkä ottelutarkistus
```

Skripti lukee `.env.relay`:n **samalla tavalla kuin systemd** ja päättyy
itsestään. Tulkinta kuten kohdassa A4.

```bash
npm run relay:deploy
systemctl --user start pesisselostaja-relay.service
journalctl --user -u pesisselostaja-relay -f
```

Lokista pitäisi näkyä: konfiguraatio, "Pelaajanvaihtojen selostus:
PÄÄLLÄ/POIS (vaihda ajon aikana: …)" **← poimi tästä control-tiedoston polku
talteen**, ottelun nimet, "Selostussilmukka käynnissä…" ja joko "Käynnistetään
ffmpeg…" tai "Lähde ei ole vielä livenä… Tarkistetaan uudelleen…".

Vahvista: `systemctl --user is-active pesisselostaja-relay.service` → `active`.

Syvempään testiin on `--dry-run` (`apps/broadcast/README.md`), mutta **se ei
pääty itsestään** — käytä vain jos preflight ei riitä.

## B5. Siivous polun B jälkeen

**Siivoa päättyneen ottelun arvot pois `.env.relay`:stä**, jotta jämät eivät
päädy seuraavaan lähetykseen: tyhjennä `RELAY_MATCH_ID`, `RELAY_YOUTUBE_URL`,
`RELAY_STREAM_KEY` ja kohteen videoId-kommentit, mutta **jätä
`ELEVENLABS_API_KEY` ja `RELAY_URL_REFRESH_MS` paikalleen**.

Polulla A ohjaamo kirjoittaa nämä itse työn aktivoinnissa, eikä käsin siivousta
tarvita.
