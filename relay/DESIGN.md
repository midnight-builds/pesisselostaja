# Relay — suunnitelma ja tehdyt päätökset

Tämä on relay-osajärjestelmän alkuperäinen suunnitteludokumentti (heinäkuu 2026):
mitä rakennettiin, mitkä vaihtoehdot hylättiin ja miksi. Käyttöohje on
[README.md](README.md):ssä.

## Tavoite

Kännykkä striimaa ottelun YouTubeen. Relay ottaa tuon jo julkaistun
livestreamin takaisin sisään, miksaa siihen päälle Pesisselostajan tuottaman
tapahtumaselostuksen (sama sisältö ja ääni kuin v2:n "Edistynyt ääni"
-Piper-selostus) ja julkaisee tuloksen **toisena, erillisenä**
YouTube-lähetyksenä. Alkuperäinen striimi ei muutu eikä siihen kosketa;
alkuperäistä ääntä ei poisteta, selostus vain lisätään sen päälle.

## Arkkitehtuuripäätökset

### A: imuroidaan julkaistu striimi takaisin (valittu)

Kaksi vaihtoehtoa punnittiin:

- **A (valittu):** kännykkä striimaa YouTubeen kuten ennenkin; relay hakee
  striimin suoran HLS-osoitteen (`yt-dlp -g`), miksaa äänen ja julkaisee
  tuloksen toisena lähetyksenä. Alkuperäinen lähetys säilyy täysin
  koskemattomana — vaikka relay kaatuisi, alkuperäinen live jatkuu. Hintana
  kertautuva viive (alkuperäisen striimin viive + oma käsittely + toisen
  lähetyksen ingest-viive, arviolta **30–90 s**), joka hyväksyttiin tietoisesti.
- **B (hylätty):** kännykkä striimaisi ensin omalle relepalvelimelle (esim.
  MediaMTX), joka miksaisi ja työntäisi YouTubeen vain kerran. Pienempi viive
  ja vankempi, mutta alkuperäinen live olisi riippuvainen relaystä — käyttäjä
  valitsi A:n nimenomaan siksi, että originaali lähetys säilyy itsenäisenä.

### Käsinpariutus, ei YouTube API -automaatiota

Käyttäjä luo toisen lähetyksen käsin YouTube Studiossa ja antaa sen
RTMP-osoitteen + avaimen `.env.relay`-tiedostossa. YouTube Live Data API +
Google OAuth -automaatio hylättiin: paljon monimutkaisempi (OAuth-virrat,
kiintiöt) eikä tarpeen, kun lähetyksiä luodaan yksi per ottelu käsin.

### Oma hakemisto + oma palvelu samassa repossa

`relay/` on oma ylätason hakemisto (kuten `v2/`), **ei** `src/`:n alla:

- `src/`-muutokset laukaisevat auto-build+commit-hookin — relay pysyy sen
  ulkopuolella tarkoituksella.
- Relay ajaa omana systemd-palvelunaan (`pesisselostaja-relay.service`, ei
  enabloitu boottiin), jotta tämän raskaamman video-osajärjestelmän
  kaatuminen ei koskaan vaikuta olemassa olevaan Pesisselostaja-palveluun.
- Ei uusia npm-riippuvuuksia: kaikki ulkoinen (`ffmpeg`, `yt-dlp`, `piper`,
  `mkfifo`) on system-binäärejä child_processin kautta. Ajo `tsx`:llä suoraan
  (ei build-askelta); `relay/tsconfig.json` on erillinen noEmit-projekti
  tyyppitarkistukseen, koska juuren tsc ei emitoi yli `rootDir: "src"` -rajan.

### Selostuslogiikan uudelleenkäyttö importilla, ei kopiolla

`relay/src/commentaryLoop.ts` importtaa suoraan pääsovelluksen puhtaat
funktiot: `subEventToSpeech`/`format*Speech` (`src/speech.ts`), pisteet ja
palot (`src/state.ts`), API-haut (`src/api.ts`), ääntämissäännöt
(`src/pronunciation.ts` — sama `.pronunciations.json` jota web-UI muokkaa).
`WatcherController`ia ei uudelleenkäytetä (se on sidottu HA/selain-ulostuloon),
mutta silmukan rakenne on tarkoituksella identtinen `src/watcher.ts`:n
`runWatcher`/`processEvents`-logiikan kanssa — ainoa ero on "puhu HA:han" →
"syntetisoi ja jonota FIFO:on". Sisältö ja ajoitus vastaavat siis HA-vahtijaa.

### TTS: piper-CLI, ei wasm-putken toistoa

v2:n Piper-äänet ovat vakiomuotoisia `.onnx`+`.onnx.json`-tiedostoja, joten
sama malli toimii suoraan Rhasspyn viralliseen `piper`-CLI:hin
palvelinpuolella — selaimen piper-wasm/onnxruntime-web-putkea ei tarvinnut
toistaa. v1:ssä yksi ääni (`fi_FI-harri-medium`, v2:n oletus);
`piperTts.ts`:n `VOICE_FILES`-mappi tuntee jo kaikki kolme, joten lisä-äänet
ovat vain mallitiedoston lataus.

## ffmpeg-miksauksen ydinvalinnat

Kaikki ääni normalisoidaan 48 kHz / stereo / s16le:ksi. Yksi pitkäikäinen
ffmpeg-prosessi: HLS-pull → amix → RTMP-push.

- **`-c:v copy`** — videota ei koskaan dekoodata/enkoodata uudelleen; vain
  ääniraita käsitellään. Tämä pitää CPU-kuorman matalana jaetulla
  4 vCPU / 8 Gt -koneella. Toimii, koska YouTube live tuottaa H.264:n, jota
  FLV/RTMP tukee suoraan.
- **`amix ... normalize=0` + `alimiter`** — amixin oletus puolittaisi kaiken
  äänenvoimakkuuden aina (myös selostuksen hiljaisuuden aikana), mikä rikkoisi
  vaatimuksen "alkuperäiseen ääneen ei kosketa". `normalize=0` pitää
  alkuperäisen koskemattomana; limitteri estää leikkautumisen kun molemmat
  soivat päällekkäin.
- **Ei duckingia v1:ssä** — selostus lisätään päälle hiljentämättä
  alkuperäistä (tietoinen rajaus; `sidechaincompress` mahdollinen laajennus).
- **Selostuksen esivahvistus** (`volume=1.3`, säädettävissä
  `RELAY_NARRATION_GAIN`illa) vain selostushaaraan, jotta se kuuluu yleisön yli.
- **`-reconnect*`-liput** kattavat vain HLS-syötteen tilapäiset katkot yhden
  prosessin sisällä. RTMP-push-suuntaan ffmpegillä ei ole automaattista
  reconnectia, ja HLS-URL voi vanhentua kokonaan — molemmat hoitaa
  **valvoja** (`ffmpegMixer.ts`): mikä tahansa exit → tuore URL yt-dlp:llä →
  respawn eksponentiaalisella backoffilla (1 s → 30 s katto, nollaus 60 s
  terveen ajon jälkeen). Lisäksi määräaikainen respawn (15 min) tuoreen
  URL:n varmistamiseksi.

## FIFO: selostuksen injektointi elävään ffmpeg-graafiin

Ydinongelma: ffmpeg lukee FIFO-syötettä reaaliaikaisella vauhdilla, ja `amix`
tarvitsee dataa **kaikilta** syötteiltään tuottaakseen ulostuloa — jos Node
lakkaa kirjoittamasta hetkeksikin, koko graafi jumittuu tai ääni/video
desynkkaa. Ratkaisu (`narrationFifo.ts`): **ikuinen 20 ms:n kehyskello**
(drift-korjattu, 3840 tavua/kehys), joka kirjoittaa hiljaisuutta kun jono on
tyhjä ja jonotettua selostus-PCM:ää kun ei ole. Selostuspätkät soivat
peräkkäin syntyjärjestyksessä; pätkän viimeinen vajaa kehys täytetään
hiljaisuudella, ettei seuraava pätkä vuoda samaan kehykseen.

Avausjärjestys on kriittinen: FIFO luodaan (`mkfifo`) ennen ffmpegin
spawnia, mutta Noden kirjoituspää avataan vasta ffmpegin spawnin **jälkeen** —
FIFO:n avaus blokkaa kunnes molemmat päät ovat kiinni. ffmpeg-respawnissa
putki luodaan uudelleen; jonossa oleva selostus säilyy muistissa.

Hylätty vaihtoehto: ffmpegin `azmq`/`sendcmd`-filtterit dynaamiseen
wav-toistoon ilman FIFO:a — vaatisi libzmq-käännetyn ffmpegin ja erillisen
ohjauskanavan, eikä poistaisi reaaliaikatahdituksen ongelmaa.

## Riskit ja avoimet kysymykset

- **HLS-URL:n vanhenemiskäyttäytyminen** ei ole varmuudella tiedossa —
  suunnitelma olettaa pahimman (voi vaihtua kesken ottelun); 5 min testiajo
  (2026-07-10, ottelu 143277) ei osunut URL-rotaatioon (15 min kynnys ei
  ehtinyt täyttyä) — vahvistettava vielä pidemmällä testistriimillä.
- **`-reconnect`/`-reconnect_streamed`/`-reconnect_at_eof`-liput jumittivat
  HLS-luvun kokonaan** googlevideon m3u8-lähteen kanssa (löytyi 2026-07-10
  ensimmäisessä live-testissä: ffmpeg söi CPU:ta muttei tuottanut mitään).
  Poistettu — `hls`-demukserilla on jo oma segmenttikohtainen
  reconnect-logiikkansa, ja sama testi osoitti sen selviävän itse lyhyestä
  TLS-katkosta ilman näitä lippuja.
- **YouTuben ingest voi olla nirso keyframe-välistä** `-c:v copy`:n kanssa
  (alkuperäinen striimaaja määrää GOP-rakenteen) — tarkista YouTube Studion
  ingest-terveys ensimmäisessä oikeassa RTMP-live-testissä (ei vielä tehty,
  koska toista YouTube-lähetystä ei ole ollut käytettävissä).
- **FIFO:n 20 ms -tahditus**: 5 min testiajo tuotti jatkuvan, validin
  mp4:n (98 Mt, kesto täsmäsi ajoaikaan) ilman havaittuja katkoja, mutta
  ääntä ei kuunneltu läpi — pidempi soak-testi ja kuuntelu suositeltavaa
  ennen oikeaa lähetystä.
- **Resurssit**: `-c:v copy` on kevyt, mutta HLS-pull + RTMP-push + piper
  vievät muistia/verkkoa jaetulla koneella — seuraa RSS/CPU:ta live-testeissä.
- **`fetchLiveEvents`/`fetchMatchMetadata` ilman aikakatkaisua** (`src/api.ts`)
  aiheutti live-testissä 4 min 9 s:n selostuskatkon (hetkellinen verkkohikka
  jätti `fetch()`-kutsun roikkumaan rajattomasti), minkä jälkeen kaikki sinä
  aikana kertyneet tapahtumat purskahtivat ulos kerralla — kuulosti
  satunnaiselta selostukselta. Korjattu 2026-07-10: molemmat käyttävät nyt
  samaa 8 s `fetchWithTimeout`-apuria mitä `fetchLiveMatches` jo käytti.

## Välietapit ja tila

| # | Sisältö | Tila |
|---|---|---|
| M0 | Käsin ajettu yt-dlp/piper/ffmpeg-savutesti | ✅ (2026-07-10, oikea livestriimi, ottelu 143277) |
| M1 | Runko: config, logitus, systemd | ✅ |
| M2 | Passthrough pull/republish valvottuna | ✅ (2026-07-10, `--record-file`-tila, 5 min, löytyi+korjattiin reconnect-lippu-bugi) |
| M3 | FIFO-putkitus testiäänellä | koodi + yksikkötestit ✅; pidempi soak-testi + kuuntelu tekemättä |
| M4 | Selostussilmukka dry-runilla | ✅ (dry-run + oikea synteesi molemmat ajettu oikealla ottelulla) |
| M5 | Täysi päästä-päähän-integraatio | osittain: pull+mix+paikallistallennus testattu oikealla ottelulla (M2); RTMP-julkaisu toiseen YouTube-lähetykseen vielä testaamatta (ei toista lähetystä käytettävissä) |
| M6 | Sietokykytestaus (kaatumiset, URL-rotaatio, RTMP-katkot) | tekemättä; yksi verkkokatko selvisi testissä itsestään (ks. riskit) |
| M7 | Dokumentaatio | ✅ (README.md + tämä tiedosto) |
