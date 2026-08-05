# Relay — voimassa olevat päätökset

Relay-osajärjestelmän rakennepäätökset ja niiden perustelut. Vain voimassa
olevat: kumotut päätökset ja rakennusvaiheiden historia on poistettu, koska
niitä luettiin ohjeina. Käyttöohje on [README.md](README.md):ssä.

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

- **A (valittu):** kuvauspuhelin striimaa YouTubeen kuten ennenkin; relay hakee
  striimin suoran HLS-osoitteen (`yt-dlp -g`), miksaa äänen ja julkaisee
  tuloksen toisena lähetyksenä. Alkuperäinen lähetys säilyy täysin
  koskemattomana — vaikka relay kaatuisi, alkuperäinen live jatkuu. Hintana
  kertautuva viive (alkuperäisen striimin viive + oma käsittely + toisen
  lähetyksen ingest-viive, arviolta **30–90 s**), joka hyväksyttiin tietoisesti.
- **B (hylätty):** kuvauspuhelin striimaisi ensin omalle relepalvelimelle (esim.
  MediaMTX), joka miksaisi ja työntäisi YouTubeen vain kerran. Pienempi viive
  ja vankempi, mutta alkuperäinen live olisi riippuvainen relaystä — käyttäjä
  valitsi A:n nimenomaan siksi, että originaali lähetys säilyy itsenäisenä.

### Lähetysparin luo ohjaamo; relay vain lukee sidontansa

Relay ei puhu YouTube Data API:lle eikä tiedä lähetysten luonnista mitään. Se
lukee ottelun, lähteen ja kohteen `apps/broadcast/.env.relay`-tiedostosta, jonka
ohjaamo (`apps/control`) kirjoittaa luodessaan lähetysparin.

**Ohjaamosta relayyn on täsmälleen kaksi kosketuspintaa** — tuo tiedosto ja
`run/.control-<ID>.json`. Kolmatta ei rakenneta (#59): relay ajaa pinnatusta
`~/relay-deploy`-kopiosta, joka voi olla ohjaamoa vanhempi, joten mikä tahansa
prosessien välinen sopimus vanhenisi juuri kun se on kriittisin.

### Oma hakemisto + oma palvelu samassa repossa

`apps/broadcast/` on oma ylätason hakemisto (kuten `v2/`), **ei** `src/`:n alla:

- `src/`-muutokset laukaisevat auto-build+commit-hookin — relay pysyy sen
  ulkopuolella tarkoituksella.
- Relay ajaa omana systemd-palvelunaan (`pesisselostaja-relay.service`, ei
  enabloitu boottiin), jotta tämän raskaamman video-osajärjestelmän
  kaatuminen ei koskaan vaikuta olemassa olevaan Pesisselostaja-palveluun.
- Ei uusia npm-riippuvuuksia: kaikki ulkoinen (`ffmpeg`, `yt-dlp`, `piper`,
  `mkfifo`) on system-binäärejä child_processin kautta. Ajo `tsx`:llä suoraan
  (ei build-askelta); `apps/broadcast/tsconfig.json` on erillinen noEmit-projekti
  tyyppitarkistukseen, koska juuren tsc ei emitoi yli `rootDir: "src"` -rajan.

### Selostuslogiikan uudelleenkäyttö importilla, ei kopiolla

`apps/broadcast/src/commentaryLoop.ts` importtaa jaetusta
**@pesisselostaja/core**-paketista (kanoninen lähde) puhtaat funktiot: `subEventToSpeech`/
`format*Speech` sekä palojen laskenta `recomputeCurrentOutsKeyed`/
`outsThroughSubEvent` (`packages/core/src/speech.ts`), pisteet (`packages/core/src/state.ts`:n puhtaat
helperit), API-haut (`packages/core/src/api.ts`). Persistointi on broadcast-lokaali, koska
web-sovelluksen omat `loadState`/`saveState`/`loadPronunciations` ovat selaimen
localStorage-pohjaisia: `apps/broadcast/src/nodeState.ts` ja `nodePronunciation.ts`
uudelleenkäyttävät v2:n puhtaat helperit mutta lukevat/kirjoittavat tiedostoon
(`.state-<id>.json`, `.pronunciations.json`).
`WatcherController`ia (v2 `Watcher`) ei uudelleenkäytetä (se on sidottu
selain-/HA-ulostuloon), mutta silmukan rakenne on tarkoituksella identtinen
v2:n `watcher.ts`:n `processEventsLive`/`processEventsSilent`-logiikan kanssa —
ainoa ero on "puhu selaimeen/HA:han" → "syntetisoi ja jonota FIFO:on". Sisältö
ja ajoitus vastaavat siis v2-vahtijaa.

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

## Rajoitteet, jotka on opittu kantapään kautta

Nämä ovat sääntöjä, eivät muistiinpanoja: jokainen on kaatanut lähetyksen tai
selostuksen kerran, ja koodi nojaa niihin nyt.

- **`-reconnect`-lippuja ei käytetä HLS-lähteessä.**
  `-reconnect`/`-reconnect_streamed`/`-reconnect_at_eof` jumittivat lukemisen
  kokonaan googlevideon m3u8-lähteellä: ffmpeg söi CPU:ta tuottamatta mitään.
  `hls`-demukserilla on oma segmenttikohtainen reconnect-logiikkansa, joka
  selviää lyhyestä TLS-katkosta itse.
- **Jokaisella tulospalvelun kutsulla on aikakatkaisu.** Ilman sitä yksi
  verkkohikka jätti `fetch()`-kutsun roikkumaan rajattomasti, selostus katkesi
  neljäksi minuutiksi ja purskahti sitten ulos kerralla. Kaikki `src/api.ts`:n
  haut käyttävät samaa `fetchWithTimeout`-apuria.
- **HLS-URL voi vaihtua kesken ottelun**, joten yt-dlp-lähde uusitaan
  määrävälein eikä pidetä yhtä URLia koko ajon.
- **YouTuben ingest on nirso keyframe-välistä** `-c:v copy`:n kanssa, koska
  GOP-rakenteen määrää alkuperäinen striimaaja — emme me.
- **Resurssit:** `-c:v copy` on kevyt, mutta HLS-pull + RTMP-push + TTS vievät
  muistia ja verkkoa jaetulla koneella. Levytila alle 2 Gt pysäyttää kaiken
  kirjoittavan.
