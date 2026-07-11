# Relay — handoff seuraavaa sessiota varten

Päivitetty 2026-07-10 toisen live-testin (ottelu 143280, PomPy/OuHu–IPV)
jälkeen. Tässä testissä tehtiin ensimmäinen oikea RTMP-julkaisu toiseen
YouTube-lähetykseen — koko putki toimii nyt päästä päähän. Tämä dokumentti on
tyhjälle sessiolle: mitä on testattu, mitkä bugit odottavat korjausta, ja
miten seuraava ajo tehdään.

## Nykytila

- **M0, M2, M4 ✅** — live-testattu 2026-07-10 ottelulla 143277 (KeKi Blue–IPV),
  `--dry-run` ja `--record-file`.
- **M5 ✅** — RTMP-julkaisu oikeaan toiseen YouTube-lähetykseen live-testattu
  2026-07-10 ottelulla 143280: relay työnsi ~tunnin, katsojat näkivät ja
  kuulivat selostetun streamin. YouTube hyväksyi `-c:v copy` -videon
  (1080p30, H.264 High@4.0, 5 s GOP) ongelmitta.
- **M3 ✅ korvakuulolta** — selostus kuului miksattuna kentän äänten päällä.
  Miksaussuhteesta (gain 1.3) ei tullut valituksia. Yksi avoin bugi, ks. alla.
- **M6 osittain** — ilmaisia havaintoja saatiin: restart kesken ottelun
  toipuu tilatiedostosta oikein; URL-rotaatio respawnaa siististi; mutta
  lähteen loppuminen jättää relayn ikuiseen retry-luuppiin (bugi alla).
  Tarkoituksellista vikojen injektointia ei ole vieläkään tehty.

## Korjattavat bugit ennen seuraavaa livetestiä (tärkeysjärjestyksessä)

1. **Palojen määrä selostetaan väärin.** Käyttäjä kuuli toistuvasti "nolla
   paloa" vaikka sisävuorossa oli 1–2 paloa. Lokista (2026-07-10, ajat UTC)
   kaksi erillistä oiretta:
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
   minuutissa samalla kun laskuri nollautui. **Toistettavissa ottelun 143280
   event-datalla ilman livepeliä.**
2. **Selostus katkeaa kesken lauseen ffmpeg-respawnissa.** FIFO:on
   kirjoitettu puhe menetetään kun ffmpeg vaihdetaan (URL-rotaatio tai muu
   respawn) — käyttäjä kuuli lauseen katkeavan. Korjausidea: puskuroi kesken
   jäänyt utterance ja puhu uudelleen respawnin jälkeen, tai viivytä
   respawnia kunnes FIFO on tyhjä.
3. **Ottelun/lähteen loppu ei pysäytä relaytä.** Kun alkuperäinen lähetys
   päättyi (ffmpeg exit code 0, HLS EOF), relay jäi ikuiseen
   yt-dlp-uudelleenyritysluuppiin ("Requested format is not available",
   backoff 1s→30s) ja selostettu lähetys jäi katsojille pyörivään
   puskurointitilaan. Relay oli ehtinyt itse kuuluttaa lopputilaston
   ("Tilasto lopussa: … voitti") — eli ottelun loppu on jo tunnistettavissa.
   Korjausidea: kun ottelu on API:n mukaan päättynyt JA lähde palauttaa
   EOF:n, lopeta siististi (exit 0, ei respawnia).
4. Pienempi: googlevideon HLS-luku lokittaa jatkuvasti `keepalive request
   failed … retrying with new connection` -varoitusta (edge-hostit
   rotatoivat; harmiton mutta täyttää lokin) — harkitse suodatusta.

## Muut havainnot 2026-07-10 testistä

- **URL-rotaatio on katsojalle näkyvä ~8 s katko.** Rotaatio itsessään toimi
  molemmilla kerroilla siististi (respawn ~6–8 s, ajastus täsmällinen),
  mutta 15 min oletusväli oli turhan tiheä: lähde-URL:n `expire` on ~6 h.
  Korjattu ajossa: uusi `RELAY_URL_REFRESH_MS`-env-ohitus, livetestissä 4 h.
- **YouTube-lähetys ei ala ilman auto-starttia.** Ingest voi olla terve ja
  data ACKattu, mutta ajastettu lähetys jää ikuisesti "alkaa hetken
  kuluttua" -tilaan ellei joko (a) lähetyksen "Ota automaattinen aloitus
  käyttöön" ole päällä tai (b) joku paina Go Livea Live Control Roomissa
  (suora osoite: `https://studio.youtube.com/video/<VIDEO_ID>/livestreaming`
  — tavallisesta Studio-videolistasta tätä EI löydä). **Laita auto-start JA
  auto-stop päälle kun luot lähetyksen**, niin relayn käynnistys riittää
  eikä lähetys jää roikkumaan lopussa.
- **Restart kesken ottelun toimii:** systemd-restart ohitti 69 jo selostettua
  tapahtumaa tilatiedoston perusteella ja jatkoi oikeasta tilanteesta.
  Katsojalle yksi lyhyt katko.
- **Kokonaisviive on odotettu ~30–90 s** live-reunassa. Jos katsoja raportoi
  minuuttien viivettä, soitin on pudonnut live-reunasta (soittimen
  LIVE-nappi korjaa).

## Miten ajetaan — nopea muistilista

- Luo `relay/.env.relay` (kopioi `.env.relay.example`; gitignoroitu eikä
  säily sessioiden välillä). Muista `RELAY_URL_REFRESH_MS=14400000` (4 h),
  ettei turhia rotaatiokatkoja tule.
- **Esitesti ilman RTMP:tä ensin**:
  `npm run relay:dev -- --match-id <ID> --youtube-url <alkuperäisen lähetyksen URL> --dry-run`
  (vain lokitus) tai `--record-file relay/run/<nimi>.mp4` (oikea synteesi +
  miksaus paikalliseen tiedostoon).
- **Oikea RTMP-ajo**: ks. [README.md](README.md) "Per-match workflow" +
  auto-start/auto-stop-huomio yllä.
  `systemctl --user start pesisselostaja-relay.service`, loki:
  `journalctl --user -u pesisselostaja-relay -f`.
- **Levytila**: `df -h /` ennen ja aikana pitkiä ajoja — globaali sääntö on
  pysäyttää kaikki kirjoittavat operaatiot jos vapaata alle 2 Gt.
- **Roikkuvat prosessit**: `ps aux | grep -E "ffmpeg|relay/src/index"` ennen
  uuden testin käynnistystä — varmista aina että edellinen ajo on oikeasti
  kuollut (`TaskStop`/`kill` + `ps`-tarkistus, ei pelkkä oletus).

## Tausta

- Täysi arkkitehtuuri, päätökset ja koko riskilista: [DESIGN.md](DESIGN.md)
- Käyttöohje (asennus, per-match-workflow, vianetsintä): [README.md](README.md)
- Live-testien PR:t: #20 (ensimmäinen testi: dry-run + record-file, kaksi
  korjattua bugia kuvauksessa), #23 (toinen testi: ensimmäinen RTMP-julkaisu,
  `RELAY_URL_REFRESH_MS` + tämän dokumentin havainnot).

## Rajaukset / muista

- `relay/.env.relay` on gitignoroitu eikä säily committien välissä eikä
  aiempien sessioiden välillä tällä koneella — se pitää luoda uudelleen.
- Relay-palvelu **ei ole enabloitu boottiin** — käynnistä aina käsin per
  ottelu, sammuta ottelun jälkeen (`systemctl --user stop
  pesisselostaja-relay.service`) ja päätä molemmat YouTube-lähetykset
  (tai käytä auto-stopia).
- Alkuperäistä käyttäjän striimiä ei saa koskea missään vaiheessa — relay
  vain lukee sitä, ei koskaan kirjoita siihen.
