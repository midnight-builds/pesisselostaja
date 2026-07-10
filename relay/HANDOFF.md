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
