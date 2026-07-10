# Relay — handoff seuraavaa live-testiä varten

Kirjoitettu 2026-07-10, PR #20 (relay-osajärjestelmä + ensimmäinen live-testi)
mergetty juuri mainiin. Tämä dokumentti on tyhjälle sessiolle: mitä on jo
testattu, ja mitä pitää testata kun seuraava video/ottelu on käytettävissä.

## Nykytila

- **M0, M2, M4 ✅** — live-testattu 2026-07-10 ottelulla 143277 (KeKi Blue–IPV)
  oikealla YouTube-livellä. Ajettu `--dry-run`- ja `--record-file`-tiloilla,
  ei koskaan RTMP:tä eikä toista YouTube-lähetystä.
- **M5 osittain** — pull+mix+paikallistallennus (`--record-file`) vahvistettu
  toimivaksi (5 min, 98 Mt, 1920×1080/30fps + aac, kesto täsmäsi ajoaikaan).
  **RTMP-julkaisu oikeaan toiseen YouTube-lähetykseen ei ole vielä koskaan
  testattu** — tämä on seuraavan testin tärkein puuttuva pala.
- **M3** — FIFO:n 20 ms -tahditus on koodillisesti + yksikkötestein katettu,
  mutta **ääntä ei ole vielä kertaakaan kuunneltu läpi ihmiskorvalla** —
  edellinen testi vain vahvisti mp4:n rakenteen (ffprobe), ei sisältöä.
- **M6** — sietokykytestaus (kaatumiset, URL-rotaatio yli 15 min,
  RTMP-katkot) tekemättä kokonaan.

Kaksi bugia löydettiin ja korjattiin edellisessä testissä (yksityiskohdat
[DESIGN.md](DESIGN.md):n "Riskit ja avoimet kysymykset" -osiossa):
1. `-reconnect`/`-reconnect_streamed`/`-reconnect_at_eof`-liput jumittivat
   HLS-luvun googlevideon kanssa kokonaan — poistettu.
2. `src/api.ts`:n `fetchLiveEvents`/`fetchMatchMetadata` roikkuivat
   rajattomasti verkkohikan aikana → selostus purskahti kiinni satunnaisen
   näköisesti — korjattu `fetchWithTimeout`-apurilla (8 s).

## Mitä pitää testata seuraavaksi (tärkeysjärjestyksessä)

1. **RTMP-julkaisu oikeaan toiseen YouTube-lähetykseen (M5 loppuun).**
   Ensimmäistä kertaa. Luo toinen lähetys käsin YouTube Studiossa, kopioi
   sen RTMP-ingest-URL + stream key. Täytä `relay/.env.relay` (kopioi
   `.env.relay.example` — tiedostoa ei ole tällä hetkellä olemassa, se pitää
   luoda joka kerta uudelleen, ks. Rajaukset alla):
   - `RELAY_MATCH_ID` — pesistulokset.fi:n ottelu-ID
   - `RELAY_YOUTUBE_URL` — **alkuperäisen** (kännykän) lähetyksen katselu-URL
   - `RELAY_RTMP_URL` / `RELAY_STREAM_KEY` — toisen lähetyksen ingest-tiedot
   Käynnistä `systemctl --user start pesisselostaja-relay.service`, seuraa
   `journalctl --user -u pesisselostaja-relay -f`. Tarkista YouTube Studiosta
   tuleeko ingest terveenä (DESIGN.md:n riski: `-c:v copy` periytyy
   striimaajan GOP/keyframe-rakenteesta — voi olla nirso).
2. **Kuuntele ääniraita oikeasti**, älä vain tarkista rakennetta. Onko
   selostus synkassa videon kanssa, kuuluuko FIFO-tahdituksessa naksahduksia
   tai desynkkaa pidemmän ajan päälle?
3. **Anna ajaa yli 15 minuuttia** (`urlRefreshMs`-oletus) ja tarkista että
   määräaikainen URL-päivitys/respawn tapahtuu siististi, ilman kuultavaa
   katkoa tai pidempää mykkää jaksoa.
4. Jos aikaa jää: sietokykytestaus (M6) — esim. tarkkaile mitä tapahtuu jos
   alkuperäinen striimi katkeaa hetkeksi, tai RTMP-push-yhteys tökkii.

## Miten ajetaan — nopea muistilista

- **Esitesti ilman RTMP:tä ensin**, kuten viime kerralla:
  `npm run relay:dev -- --match-id <ID> --youtube-url <alkuperäisen lähetyksen URL> --dry-run`
  (vain lokitus) tai `--record-file relay/run/<nimi>.mp4` (oikea synteesi +
  miksaus paikalliseen tiedostoon).
- **Oikea RTMP-testi**: ks. [README.md](README.md) "Per-match workflow".
- **Levytila**: `df -h /` ennen ja aikana pitkiä ajoja — globaali sääntö on
  pysäyttää kaikki kirjoittavat operaatiot jos vapaata alle 2 Gt.
- **Roikkuvat prosessit**: `ps aux | grep -E "ffmpeg|relay/src/index"` ennen
  uuden testin käynnistystä. Viime kerralla vanha testiajo jäi vahingossa
  taustalle ja kaksi instanssia kirjoitti samaan `.mp4`/state-tiedostoon
  samaan aikaan — varmista aina että edellinen ajo on oikeasti kuollut
  (`TaskStop`/`kill` + `ps`-tarkistus, ei pelkkä oletus).

## Havainnot 2026-07-10 live-testistä (ottelu 143280, ensimmäinen oikea RTMP-julkaisu)

M5 vietiin loppuun: relay työnsi RTMP:llä toiseen YouTube-lähetykseen ja se
näkyi katsojille. Löydökset, korjaamattomat ensin:

1. **BUGI: palojen määrä selostetaan väärin.** Käyttäjä kuuli toistuvasti
   "nolla paloa" vaikka sisävuorossa oli 1–2 paloa. Lokista kaksi erillistä
   oiretta:
   - Määräaikainen tilannekuulutus sanoo "0 paloa" vaikka samassa
     sisävuorossa on juuri kirjattu palo: esim. 12:17:17 `Palo: PomPy/OuHu 1`
     → 12:19:03 kuulutus "Sisävuorossa PomPy / OuHu, **0 paloa**". Sama myös
     12:12:22 ja 12:14:02 (12:04 palojen jälkeen).
   - Palolaskuri hyppii taaksepäin ja toistaa ykköspaloa: 12:04:08
     `Palo: PomPy/OuHu 2` → 12:04:45 taas `Palo: PomPy/OuHu 1`; IPV:n
     "ensimmäinen palo" kuulutettiin kolmesti (12:06:48, 12:07:13, 12:10:16).
   Epäilyssuunta: sisävuoron tunnistus / palojen nollaus vuoronvaihdossa
   (vrt. event.id-resetit per vuoro ja issue #18:n nopeat team-flipit) —
   sisävuoro näytti lokissa vaihtuvan IPV↔PomPy useita kertoja muutamassa
   minuutissa samalla kun laskuri nollautui. Selvitä ja korjaa ennen
   seuraavaa livetestiä; toistettavissa ottelun 143280 event-datalla.
2. **BUGI: selostus katkeaa kesken lauseen ffmpeg-respawnissa.** FIFO:on
   kirjoitettu puhe menetetään kun ffmpeg vaihdetaan (URL-rotaatio tai muu
   respawn) — käyttäjä kuuli lauseen katkeavan. Korjausidea: puskuroi
   kesken jäänyt utterance ja puhu uudelleen respawnin jälkeen, tai viivytä
   respawnia kunnes FIFO on tyhjä.
3. **Korjattu ajossa: 15 min URL-rotaatio aiheutti näkyvän ~8 s katkon joka
   kerta.** Lähde-URL:n `expire` on ~6 h, joten tiheä rotaatio oli turha.
   Lisätty `RELAY_URL_REFRESH_MS`-env-ohitus (config.ts + index.ts +
   .env.relay.example), livetestissä käytettiin 4 h. Rotaatio itsessään
   toimi molemmilla kerroilla siististi (~6–8 s respawn, ffmpeg ajoi 902 s
   ja 903 s täsmälleen ajastetusti).
4. **Opittu: YouTube-lähetys ei ala ilman auto-starttia.** Ingest voi olla
   terve ja data ACKattu, mutta ajastettu lähetys jää ikuisesti "alkaa
   hetken kuluttua" -tilaan ellei joko (a) lähetyksen "Ota automaattinen
   aloitus käyttöön" ole päällä tai (b) joku paina Go Livea Live Control
   Roomissa (suora osoite: `https://studio.youtube.com/video/<VIDEO_ID>/livestreaming`
   — tavallisesta Studio-videolistasta tätä EI löydä). Laita auto-start
   päälle kun luot lähetyksen, niin pelkkä relayn käynnistys riittää.
5. **Restart kesken ottelun toimii:** systemd-restart 12:21 ohitti 69 jo
   selostettua tapahtumaa tilatiedoston perusteella ja jatkoi oikeasta
   tilanteesta. Katsojalle yksi lyhyt katko.
6. Googlevideon HLS-luku lokittaa jatkuvasti `keepalive request failed …
   retrying with new connection` -varoitusta (edge-hostit rotatoivat).
   Harmiton mutta täyttää lokin — harkitse suodatusta.
7. **Ottelun/lähteen loppu ei pysäytä relaytä.** Kun alkuperäinen lähetys
   päättyi (ffmpeg exit code 0, HLS EOF), relay jäi ikuiseen
   yt-dlp-uudelleenyritysluuppiin ("Requested format is not available",
   backoff 1s→30s) ja selostettu lähetys jäi katsojille pyörivään
   puskurointitilaan. Relay oli ehtinyt itse kuuluttaa lopputilaston
   ("Tilasto lopussa: … voitti") — eli ottelun loppu on jo tunnistettavissa.
   Korjausidea: kun ottelu on API:n mukaan päättynyt JA lähde palauttaa
   EOF:n, lopeta siististi (exit 0, ei respawnia) sen sijaan että jäädään
   luuppiin. Toisen lähetyksen päättäminen jää silti käyttäjälle (tai
   auto-stop päälle YouTube-lähetystä luodessa, ks. kohta 4).

## Tausta

- Täysi arkkitehtuuri, päätökset ja koko riskilista: [DESIGN.md](DESIGN.md)
- Käyttöohje (asennus, per-match-workflow, vianetsintä): [README.md](README.md)
- Edellisen live-testin PR: #20 (mergetty mainiin, kuvaus sisältää löydetyt
  bugit ja mitä silloin ajettiin).

## Rajaukset / muista

- `relay/.env.relay` on gitignoroitu eikä säily committien välissä eikä
  aiempien sessioiden välillä tällä koneella — se pitää luoda uudelleen.
- Relay-palvelu **ei ole enabloitu boottiin** — käynnistä aina käsin per
  ottelu, sammuta ottelun jälkeen (`systemctl --user stop
  pesisselostaja-relay.service`) ja päätä molemmat YouTube-lähetykset.
- Alkuperäistä käyttäjän striimiä ei saa koskea missään vaiheessa — relay
  vain lukee sitä, ei koskaan kirjoita siihen.
