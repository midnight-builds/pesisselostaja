# Relay: lokin luku ja vianetsintä

Lue tämä kun relay on jo ajossa ja jokin näyttää väärältä. Käynnistys ja
ajonaikaiset säätimet ovat `SKILL.md`:ssä.

**Tämä on diagnoosia, ei ottelupäivän polkua.** Normaalisti operaattori ei
lue journaldia lainkaan: ohjaamon tilakortti kertoo tilan, ja loki on
huoltoarkin takana ohjaamon ainoana teknisenä tasona (#176, #188). Jos joudut
tänne, jokin ei näkynyt kortissa — se on kirjaamisen arvoinen havainto.

```bash
journalctl --user -u pesisselostaja-relay -f
```

Kaikki alla olevat lokirivit tulevat `apps/broadcast/src/`:stä
(`ffmpegMixer.ts`, `commentaryLoop.ts`, `ytdlpSource.ts`, `index.ts`).

---

## Normaali loki

- `Lähde ei ole vielä livenä — alkaa noin N min kuluttua. Tarkistetaan uudelleen
  N s kuluttua.` = lähde on ajastettu myöhemmäksi, relay odottaa sen alkua.
  **Tämä ei ole virhe** eikä kuluta luovutusikkunaa (`SourceNotLiveYetError`
  määritellään `ytdlpSource.ts`:ssä, odotushaara on `ffmpegMixer.ts`:ssä).
- `Sydänääni: relay käynnissä Ns, selostusjonossa N klippiä, pollit N (delta N,
  täyshaku N, 304 N, hakuvirheitä N).` = elää. Rivi tulee säännöllisin välein
  (`HEARTBEAT_MS`, `ffmpegMixer.ts`), joten hiljainen jakso ≠ jumi. Pollitilastot
  (304:t, täyshakufallbackit) näkyvät **vain** tässä rivissä
  (`pollStatsSummary`, `commentaryLoop.ts`).
- `Palo: <joukkue> <N>`, `Pisteet (<jakso>): …`, `Selostus: …` = normaali
  toiminta.
- `Selostus (vaimennettu — ffmpeg ei vielä kytkeytynyt): …` = ffmpeg ei ole
  vielä kiinni FIFO:ssa, joten selostusta ei syntetisoida (muuten klipit
  soisivat vanhentuneina ryppäänä heti kytkeytymisen jälkeen). Normaalia ennen
  ensimmäistä kytkeytymistä.
- `Määräaikainen URL-päivitys — käynnistetään ffmpeg uudelleen. Selostusjono
  tyhjeni; …` = siisti respawn. Muoto `EI tyhjentynyt (N klippiä jäljellä, 10s
  katkaisu)` tarkoittaa, että jono ei ehtinyt tyhjentyä ennen respawnia — klippi
  saattoi katketa kesken sanan; kirjaa ylös.
- `ffmpeg päättyi (code=…, signal=…), ajoaika Ns` + `Uudelleenyritys …` =
  yksittäisenä normaali respawn (URL-rotaatio, RTMP-katko). Ks. varoitusmerkit,
  jos näitä tulee peräkkäin lyhyillä ajoajoilla.

---

## Varoitusmerkit

- `Hakuvirhe (kesto … s, N. peräkkäinen)` = yksittäisenä normaalia kohinaa
  (API-timeout-piikki, seuraava polli paikkaa). Hälyttävä vasta kun rivi vaihtuu
  muotoon `HUOM, hakuvirhesarja` — kynnys on `FETCH_FAILURE_ALARM_STREAK`
  (`commentaryLoop.ts`). Sarjan päättyessä lokiin tulee `Haku onnistui jälleen —
  …`.
- `HUOM: delta-haku vastasi reset-lipulla … kertaa peräkkäin …` ja sen jälkeen
  sydänäänessä `delta POIS (katkaisija)` = delta-haku kytkeytyi automaattisesti
  pois, koska palvelin vastasi joka kertaa reset-lipulla; täyshaut jatkuvat.
  Voi pakottaa takaisin control-tiedostosta (`{"deltaFetch": true}`), mikä myös
  nollaa katkaisijan.
- `HUOM: yt-dlp ei palauttanut HLS-manifestia …` = kuva menee todennäköisesti
  heikkolaatuisena (progressiivinen varamuoto). Tarkista että `yt-dlp` on ajan
  tasalla ja että sen JS-runtime toimii (`ytdlpSource.ts`).
- **Toistuva** `ffmpeg päättyi (code=0, …)` lyhyillä ajoajoilla + `Käynnistetään
  ffmpeg…` ilman että mitään kuuluu = lähde on käytännössä kuollut, mutta relay
  **ei sammu itse** — ks. alla.

---

## Itsesammutus: mitä oikeasti tapahtuu

Relay sammuttaa itsensä vain, kun `FfmpegMixer` heittää `SourceExhaustedError`:n
(`index.ts` → `Alkuperäinen lähde ei palautunut — sammutetaan koko relay.`).
Se tapahtuu näissä tilanteissa (`ffmpegMixer.ts`, `config.ts`):

- **Yritykset ovat olleet tuottamattomia yhtäjaksoisesti liian kauan.** Yritys on
  tuottamaton jos se joko ei käynnistynyt lainkaan **tai** sessio kuoli alle
  `minProductiveRunMs`:n (`ffmpegMixer.ts`) — exit-koodi ei ratkaise mitään.
  Ikkuna on `RELAY_MAX_FAILURE_WINDOW_MS` (oletus `config.ts`:ssä) — tai ottelun
  jo päätyttyä (`Ottelu päättyi` nähty) selvästi lyhyempi
  `RELAY_FINISHED_FAILURE_WINDOW_MS`.
- **Ajastettu lähde ei koskaan ala.** Yläraja `SCHEDULED_WAIT_MAX_MS`
  (`ffmpegMixer.ts`).

> **⚠ Tarkista itsesammutus silti aina itse.** Issue #45 on korjattu: ennen
> korjausta luovutuslaskuri nollautui heti kun ffmpeg käynnistyi, joten kuollut
> lähde jonka yt-dlp yhä resolvasi (ffmpeg käynnistyy, kuolee sekunneissa
> `code=0`) sai relayn respawnaamaan ikuisesti ja operaattorin pysäyttämään
> palvelun käsin (havaittu livenä 27.7.2026). Nyt sarja lyhyitä ajoja kerryttää
> ikkunaa normaalisti. Korjausta ei ole vielä koeteltu oikeassa lähetyksessä —
> tunnusmerkit lokissa ovat samat: lyhenevät ajoajat, `code=0`, ei selostusta
> ulos. Jos ajo jää siitä huolimatta pystyyn, pysäytä käsin.

---

## Vianetsintä (pikaviitteet)

- **ffmpeg kaatuu heti FIFO-inputtiin** → pipe ei ehtinyt syntyä; itsekorjautuu
  seuraavassa respawn-syklissä.
- **Lyheneviä ajoja + `code=0`, ei selostusta ulos** → relay kertoo nyt itse
  kumman pään ffmpeg näki rikkinäisenä. Etsi lokista rivi joka alkaa
  "ffmpegin virheet tulivat" — KOHTEEN puolelta = tarkista stream key ja ettei
  toinen enkooderi työnnä samalla avaimella; LÄHTEEN puolelta = tarkista
  puhelin. Jos rivi sanoo ettei kumpaakaan puolta voi päätellä, se on rehellinen
  vastaus eikä arvausta kannata tehdä lokin perusteella.
- **yt-dlp ei palauta URLia / 403** → alkuperäinen lähetys päättyi, on
  yksityinen, tai YouTube rate-limitoi; tarkista `yt-dlp --version` ja päivitä.
- **`source.throttled: YouTube torjuu lähdehaun (bottitarkistus/429)`** (#249) →
  YouTube kieltäytyy vastaamasta **meille**; raakalähetys voi olla täysin
  kunnossa, joten **älä soita kuvaajalle** tämän perusteella. Relay perääntyy jo
  itse (60 s → 5 min, myös katvetilassa) ja tarttuu lähteeseen kun esto
  hellittää. **Restart ei auta** — se vain pakottaa uuden haun. Jos esto ei
  hellitä, vaihda player-client `.env.relay`:ssä:
  `RELAY_YTDLP_EXTRACTOR_ARGS=youtube:player_client=web` (oletus `android`, joka
  oli 16.8.2026 se joka meni läpi). Muutos vaatii relayn uudelleen-
  käynnistyksen — ja `npm run relay:deploy`in, jos muutat koodin oletusta eikä
  `.env.relay`:tä. Huomaa että **tyhjä arvo ei palauta yt-dlp:n omaa oletusta**:
  palvelimen `~/.config/yt-dlp/config` sisältää yhä saman android-rivin, ja se
  jää voimaan (se tiedosto on palvelimen tilaa, ei repon).

  **Missä tämä näkyy:** lokissa ja telemetriassa, sekä ohjaamon
  valmiustarkistuksen Lähde-rivillä. Ottelupäivän tilakortti näyttää tästä
  huolimatta vain `Kuvaa ei saada` — se ei näytä relayn `source.detail`ia
  lainkaan. Eli jos kortti sanoo "kuvaa ei saada" eikä kuvaaja raportoi mitään
  vikaa, **katso loki** ennen kuin päättelet kumpi pää on rikki.
- **Ei selostusta mutta ffmpeg terve** → tarkista `RELAY_NARRATION_GAIN` ≠ 0 ja
  että `commentaryLoop` näkee uusia tapahtumia (vertaa pääsovelluksen lokiin).
  Huomaa myös ensipuheen armonaika `RELAY_FIRST_SPEECH_DELAY_MS`: ennen sen
  umpeutumista hiljaisuus on odotettua.
- **RTMP-pushi katkeaa toistuvasti** → ffmpegillä ei ole automaattista
  reconnectia push-puolelle; jokainen katko = respawn backoffilla. Jatkuva =
  verkko-ongelma.
- **Selostettu lähetys jää "Waiting for stream" -tilaan** vaikka relay pushaa
  ilman virheitä → Auto-start unohtui lähetystä luodessa. Paina Studiossa
  **Go live** käsin.

Täydet tekniset taustat: `apps/broadcast/README.md`,
`apps/broadcast/DESIGN.md`.
