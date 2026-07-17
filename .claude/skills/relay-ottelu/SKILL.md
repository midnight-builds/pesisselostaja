---
name: relay-ottelu
description: >
  Operator runbook for running a Pesisselostaja relay broadcast end to end:
  start a commentated YouTube stream for a live pesäpallo match, control it
  during the match (turn narration / batter-change announcements on/off), and
  shut it down cleanly. Use when the user wants to start / stop / operate the
  relay for a match, "aloita lähetys", "lopeta lähetys", "laita selostus pois",
  or invokes /relay-ottelu.
---

# Relay-ottelun ajaminen

Tämä skill ajaa relayn koko elinkaaren: **aloitus → ajonaikainen ohjaus →
lopetus**. Relay lukee puhelimen jo julkaiseman YouTube-livelähetyksen takaisin,
miksaa siihen selostuksen ja julkaisee tuloksen **toisena, erillisenä**
YouTube-lähetyksenä. Alkuperäistä lähetystä ei kosketa koskaan.

Toimi järjestyksessä. Älä oleta arvoja — kysy puuttuvat. Tulosta
ajonaikaiset ohjeet käyttäjälle suoraan (kohta "AJON AIKANA"), älä vain viittaa
niihin.

Tausta ja vianetsintä: `apps/broadcast/README.md`, `apps/broadcast/HANDOFF.md`, `apps/broadcast/DESIGN.md`.

---

## 0. Esitarkistukset (aina ensin)

```bash
df -h /                                          # levytila
ps aux | grep -E "ffmpeg|apps/broadcast/src/index" | grep -v grep || echo "(ei roikkuvia ajoja)"
systemctl --user is-active pesisselostaja-relay.service || true   # "inactive" on odotettu tila
```

Huom: `is-active` palauttaa exit-koodin 3 kun palvelu ei ole käynnissä, ja
`grep` palauttaa 1 kun osumia ei ole — molemmat ovat tässä *hyviä* uutisia.
Siksi `|| true` / `|| echo` yllä: ilman niitä komentoketju näyttää
epäonnistuneelta ("Failed to run") vaikka kaikki on kunnossa.

- **Levytila:** jos vapaata alle 2 Gt (tai alle 10 % laitteesta), **älä
  käynnistä** — ilmoita käyttäjälle ja pysähdy (globaali sääntö). Tämä kone on
  30 Gt / rajallinen.
- **Roikkuvat prosessit:** jos edellinen ffmpeg/relay on yhä pystyssä, se pitää
  tappaa ennen uutta ajoa (`kill` + varmista `ps`:llä). Älä oleta että edellinen
  ajo kuoli.
- Jos palvelu on jo `active`, kysy käyttäjältä ennen kuin teet mitään
  (uudelleenkäynnistys katkaisee menossa olevan lähetyksen).

---

## 1. Kerää tarvittavat tiedot (kysy jos puuttuu)

Lue nykyinen `apps/broadcast/.env.relay` (jos on). **`.env.relay` ei säily sessioiden
välillä** ja vanhat arvot ovat tyypillisesti edellisen ottelun jämiä — älä
käytä niitä varmistamatta. Tarvitaan tälle ottelulle:

| Arvo | Mistä | Env-avain |
|------|-------|-----------|
| **Ottelu-ID** | pesistulokset.fi:n ottelun ID (sama jota pääsovellus katsoo) | `RELAY_MATCH_ID` |
| **Alkuperäisen lähetyksen URL** | puhelimen oman YouTube-liven katselu-URL | `RELAY_YOUTUBE_URL` |
| **Stream key** | toisen (selostetun) lähetyksen ingest-avain, YouTube Studiosta | `RELAY_STREAM_KEY` |
| RTMP-URL | oletus `rtmp://a.rtmp.youtube.com/live2` käy lähes aina | `RELAY_RTMP_URL` |

Jos ottelu-ID, alkuperäinen URL tai stream key puuttuu tai näyttää vanhalta,
**kysy ne käyttäjältä yhdellä viestillä**. Stream key saadaan vasta kun toinen
lähetys on luotu (kohta 2), joten ohjaa käyttäjä tekemään se ensin.

> **⚠️ LÄHDE vs. KOHDE — älä sekoita näitä.**
> - **LÄHDE** = `RELAY_YOUTUBE_URL` = puhelimen alkuperäinen live, jota
>   **LUETAAN**. Vain katselu, ei koskaan kirjoiteta.
> - **KOHDE** = videoId + stream key = se toinen, selostettu lähetys, johon
>   **PUSHATAAN**.
>
> Jos käyttäjä antaa vain **yhden** YouTube-linkin, **älä oleta että se on
> lähde** — kysy kummasta on kyse. Vihje: kentät kuten *stream key*,
> *"näkyvyys: unlisted"* ja *"thumbnail kopioitu"* kuvaavat **KOHDETTA**, eivät
> lähdettä. (Taustaa: aiemmassa testissä kohde meni vahingossa
> `RELAY_YOUTUBE_URL`:iin ja oikea lähde jouduttiin pyytämään erikseen.)

Kysy myös (AskUserQuestion sopii tähän): **aloitetaanko pelaajanvaihtojen
selostus päällä vai pois?** Oletus päällä. (Voi vaihtaa lennossa myös kesken —
ks. AJON AIKANA.)

---

## 2. Luo toinen YouTube-lähetys (käyttäjän tehtävä)

Ohjeista käyttäjää:

1. Puhelimen oma YouTube-live käyntiin normaalisti (= alkuperäinen lähetys).
2. YouTube Studiossa **uusi, toinen** live-lähetys selostetulle striimille.
3. **Laita "Auto-start" ja "Auto-stop" päälle jo lähetystä LUODESSA.**
   Tämä on pakko tehdä luontivaiheessa: `contentDetails.enableAutoStart` **ei
   ole kytkettävissä päälle enää jälkikäteen**. Auto-startilla lähetys menee
   liveen itsestään kun relayn ffmpeg alkaa työntää — ei manuaalista "Go live"
   -klikkiä.
   - **Oire jos Auto-start unohtuu:** selostettu lähetys jää tilaan *"Waiting
     for stream"* vaikka relay pushaa dataa täysin oikein (lokissa ffmpeg
     ESTAB, ei respawneja). Data on jo ingestissä — se vain odottaa Go live
     -komentoa. **Korjaus:** paina Studiossa **"Go live" käsin**, niin lähetys
     lähtee heti liveen (ks. myös kohta 5).
4. Kopioi lähetyksen **stream key** (ja RTMP-ingest-URL jos ei oletus).

---

## 3. Kirjoita `apps/broadcast/.env.relay`

Kirjoita tiedosto kerätyillä arvoilla. Malli:

```
RELAY_MATCH_ID=<ottelu-id>
RELAY_YOUTUBE_URL=<alkuperäisen liven URL>
RELAY_RTMP_URL=rtmp://a.rtmp.youtube.com/live2
RELAY_STREAM_KEY=<stream key>

# 4 h respawn-väli: URL kelpaa ~6 h, joten ei turhaa URL-rotaatiota / katkoa.
RELAY_URL_REFRESH_MS=14400000

# Aloitetaanko pelaajanvaihtojen selostus pois? Poista rivi jos päällä.
# RELAY_ANNOUNCE_BATTER_CHANGES=false

# EI ottelukohtainen — säilytä sama arvo ottelusta toiseen (ks. huomio alla).
ELEVENLABS_API_KEY=<säilytä entinen arvo>
```

**`ELEVENLABS_API_KEY` ei ole ottelukohtainen — älä koske siihen turhaan.**
Kun kirjoitat tiedoston uudelle ottelulle, kopioi avain vanhasta tiedostosta
sellaisenaan (älä poista, älä kysy käyttäjältä uutta). Vain ottelukohtaiset
arvot (`RELAY_MATCH_ID`, `RELAY_YOUTUBE_URL`, `RELAY_STREAM_KEY`) vaihtuvat.

`.env.relay` on gitignoressa (sisältää stream keyn ja API-avaimen) — älä
committaa sitä.

**Anna käyttäjälle heti valmis Studio-linkki** meidän selostettuun
lähetykseen (KOHTEEN videoId), jotta hän pääsee yhdellä klikillä
tarkistamaan lähetyksen tilan / asetukset (älä kääri URLia `**`-merkkeihin):

https://studio.youtube.com/video/<VIDEO_ID>/livestreaming

---

## 4. Esitesti ilman RTMP:tä (suositus, jos aikaa)

Varmistaa että ottelu-ID ja API vastaavat ennen kuin mennään liveen:

```bash
npm run broadcast:dev -- --match-id <ID> --youtube-url "<URL>" --dry-run
```

Lokittaa mitä selostettaisiin, ei käynnistä ffmpegiä eikä koske RTMP:ään.
Katkaise (Ctrl-C / prosessin tappo) kun näet oikean ottelun tapahtumia.

---

## 5. Käynnistä ja varmista

**Ajoitus: käynnistä ~6 min ennen alkuperäisen lähetyksen ilmoitettua
alkuaikaa.** Jos puhelimen lähetys ei ole vielä livenä kun relay yrittää lukea
sitä, relay yrittää yt-dlp:llä yhä tiheämmin ja **luovuttaa (sammuu
kokonaan) jos lähde ei vastaa `RELAY_MAX_FAILURE_WINDOW_MS` (oletus 12 min)
kuluessa** — ks. `ffmpegMixer.ts`. 6 min etuajassa käynnistäminen jättää
12 min ikkunasta ~6 min marginaalia molempiin suuntiin: lähde voi olla vähän
etuajassa tai valahtaa vähän ilmoitettua myöhemmäksi ilman että relay luovuttaa
turhaan. Jos yt-dlp ilmoittaa esim. "This live event will begin in 26
minutes", **älä käynnistä palvelua vielä** — odota kunnes ilmoitettuun
alkuun on ~6 min, tai käytä `ScheduleWakeup`-tyyppistä ajastusta tarkistamaan
tilanne lähempänä.

```bash
systemctl --user start pesisselostaja-relay.service
journalctl --user -u pesisselostaja-relay -f
```

Lokista pitäisi näkyä: konfiguraatio, "Pelaajanvaihtojen selostus: PÄÄLLÄ/POIS
(vaihda ajon aikana: …)" **← poimi tästä control-tiedoston polku talteen**,
ottelun nimet, "Käynnistetään ffmpeg…", ja ffmpegin pushi ilman virheitä.

- Auto-startilla toinen lähetys menee liveen itsestään ~5–10 s siitä kun ffmpeg
  työntää. (Jos Auto-startia ei laitettu, käyttäjä klikkaa "Go live" Studiossa
  nyt.)
- **Tulosta käyttäjälle valmis Studio-linkki** kohteen tilan tarkistamiseen /
  Go live -painamiseen (korvaa `<VIDEO_ID>` kohteen videoId:llä, älä kääri
  URLia `**`-merkkeihin):

  https://studio.youtube.com/video/<VIDEO_ID>/livestreaming
- Vahvista: `systemctl --user is-active pesisselostaja-relay.service` → `active`.
- Kokonaisviive tapahtumasta selostukseen on ~30–90 s (arkkitehtuurinen, ei
  bugi). Respawnien lyhyt äänetön tauko on normaalia.

---

## AJON AIKANA — tulosta nämä käyttäjälle suoraan

**Selostus (pelaajanvaihdot) päälle/pois ilman uudelleenkäynnistystä.**
Jos pelaajanvaihdot ("Vuorossa X") tulevat väärässä kohtaa, ota ne pois — palot,
pisteet, jaksotapahtumat ja periodinen tilannekuva (tilanne + palot) jatkuvat.
Relay lukee control-tiedostoa joka pollissa (~6 s), muutos astuu voimaan heti:

```bash
# pois:
echo '{"announceBatterChanges": false}' > apps/broadcast/run/.control-<ID>.json
# takaisin päälle:
echo '{"announceBatterChanges": true}'  > apps/broadcast/run/.control-<ID>.json
```

(Käytä käynnistyslokin näyttämää tarkkaa polkua. Voit pyytää minua tekemään
tämän puolestasi kesken ajon — hoidan sen yhdellä komennolla.)

**Selostusviive (jos selostus tulee ennen kuvaa) lennossa.** Jos kuulet
selostuksen ENNEN kuin tilanne näkyy videolla, lisää keinotekoista
viivettä selostuksen ja kuvan kohdistamiseksi. Oletus on 2000 ms (kalibroitu
livenä ottelussa 144742); tarkka arvo kannattaa yhä varmistaa kuulemalla
(video-pipelinen viive vaihtelee lähetyksittäin). Voi asettaa jo käynnistyksessä
(`RELAY_NARRATION_DELAY_MS`) tai vaihtaa kesken ajon samaan control-tiedostoon —
viive koskee vain toistoa (kuvaan kohdistusta), ei muuta selostuslogiikkaa:

```bash
# lisää 4 s selostusviive:
echo '{"narrationDelayMs": 4000}' > apps/broadcast/run/.control-<ID>.json
# pois (takaisin ilman viivettä):
echo '{"narrationDelayMs": 0}'    > apps/broadcast/run/.control-<ID>.json
```

**Delta-haku ja pollausväli lennossa.** Relay hakee tapahtumat oletuksena
delta-moodissa (`after=` + ETag, polli 3 s) — käynnistyslokissa "delta-haku
PÄÄLLÄ" ja ajossa "Delta-haku: N uutta…" -rivejä. Jos delta käyttäytyy oudosti
(selostuksia puuttuu, toistuvia "Delta-epäkonsistenssi → täyshaku" -rivejä),
kytke se pois lennossa — täyshakukäytös palaa seuraavassa pollissa ilman
restarttia:

```bash
# delta pois (paluu täyshakuihin):
echo '{"deltaFetch": false}' > apps/broadcast/run/.control-<ID>.json
# pollausväli lennossa (min 2000 ms):
echo '{"pollIntervalMs": 5000}' > apps/broadcast/run/.control-<ID>.json
```

Env-vastineet käynnistykseen: `RELAY_DELTA_FETCH=false`, `RELAY_POLL_INTERVAL`
(oletus 3000). Muut uudet env-säädöt: `RELAY_FIRST_SPEECH_DELAY_MS` (oletus
20000 — ensimmäinen puhe vasta ~20 s ffmpegin ensikytkeytymisestä, jotta
katsojat ehtivät paikalle; 0 = pois) ja `RELAY_FINISHED_FAILURE_WINDOW_MS`
(oletus 120000 — päättyneen ottelun jälkeen kuollutta lähdettä yritetään vain
~2 min ennen itsesammutusta).

Control-tiedostoon voi kirjoittaa useita avaimia yhtä aikaa
(`{"announceBatterChanges": false, "narrationDelayMs": 4000, "deltaFetch": true, "pollIntervalMs": 3000}`);
jos kirjoitat vain osan avaimista, muut asetukset säilyvät ennallaan.

**Seuranta.** `journalctl --user -u pesisselostaja-relay -f`:
- "Sydänääni: relay käynnissä … " ~2 min välein = elää (hiljainen jakso ≠ jumi).
  Rivin lopussa pollitilastot: "pollit N (delta …, täyshaku …, 304 …,
  hakuvirheitä …)" — 304:t ja täyshakufallbackit näkyvät vain tässä.
- "Palo: … ", "Pisteet: … ", "Selostus: … " = normaali toiminta.
- "Hakuvirhe (kesto … s, N. peräkkäinen)" = yksittäisenä normaalia kohinaa
  (API-timeout-piikki, seuraava polli paikkaa). Hälyttävä vasta kun rivi
  vaihtuu muotoon "HUOM, hakuvirhesarja" (≥3 peräkkäistä); sarjan päättyessä
  lokiin tulee "Haku onnistui jälleen — …".
- "Määräaikainen URL-päivitys … Selostusjono tyhjeni" = siisti respawn.
  "EI tyhjentynyt" = jono ei ehtinyt tyhjentyä (10 s katkaisu) — kirjaa ylös.
- "Alkuperäinen lähde ei palautunut — sammutetaan koko relay" = lähde loppui
  pysyvästi, relay sammuu itse (5 min yrittämisen jälkeen).

**Levytila.** Pitkän ajon aikana pidä silmällä `df -h /`. Alle 2 Gt → pysäytä
kaikki kirjoittavat operaatiot heti (globaali sääntö).

---

## LOPETUS

```bash
systemctl --user stop pesisselostaja-relay.service
ps aux | grep -E "ffmpeg|apps/broadcast/src/index" | grep -v grep   # varmista että kuoli
```

- Auto-stopilla toinen lähetys päättyy itsestään kun pushi loppuu; muuten
  käyttäjä päättää **molemmat** lähetykset Studiossa käsin.
- Palvelu **ei** ole enabloitu boottiin — se on aina käsikäynnistys per ottelu.
  Ei tarvitse disabloida.
- **Siivoa päättyneen ottelun arvot pois `apps/broadcast/.env.relay`:stä**, jotta
  vanhat jämät eivät päädy vahingossa seuraavaan lähetykseen: tyhjennä
  ottelukohtaiset rivit (`RELAY_MATCH_ID`, `RELAY_YOUTUBE_URL`,
  `RELAY_STREAM_KEY` + kohteen videoId-kommentit), mutta **jätä
  `ELEVENLABS_API_KEY` ja `RELAY_URL_REFRESH_MS` paikalleen** — ne eivät ole
  ottelukohtaisia.

---

## Vianetsintä (pikaviitteet)

- ffmpeg kaatuu heti FIFO-inputtiin → pipe ei ehtinyt syntyä; itsekorjautuu
  seuraavassa respawn-syklissä.
- yt-dlp ei palauta URLia / 403 → alkuperäinen lähetys päättyi, on yksityinen,
  tai YouTube rate-limitoi; `yt-dlp --version` ajan tasalle.
- Ei selostusta mutta ffmpeg terve → tarkista `RELAY_NARRATION_GAIN` ≠ 0 ja että
  `commentaryLoop` näkee uusia tapahtumia (vertaa pääsovelluksen lokiin).
- RTMP-pushi katkeaa toistuvasti → ffmpegillä ei automaattista reconnectia
  push-puolelle; jokainen katko = respawn backoffilla. Jatkuva = verkko-ongelma.

Täydet ohjeet: `apps/broadcast/README.md`.
