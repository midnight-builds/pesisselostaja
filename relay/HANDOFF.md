# Relay — handoff seuraavaa live-testiä varten

## TODO 2026-07-14: live-testin (ottelu 144197) löydökset — korjaa seuraavassa sessiossa

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
`relay/src/ffmpegMixer.ts` `buildFfmpegArgs`:iin `"-http_persistent", "0"`
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
   `relay/src/commentaryLoop.ts` nollasivat `currentBatTeamId`/`currentOuts`
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
4. Jos aikaa jää: pidempi (>1h) ajo useilla respawneilla peräkkäin,
   varmistaaksesi ettei mikään vuoda/kasva ajan myötä (muistinkäyttö,
   `seenFingerprints`-koko jne).

## Miten ajetaan — nopea muistilista

- **Esitesti ilman RTMP:tä ensin**:
  `npm run relay:dev -- --match-id <ID> --youtube-url <alkuperäisen lähetyksen URL> --dry-run`
  (vain lokitus) tai `--record-file relay/run/<nimi>.mp4` (oikea synteesi +
  miksaus paikalliseen tiedostoon).
- **Oikea RTMP-testi**: ks. [README.md](README.md) "Per-match workflow".
- **Levytila**: `df -h /` ennen ja aikana pitkiä ajoja — globaali sääntö on
  pysäyttää kaikki kirjoittavat operaatiot jos vapaata alle 2 Gt.
- **Roikkuvat prosessit**: `ps aux | grep -E "ffmpeg|relay/src/index"` ennen
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

- `relay/.env.relay` on gitignoroitu eikä säily committien välissä eikä
  aiempien sessioiden välillä tällä koneella — se pitää luoda uudelleen.
- Relay-palvelu **ei ole enabloitu boottiin** — käynnistä aina käsin per
  ottelu, sammuta ottelun jälkeen (`systemctl --user stop
  pesisselostaja-relay.service`) ja päätä molemmat YouTube-lähetykset.
- Alkuperäistä käyttäjän striimiä ei saa koskea missään vaiheessa — relay
  vain lukee sitä, ei koskaan kirjoita siihen.
