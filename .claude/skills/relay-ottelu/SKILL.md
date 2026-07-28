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

Toimi järjestyksessä. Älä oleta arvoja — kysy puuttuvat. Tulosta ajonaikaiset
ohjeet käyttäjälle suoraan (kohta "AJON AIKANA"), älä vain viittaa niihin.

- **Lokin luku, varoitusmerkit, itsesammutus ja vianetsintä:**
  `.claude/skills/relay-ottelu/seuranta-ja-vianetsinta.md` — lue se, kun relay on
  ajossa tai kun jokin näyttää väärältä.
- Tekninen tausta: `apps/broadcast/README.md`, `apps/broadcast/HANDOFF.md`,
  `apps/broadcast/DESIGN.md`.

**Lukuja ei toisteta tässä ohjeessa.** Oletusarvot elävät koodissa
(`apps/broadcast/src/config.ts`, `ffmpegMixer.ts`, `commentaryLoop.ts`) ja
näkyvät käynnistyslokissa; tarkista arvo sieltä äläkä muistista.

---

## 1. Kerää tarvittavat tiedot (kysy jos puuttuu)

Lue nykyinen `apps/broadcast/.env.relay` (jos on). **`.env.relay` ei säily
sessioiden välissä** ja vanhat arvot ovat tyypillisesti edellisen ottelun jämiä —
älä käytä niitä varmistamatta. Tarvitaan tälle ottelulle:

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
   Sen saa myös **ajastaa** myöhemmäksi — relay osaa odottaa (kohta 5).
2. YouTube Studiossa **uusi, toinen** live-lähetys selostetulle striimille.
3. **Laita "Auto-start" ja "Auto-stop" päälle jo lähetystä LUODESSA.**
   Tämä on pakko tehdä luontivaiheessa: `contentDetails.enableAutoStart` **ei
   ole kytkettävissä päälle enää jälkikäteen**. Auto-startilla lähetys menee
   liveen itsestään kun relayn ffmpeg alkaa työntää — ei manuaalista "Go live"
   -klikkiä.
   - **Oire jos Auto-start unohtuu:** selostettu lähetys jää tilaan *"Waiting
     for stream"* vaikka relay pushaa dataa täysin oikein. **Korjaus:** paina
     Studiossa **"Go live" käsin**.
4. Kopioi lähetyksen **stream key** (ja RTMP-ingest-URL jos ei oletus).

---

## 3. Kirjoita `apps/broadcast/.env.relay`

Kirjoita tiedosto kerätyillä arvoilla. Malli:

```
RELAY_MATCH_ID=<ottelu-id>
RELAY_YOUTUBE_URL=<alkuperäisen liven URL>
RELAY_RTMP_URL=rtmp://a.rtmp.youtube.com/live2
RELAY_STREAM_KEY=<stream key>

# Operaattorin valinta: harvempi pakotettu respawn kuin koodin oletus
# (ks. config.ts). Jos lähde-URL sattuu vanhenemaan tätä ennen, ffmpeg kuolee ja
# valvoja hakee uuden osoitteen joka tapauksessa.
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

## 4. Esitarkistus: `npm run broadcast:preflight`

**Tämä on ainoa esitarkistus — älä tee käsin `df`/`ps`/`systemctl`-kierrosta.**

```bash
npm run broadcast:preflight                       # lukee apps/broadcast/.env.relay
npm run broadcast:preflight -- /polku/toinen.env  # muu env-tiedosto
```

Skripti lukee `.env.relay`:n **samalla tavalla kuin systemd**, eli tarkistaa sen
mitä palvelu oikeasti ajaisi (ympäristössä jo olevat muuttujat voittavat
tiedoston). Se **päättyy itsestään** eikä sitä tarvitse tappaa käsin. Tarkistukset
(`apps/broadcast/src/preflight.ts`): levytila, roikkuvat ffmpeg/relay-prosessit,
relay-palvelun tila, `yt-dlp`, `ffmpeg`, ottelu-ID + tapahtumahaku, lähteen tila
yt-dlp:llä, kohde (RTMP + stream key) ja ElevenLabs-kiintiö.

Tulkinta:

- `✓` kunnossa · `⚠` lue mutta ei este · `✗` **este, exit-koodi 1**.
- Yhteenvetorivi kertoo saman sanoin: *"Kaikki kunnossa — relay voidaan
  käynnistää."* / *"Ei esteitä, N huomautusta…"* / *"N estettä — älä käynnistä
  ennen kuin nämä on korjattu."*
- `Lähde … ei vielä livenä, ajastettu alkavaksi (~N min) — relay odottaa` on
  `✓`, ei ongelma (ks. kohta 5).
- `Tapahtumat … 0 tapahtumaa — ottelua ei ole vielä avattu` on normaali ennen
  ottelun alkua.
- Levytila-`✗` = globaali pysäytyssääntö: **älä käynnistä**, ilmoita käyttäjälle.
- Roikkuvat prosessit / `Relay-palvelu … active` = `⚠`: selvitä ennen
  käynnistystä, ettet katkaise menossa olevaa lähetystä tai jätä kahta ffmpegiä
  pyörimään.

Preflightin voi ajaa myös **ennen** `.env.relay`:n kirjoittamista: kone- ja
työkalutarkistukset tulevat silti, ja ottelu/lähde/kohde näyttävät `✗` kunnes
arvot ovat paikallaan. Yksittäisen ottelun voi tarkistaa myös suoraan:
`RELAY_MATCH_ID=1234 npm run broadcast:preflight`.

Syvempään testiin on yhä `--dry-run` (`apps/broadcast/README.md`), mutta **se ei
pääty itsestään** — se pitää tappaa käsin, joten käytä sitä vain jos preflight ei
riitä.

---

## 5. Käynnistä ja varmista

**Relayn voi käynnistää heti kun preflight on puhdas — myös kauan ennen ottelun
alkua.** Erillistä ajastusrituaalia ei tarvita: jos yt-dlp vastaa "this live
event will begin in N minutes", relay tulkitsee sen odotukseksi eikä virheeksi,
nukkuu ja tarkistaa tilanteen uudelleen vähän ennen ilmoitettua alkua
(`SourceNotLiveYetError`, `ytdlpSource.ts` — odotushaara ja
`scheduledRecheckDelayMs` `ffmpegMixer.ts`:ssä). Odotus
ei kuluta luovutusikkunaa. Jos lähde ei koskaan ala, odotus katkeaa
`SCHEDULED_WAIT_MAX_MS`:n jälkeen (`ffmpegMixer.ts`).

```bash
systemctl --user start pesisselostaja-relay.service
journalctl --user -u pesisselostaja-relay -f
```

Lokista pitäisi näkyä: konfiguraatio, "Pelaajanvaihtojen selostus: PÄÄLLÄ/POIS
(vaihda ajon aikana: …)" **← poimi tästä control-tiedoston polku talteen**,
ottelun nimet, "Selostussilmukka käynnissä… (polli N ms, delta-haku …)" ja joko
"Käynnistetään ffmpeg…" tai "Lähde ei ole vielä livenä… Tarkistetaan uudelleen…".

- Auto-startilla toinen lähetys menee liveen itsestään pian sen jälkeen kun
  ffmpeg alkaa työntää (YouTuben oma viive, ei mitattavissa meidän koodistamme).
  Jos Auto-startia ei laitettu, käyttäjä klikkaa "Go live" Studiossa nyt.
- **Tulosta käyttäjälle valmis Studio-linkki** kohteen tilan tarkistamiseen /
  Go live -painamiseen (korvaa `<VIDEO_ID>` kohteen videoId:llä, älä kääri
  URLia `**`-merkkeihin):

  https://studio.youtube.com/video/<VIDEO_ID>/livestreaming
- Vahvista: `systemctl --user is-active pesisselostaja-relay.service` → `active`.
- Ensimmäistä selostusta odotetaan hetki ffmpegin ensikytkeytymisestä, jotta
  katsojat ehtivät paikalle (`RELAY_FIRST_SPEECH_DELAY_MS`, `config.ts`).
- Kokonaisviive tapahtumasta selostukseen on ~30–90 s (arkkitehtuurinen, ei bugi
  — `apps/broadcast/README.md`, "Expected latency"). Respawnien lyhyt äänetön
  tauko on normaalia.

---

## AJON AIKANA — tulosta nämä käyttäjälle suoraan

Kaikki säädöt menevät samaan control-tiedostoon
`apps/broadcast/run/.control-<ID>.json` (tarkka polku käynnistyslokissa). Relay
lukee sen **joka pollissa**, joten muutos astuu voimaan seuraavan pollin aikana
ilman uudelleenkäynnistystä. Tiedostoon voi kirjoittaa useita avaimia yhtä aikaa;
jos kirjoitat vain osan avaimista, muut asetukset säilyvät ennallaan.

```bash
# yksi avain kerrallaan:
echo '{"announceBatterChanges": false}' > apps/broadcast/run/.control-<ID>.json
# tai useita yhdellä kertaa:
echo '{"announceBatterChanges": false, "narrationDelayMs": 5000, "deltaFetch": true, "pollIntervalMs": 3000}' \
  > apps/broadcast/run/.control-<ID>.json
```

(Voit pyytää minua tekemään tämän puolestasi kesken ajon — hoidan sen yhdellä
komennolla.)

| Avain | Mitä tekee |
|-------|------------|
| `announceBatterChanges` | Pelaajanvaihtojen ("Vuorossa X") selostus päälle/pois. Jos ne tulevat väärässä kohtaa, ota pois — palot, pisteet, jaksotapahtumat ja periodinen tilannekuva jatkuvat normaalisti. |
| `narrationDelayMs` | Keinotekoinen viive selostuksen kohdistamiseksi kuvaan. Jos kuulet selostuksen **ennen** kuin tilanne näkyy videolla, kasvata. Oikea arvo **varmistetaan kuulemalla** — videopipelinen viive vaihtelee lähetyksittäin. `0` = ei viivettä. |
| `deltaFetch` | `false` palauttaa täyshaut, jos delta käyttäytyy oudosti (selostuksia puuttuu, toistuvia "Delta-epäkonsistenssi → täyshaku" -rivejä). `true` myös nollaa automaattisen delta-katkaisijan. |
| `pollIntervalMs` | Pollausväli. Arvo rajataan koodin alarajaan (`MIN_POLL_INTERVAL_MS`, `commentaryLoop.ts`). |

Käynnistysaikaiset vastineet (oletukset `apps/broadcast/src/config.ts`):
`RELAY_ANNOUNCE_BATTER_CHANGES`, `RELAY_NARRATION_DELAY_MS`, `RELAY_DELTA_FETCH`,
`RELAY_POLL_INTERVAL`, `RELAY_FIRST_SPEECH_DELAY_MS`.

**Seuranta.** `journalctl --user -u pesisselostaja-relay -f`. Lokirivien
tulkinta, varoitusmerkit ja vianetsintä:
`.claude/skills/relay-ottelu/seuranta-ja-vianetsinta.md`.

**Levytila.** Pitkän ajon aikana pidä silmällä `df -h /`. Alle 2 Gt → pysäytä
kaikki kirjoittavat operaatiot heti (globaali sääntö).

---

## LOPETUS

> **⚠ Älä luota itsesammutukseen sokeasti — tarkista aina itse, että ajo on
> todella loppunut.** Relay osaa nyt luovuttaa myös silloin kun ffmpeg
> käynnistyy onnistuneesti mutta kuolee heti `code=0` (issue #45 korjattu:
> vain riittävän pitkä ajo kelpaa todisteeksi etenemisestä, ks.
> `ffmpegMixer.ts`). Ennen korjausta relay respawnasi ikuisesti ja operaattori
> joutui pysäyttämään palvelun käsin (havaittu livenä 27.7.). Korjausta ei ole
> vielä koeteltu oikeassa lähetyksessä, joten pysäytä käsin jos ajo jää pystyyn.

Ottelun ollessa kesken älä pysäytä: kuollut lähde voi palata, ja striimin uptime
on ykkösprioriteetti. Vasta kun ottelu on oikeasti ohi:

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
