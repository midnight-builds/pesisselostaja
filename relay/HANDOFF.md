# Relay — handoff seuraavaa live-testiä varten

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
- **RELAY_URL_REFRESH_MS**: asetettiin `.env.relay`:iin live-testissä mutta
  ei tehnyt mitään (ks. yllä) — nyt korjattu, muista asettaa se uudelleen
  jos halutaan poiketa 15 min oletuksesta (`.env.relay` ei säily istuntojen
  välillä, ks. Rajaukset).
- **Viiveodotukset**: respawn (yt-dlp-resoluutio + ffmpeg-kylmäkäynnistys +
  FIFO-kättely) kestää useita sekunteja — tämä on odotettua, ei bugi
  sinänsä. Erota se korjatusta selostuskatko-bugista (yllä, kohta 2): lyhyt
  äänetön tauko respawnissa on normaalia, mutta sanan kesken katkeaminen ei
  ollut.

## Mitä pitää testata seuraavaksi (tärkeysjärjestyksessä)

1. **Vahvista korjaukset oikealla live-lähetyksellä.** Erityisesti: onko
   respawn nyt siisti kuunneltuna (ei enää sanan kesken -katkoja), ja jos
   alkuperäinen striimi joskus päättyy kesken testin, sammuuko relay
   siististi 5 min sisään sen sijaan että jäisi silmukoimaan.
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
