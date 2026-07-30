# Kenttäaudion normalisointi ja tuulenpoisto — kuunneltava demo (v2)

Vastaa käyttäjän ideaan ("kenttäaudion normalisointi ja tuulen suhinan
poisto livenä", 18.7.2026). Koskee vain **alkuperäisen videon omaa ääntä**
(kentän ambienssi, tuuli, huudot) — ei selostusta, paitsi lopun ducking-demo
jossa molemmat yhdistyvät.

**Lue ensin:** [field-audio-criteria.md](field-audio-criteria.md) —
arviointikriteeristö kirjoitettiin ennen tätä mittauskierrosta, jotta valinta
ei perustuisi pelkkään "kuulostaa kivalta" -fiilikseen. Käyttäjän ehto oli
erityisesti: **älä litistä pelin tunnelmaa liian monotoniseksi** — tästä
tuli kriteeri 4, painotettu raskaimmin, ja se muutti lopputulosta yllättävällä
tavalla (ks. alla).

## v1 → v2: mikä muuttui

v1 (edellinen kierros) käytti 4 min pätkää ja yhtä "kaikki päälle"
-yhdistelmää. Käyttäjän pyynnöstä tämä kierros on perusteellisempi:

- **Koko 19 min lähdeklippi** ladattu ja analysoitu, ei vain 4 min otos —
  antaa oikean kuvan koko pelin dynamiikasta, ei vain yhdestä hetkestä.
- **Datavetoiset maamerkkikohdat** (ei arvattu, ks. alla) tuulisimman,
  kovimman ja hiljaisimman hetken paikantamiseen.
- **Kriteeristö kirjoitettu ennen mittausta**, ja se paljasti että alkuperäinen
  oletukseni ("yhdistä kaikki suotimet keskivahvasti") oli väärässä
  suunnassa — kevyempi, kapeampi käsittely mittasi paremmin juuri sillä
  kriteerillä josta käyttäjä oli huolissaan.

## Lähdemateriaali

Koko ääniraita (19:00) julkisesta YouTube-VODista
`youtube.com/live/nCbvAiof-Vc` (oman seuran leiriottelun tallenne, ei livenä
enää). Vain ääniraita ladattu. Uudelleenlataus: ks. komento
`field-audio-demo-v2.sh`:n headerissa.

### Datavetoiset maamerkkikohdat (löydetty `parse_ebur128.py`:llä + matalataajuusskannauksella, ei arvattu)

| Kohta | Ajankohta | Miksi tärkeä |
|---|---|---|
| **Tuulisin jakso** | ~17:15 (1035 s) | Matalataajuusenergia (<150 Hz) −15,5 dB, korkein koko klipistä — samalla alueella kuin käyttäjän alun perin mainitsema ~15 min kohta (898 s), tuuli näyttää jatkuvan/voimistuvan loppua kohti. Kriteeri 1. |
| **Kovin hetki** | ~17:20 (1040,5 s) | M −7,7 LUFS, todennäköinen iso pelitilanne/huuto. Kriteeri 2 (clipping) ja 5 (artefaktit kovalla signaalilla). Käytetty myös narration-ducking-demon "torture testinä" — testiselostus soi juuri tässä kohdassa. |
| **Rauhallisin vakaa jakso** | ~8:47 (527 s) | Matala, tasainen tausta. Kriteeri 4 (nouseeko kohina/tausta epäluonnollisen kuuluvaksi?) ja 5 (denoiser-artefaktit kuuluvat useimmiten juuri täällä). |

Hyppää suoraan näihin kolmeen kohtaan sen sijaan että kuuntelet koko 19 min
joka tiedostosta.

## Kuuntele

dufsin kautta selaimessa: http://100.112.217.85:5000/pesistulokset-voice-watcher/apps/broadcast/run/field-audio-demo/clips-v2/

(Vanha `clips/`-kansio on v1:n lyhyt 4 min -kokeilu, jäänyt talteen mutta
korvattu tämän kierroksen tuloksilla.)

| Tiedosto | Pituus | Mitä testataan |
|---|---|---|
| `00-original.mp3` | 19 min | Käsittelemätön referenssi |
| `01-highpass.mp3` | 19 min | Pelkkä `highpass=f=120` — "poista vain tuuli, älä koske mihinkään muuhun" |
| `01a-highpass100-snippet.mp3` / `01b-highpass150-snippet.mp3` | 20 s (tuulisin kohta) | Ylipäästön rajataajuusvertailu 100 Hz vs 150 Hz |
| `02-peaklimiter.mp3` | 19 min | highpass + **pelkkä** piikkilimitteri (`level=disabled` — ei automaattista tasonsäätöä), nollaa muuta koskematta |
| `03-gentle-dynaudnorm.mp3` | 19 min | + hidas (2 s ikkuna) `dynaudnorm`, matala max-vahvistus — **datan perusteella paras ehdokas, ks. alla** |
| `04-gentle-compressor.mp3` | 19 min | Vaihtoehtoinen hidas leveling `acompressor`-suotimella dynaudnormin sijaan |
| `05-moderate-combo.mp3` | 19 min | Kompressori+dynaudnorm+limitteri yhdessä — **alkuperäinen hypoteesini "tasapainosta", data osoitti liian kalliiksi, ks. alla** |
| `06-aggressive-reference.mp3` | 19 min | v1:n vanha "kaikki päälle" -ketju, tarkoituksella **negatiivinen esimerkki** |
| `07a-afftdn-light-snippet.mp3` / `07b-afftdn-heavy-snippet.mp3` | 20 s (rauhallisin kohta) | FFT-kohinanpoisto kevyesti (nr=6) vs voimakkaasti (nr=12) — kuuntele syökö kumpikaan yleisöambienssia |
| `08-recommended-narration-ducked.mp3` / `09-recommended-narration-noduck.mp3` | 19 min | Testiselostus (Piper) 05-yhdistelmän päällä, ducking vs ei — **säilytetty vertailuksi, mutta 05 EI enää suositus** |
| `10-gentle-dynaudnorm-narration-ducked.mp3` / `11-gentle-dynaudnorm-narration-noduck.mp3` | 19 min | Sama testi **03:n** (oikean ehdokkaan) päällä — kuuntele nämä, ei 08/09 |
| `00-original-calm-snippet.mp3` / `00-original-windy-snippet.mp3` | 20 s (8:47 / 17:15) | Alkuperäinen samoista kohdista kuin arnndn-vertailu alla |
| `03a-gentle-dynaudnorm-calm-snippet.mp3` / `03b-…-windy-snippet.mp3` | 20 s | Nykysuositus samoista kohdista, arnndn-vertailun referenssi |
| `12-arnndn-marathon.mp3` (+`12a`/`12b`-snippetit) | 19 min | highpass + RNNoise yleismalli (`marathon-prescription`) |
| `13-arnndn-conjoined-burgers.mp3` (+`13a`/`13b`) | 19 min | highpass + RNNoise "recording noise" -malli — **mittasi aggressiivisimmaksi, ei odotettu** |
| `14-arnndn-beguiling-drafter.mp3` (+`14a`/`14b`) | 19 min | highpass + RNNoise puhe-vain-malli — tarkoituksella väärä työkalu -esimerkki |
| `15-arnndn-marathon-plus-recommended.mp3` (+`15a`/`15b`) | 19 min | "lisätäänkö RNNoise 03:n päälle" -kandidaatti |

08–11:n testirivi ("Testiselostus. Ysit vie pelin ratkaisuun, tilanne kolme
kaksi.") on keksitty, ei oikeasta ottelusta — ei pelaajanimiä. Soi tarkoituksella
klo 17:20 kohdalla, klipin kovimman hetken päällä — pahin mahdollinen testi
duckingille.

## Mitattu tulostaulukko (kriteeristöä vasten)

Baseline (00-original, koko 19 min): LRA 18,4 LU, mean_M −26,7 LUFS,
stdev_M 7,14 LU, p90−p10 18,9 LU, tuulisimman kohdan matalataajuustaso −21,4 dB.

| Variantti | K1: tuulivaimennus (Δ dB tuulikohdassa) | K2: true peak (dBTP) — portti | K3: LRA (LU) | K4: stdev_M / spread säilyneenä (% baselinesta) | K4: mean_M-nousu (LU) |
|---|---|---|---|---|---|
| 01-highpass | −6,8 dB | **+0,09 — EI TURVALLINEN** (ei limitteriä vielä) | 18,9 (ei muutu) | 101 % / 102 % | −2,5 |
| 02-peaklimiter | −6,8 dB | −0,84 ✅ | 18,9 | **101 % / 102 % (täysin säilynyt)** | −2,5 |
| **03-gentle-dynaudnorm** | **−9,0 dB (paras)** | −0,74 ✅ | 17,3 | 97 % / 96 % | −2,4 |
| 04-gentle-compressor | −7,6 dB | −0,65 ✅ | 13,8 | 81 % / 81 % | +0,9 |
| 05-moderate-combo | −3,8 dB (**heikompi kuin pelkkä highpass!**) | −0,43 ✅ | 13,3 | 84 % / 81 % | +3,0 |
| 06-aggressive (negatiivinen esimerkki) | +1,5 dB (**huonompi kuin käsittelemätön!**) | **+0,85 — PORTTI EPÄONNISTUU** | 10,6 | 75 % / 70 % | **+8,7 (iso)** |

("Δ dB tuulikohdassa" = tuulisimman 15 s -ikkunan matalataajuusenergian
muutos alkuperäiseen verrattuna, isompi negatiivinen luku = parempi
vaimennus. "mean_M-nousu" = keskimääräisen hetkellisen äänekkyyden nousu
koko klipin yli — mitä isompi, sitä enemmän lopputulos kuulostaa
"aina vähän liian kovalta" riippumatta suhteellisesta dynamiikasta.)

### Yllättävä löydös: oma hypoteesini (05) hävisi kevyemmälle vaihtoehdolle (03)

Suunnittelin 05:n "tasapainoksi" ennen mittausta. Data kertoo toista:

- **05 vaimentaa tuulta VÄHEMMÄN kuin pelkkä highpass** (−3,8 dB vs. −6,8 dB) —
  kompressori+dynaudnorm nostavat yleistasoa niin paljon että osa
  highpassin poistamasta matalataajuisesta jäänteestä nousee takaisin
  kuuluvaksi. Voimakkaampi käsittely siis osin **kumoaa** kevyemmän
  suotimen hyödyn.
- **03 vaimentaa tuulta ENITEN kaikista** (−9,0 dB) ja säilyttää silti
  96–97 % alkuperäisestä dynamiikasta — ei kompromissia, molemmat kriteerit
  paranevat yhtä aikaa.
- **06 (negatiivinen esimerkki) vaimentaa tuulta HUONOMMIN kuin ei mitään**
  (+1,5 dB eli tuulikohta on ÄÄNEKKÄÄMPI kuin alkuperäisessä) ja nostaa
  koko klipin keskitasoa 8,7 LU — tämä on juuri se "aina päällä
  kohiseva/väsyttävä" lopputulos jota käyttäjä pelkäsi, ja se on nyt
  mitattu, ei vain oletettu.
- **06 myös epäonnistuu turvallisuusportissa** (true peak +0,85 dBTP,
  aito clip-riski) — tekninen opetus talteen kriteeristöön: `alimiter`
  ilman `level=disabled`-optiota voi nostaa signaalin takaisin yli oman
  kynnyksensä. "Ketjussa on limitteri" ei riitä, jokainen ehdokas pitää
  mitata erikseen.

**Uusi suositus: 03-gentle-dynaudnorm** (highpass=120 + hidas dynaudnorm
+ pelkkä piikkilimitteri), ei enää 05. 02-peaklimiter on turvallinen
minimivaihtoehto jos jopa 03:n kevyt tasoitus tuntuu kuunneltaessa liialta.

## RNNoise (`arnndn`) -kierros — ladattu ja testattu

Kolme mallia haettu ffmpegin arnndn-dokumentaation linkkaamasta
yhteisöylläpitämästä repositoriosta
[github.com/GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models)
(`apps/broadcast/run/field-audio-demo/rnnoise-models/`, gitignoroitu — ks.
lataukomennot `field-audio-demo-arnndn.sh`:n headerissa). Repon oma
signaali/kohina-taulukko ohjasi valintaa:

| Malli | Signaali jota mallia opetettu säilyttämään | Kohina jota opetettu poistamaan |
|---|---|---|
| `marathon-prescription` | Yleinen (puhe + nauru/yskä + musiikki) | Yleinen (Xiphin rnnoise_contributions-data) |
| `conjoined-burgers` | Yleinen | "Recording" (tuuletin/AC/laite) |
| `beguiling-drafter` | **Vain puhe** (ei naurua/musiikkia) | "Recording" — tarkoituksella väärä työkalu -esimerkki |

Kaikki kolme täydellä 19 min klipillä + yksi yhdistelmä (`marathon` +
03:n dynaudnorm+limitteri, eli "lisätäänkö RNNoise nykysuositukseen").

### Mitattu tulos: kaikki kolme mallia ovat liian aggressiivisia tälle materiaalille

| Variantti | mean_M (Δ alkuperäiseen) | calm_moment (Δ alkuperäiseen, alkup. −37,1 LUFS) | spread p90−p10 | Tuulivaimennus |
|---|---|---|---|---|
| 00-original (baseline) | −26,7 | −37,1 (0) | 18,9 LU | — |
| 03-gentle-dynaudnorm (nykysuositus) | −23,7 | n. −39 (samaa luokkaa) | 15,3 LU | −9,0 dB |
| 12-arnndn-marathon | **−44,7 (−18,0!)** | **−62,6 (−25,5!)** | 25,0 LU | −14,3 dB |
| 13-arnndn-conjoined-burgers | **−51,6 (−24,9!)** | **−76,1 (−39,0!)** | 37,4 LU | −26,2 dB |
| 14-arnndn-beguiling-drafter | −47,0 (−20,3) | −65,6 (−28,5) | 22,3 LU | −24,2 dB |
| 15-arnndn-marathon+03 | −38,1 (−11,4) | −52,9 (−15,8) | 22,7 LU | −11,1 dB |

**Tärkeä varoitus kriteerille 4:** spread-luvut näyttävät tässä ISOMMILTA
kuin alkuperäisessä (25–37 LU vs. 18,9 LU) — pelkän spread-mittarin mukaan
tämä voisi virheellisesti näyttää "hyvältä" (enemmän dynamiikkaa!). Mutta
`calm_moment`-arvo paljastaa mitä oikeasti tapahtuu: hiljaiset hetket
vaimenevat lähes täydelliseen hiljaisuuteen (esim. 13: −76,1 LUFS eli n.
39 LU alkuperäistä hiljaisempi) — tämä on kohinaportin kaltaista käytöstä,
ei luonnollista dynamiikkaa. Iso spread syntyy siitä että hiljaiset kohdat
"gatetaan" lähes nollaan, jolloin kontrasti kovaan hetkeen kasvaa
keinotekoisesti. Tämä täsmää kriteeristöön juuri lisättyyn huomioon (ks.
field-audio-criteria.md, kriteeri 4).

**Kaikki kolme mallia käyttäytyvät samansuuntaisesti**, myös se jota en
odottanut olevan pahin (`conjoined-burgers`, "recording"-kohinamalli) osoittautui
mittauksissa AGGRESSIIVISIMMAKSI, ei lievimmäksi — vielä yksi kohta jossa
oma ennakko-oletukseni (RNNoise-tyyppi vaikuttaisi voimakkuuteen
odotetusti) ei pitänyt paikkaansa datassa.

**Alustava johtopäätös (vahvistettava korvakuulolla):** RNNoise, ainakin
näillä kolmella valmiiksi koulutetulla mallilla, näyttää tukahduttavan
stadionin/yleisön luonnollisen taustaäänen aivan liikaa — tekniikka on
koulutettu poistamaan tuulettimen/koneen hurinaa TAI eristämään puhetta
yksittäisistä nauhoituksista, ei säilyttämään "urheilutapahtuman tunnelmaa
mutta poistamaan tuulen puuska". **En suosittele arnndn:ää tällä
materiaalilla** minkään testatun mallin kanssa — mutta tämä on mittarilla
tehty johtopäätös, ei korvakuulolla vahvistettu. Kuuntele erityisesti:

- `12a`/`13a`/`14a-*-calm-snippet.mp3` vs. `03a-gentle-dynaudnorm-calm-snippet.mp3`
  vs. `00-original-calm-snippet.mp3` (kaikki samasta n. 8:47 kohdasta) —
  kuuluuko yleisön luonnollinen taustahäly, vai onko se hävinnyt käytännössä
  kokonaan?
- `12b`/`13b`/`14b-*-windy-snippet.mp3` vs. `03b-gentle-dynaudnorm-windy-snippet.mp3`
  vs. `00-original-windy-snippet.mp3` (n. 17:15) — poistuuko tuuli
  luonnollisen kuuloisesti vai jääkö jäljelle "veden alla" -sointia tai
  pumppausta?
- `15-arnndn-marathon-plus-recommended.mp3` — jos 12/13/14 kuulostavat liian
  kuolleilta yksinään, kuulostaako yhdistelmä 03:n kanssa siedettävämmältä,
  vai onko vaurio jo tapahtunut ennen dynaudnormia?

## Mitä EI voi mitata — kuunneltava itse

- **Artefaktit** (pumppaus, "veden alla" -sointi): ei luotettavaa mittaria.
  Kuuntele erityisesti 06 (kovin ehdokas) rauhallisimmassa kohdassa (8:47) ja
  vertaa 07a/07b:hen samasta kohdasta.
- **Pelitapahtumien erottuvuus** (pillit, lyönnit, huudot): subjektiivinen.
- **Ducking-kokemus** (10 vs. 11): kuulostaako selostus luontevalta kun se
  soi juuri klipin kovimman hetken (17:20) päällä?

## Rajaukset / ei tehty

- `arnndn` (RNNoise) nyt testattu (3 mallia, ks. yllä) — mittausten
  perusteella liian aggressiivinen tälle materiaalille, ei suositella,
  mutta korvakuulolla vahvistus puuttuu vielä.
- Sidechain-kynnys (10/11) on yhä arvattu, ei kalibroitu oikeaan
  `RELAY_NARRATION_GAIN`-arvoon (1.3) tuotantoäänellä.
- Ei muutoksia tuotantokoodiin (`ffmpegMixer.ts` koskematon) — pelkkä demo.
- Ei testattu videon kanssa yhdessä — `-c:v copy` pysyisi koskemattomana,
  mutta A/V-synkkaa ei ole erikseen todennettu.

## Skriptit

- `field-audio-criteria.md` — kriteeristö (kirjoitettu ennen mittausta).
- `field-audio-demo-v2.sh` — koko putki: lataus → 12 varianttia → mittaus.
  Aja: `bash apps/broadcast/experiments/field-audio-demo-v2.sh`
  (vaatii `source/original_full.wav`, ks. skriptin header). ~5–10 min ajoaika.
- `parse_ebur128.py` — momentaanisen äänekkyyden hajonta-/maamerkkianalyysi
  ffmpegin `ebur128`-lokista.
- `field-audio-demo-arnndn.sh` — RNNoise-kierros (3 mallia + 1 yhdistelmä).
  Aja: `bash apps/broadcast/experiments/field-audio-demo-arnndn.sh`
  (vaatii `rnnoise-models/*.rnnn`, ks. latauskomennot skriptin headerissa —
  mallit haettu github.com/GregorR/rnnoise-models:sta). ~2 min ajoaika.
- v1: `field-audio-demo.sh` (lyhyt 4 min -kokeilu, superseded).

## Rajaukset (levy/repo)

- `apps/broadcast/run/field-audio-demo/` gitignoroitu — pysyy vain
  palvelimella, regeneroitavissa skriptillä (myös `rnnoise-models/`,
  uudelleenladattavissa netistä, ei committoida binäärinä).
- Lähdeklippi on julkisen YouTube-VODin ääniraita, ei omaa selostusääntä.

## Palaute

_(täytetään kun käyttäjä on kuunnellut — erityisesti kiinnostaa: 03 vs. 02
[kannattaako edes kevyt dynaudnorm], ducking 17:20-kohdassa,
07a/07b-denoiser-artefaktit, ja arnndn-kierros [12/13/14 calm-snippetit vs.
03a/00-original-calm — kuoleeko yleisöambienssi oikeasti niin pahasti kuin
mittarit väittävät, vai onko 15-yhdistelmä silti käyttökelpoinen?])_
