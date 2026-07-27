# Kenttäaudion parannuksen arviointikriteeristö

Mitä tavoitellaan kun puhelimen kenttäääntä käsitellään (ei koske TTS-
selostusta, ks. [field-audio-demo.md](field-audio-demo.md)). Kirjoitettu
ennen variaatioiden arviointia, jotta arvio ei ajaudu pelkäksi "kuulostaa
kivalta" -mielipiteeksi.

## Kriteerit

| # | Kriteeri | Paino | Tavoite | Miten mitataan/arvioidaan |
|---|---|---|---|---|
| 1 | **Tuulen/matalataajuisen kohinan vaimennus** | 2 | Selvä (>5 dB) vaimennus tuulisimmalla hetkellä, ilman että koko ääni ohenee | Matalataajuus- (<150 Hz) energia mitattuna `lowpass=150`+`volumedetect`, klipin tuulisin 15 s -jakso vs. sama kohta alkuperäisessä |
| 2 | **Piikkien/clippauksen hallinta** | — (portti, ei pisteytetä) | Ei koskaan digitaalista clippausta (0 dBFS), true peak aina reilusti alle 0 dBTP | `loudnorm`-mittauksen `output_tp`/`input_tp` koko klipin yli + kovimman hetken kohdalla erikseen. **Opittu v2:ssa:** `alimiter` PITÄÄ ajaa `level=disabled`-optiolla — oletusarvoinen auto-level-korjaus voi nostaa signaalia takaisin yli oman kynnyksensä (nähtiin käytännössä: yksi variantti mittasi +0,85 dBTP eli aidon clip-riskin, vaikka ketjussa oli limitteri). "Ketjussa on limitteri" ei siis yksin riitä — jokainen ehdokas pitää mitata erikseen, ei olettaa. |
| 3 | **Tason tasaisuus pitkällä aikavälillä** | 1 | Kohtuullinen kavennus alkuperäisestä loudness rangesta (LRA), esim. 18,4 LU → n. 10–15 LU | `loudnorm`-mittauksen LRA koko klipin yli |
| 4 | **Tunnelma/dynamiikka säilyy — EI litistetä peliä monotoniseksi** | **3 (tärkein)** | Suurin osa alkuperäisestä hetkellisen äänekkyyden vaihtelusta säilyy — TAVOITE: momentary-loudness-hajonta (stdev) ja p90–p10-leveys pysyvät vähintään ~60–70 % alkuperäisen arvoista (baseline: stdev 7,14 LU, p90–p10 18,9 LU koko klipin yli). Jos hajonta romahtaa lähelle nollaa, lopputulos kuulostaa pumpatulta/tasapaksulta riippumatta siitä miltä se mittarilla muuten näyttää. **Lisätty v2-mittauskierroksen jälkeen:** pelkkä hajonta/spread ei riitä — seuraa myös **keskimääräisen tason nousua** (mean_M alkuperäiseen verrattuna). Aggressiivinen variantti voi säilyttää kohtuullisen suhteellisen hajonnan mutta silti kuulostaa "aina päällä" -väsyttävältä jos koko taso on nostettu montaa LUFS:ia ylös (nähtiin: +8,7 LU nousu, ks. demo.md 06). **Lisätty arnndn-kierroksen jälkeen:** hajonta/spread voi myös nousta väärästä syystä — jos hiljaiset kohdat vaimenevat lähes täydelliseen hiljaisuuteen (kohinaportin kaltainen käytös), tilastollinen spread kasvaa vaikka lopputulos kuulostaisi luonnottomalta "gatetulta" hiljaisuudelta pelin taustan sijaan. Tarkista siis AINA myös `calm_moment`-arvo suhteessa alkuperäiseen, ei pelkkää spreadia. | `ebur128`-momentaanisarja koko klipin yli (`parse_ebur128.py`), verrattuna alkuperäiseen; **plus** mean_M-erotus JA calm_moment-arvon erotus alkuperäiseen |
| 5 | **Luonnollisuus / ei kuultavia artefakteja** (pumppaus, "veden alla" -sointi, hakkaava kompressio) | 2 | Ei korvaan tarttuvia käsittelyn sivuvaikutuksia | **Ei luotettavasti mitattavissa automaattisesti** — subjektiivinen, kuunneltava nimenomaan maamerkkikohdista (ks. alla). Proxy: mitä aggressiivisemmat parametrit (korkea `maxgain`/`nr`/`ratio`), sitä suurempi riski — dokumentoitu jokaisen variantin kohdalla |
| 6 | **Pelitapahtumien erottuvuus** (pillit, huudot, lyönnin ääni kuuluvat yhä selvästi) | 1 | Käsittely ei saa hautaa itse pelin ääniä tasoituksen alle | Subjektiivinen, kuunneltava |
| 7 | **Yhteensopivuus selostuksen kanssa** | 1 | Selostus kuuluu läpi kentän hälystä, miksaus ei riko mitään | Ducking-demo (kuunneltava) + tekninen tarkistus ettei summa clippaa |
| 8 | **Tekninen yksinkertaisuus / livenä-turvallisuus** | 1 | Kevyt suodinketju, helposti pudotettavissa pois lennossa jos jokin menee pieleen | Suodinten määrä/tyyppi dokumentoitu, ei kaksivaiheista offline-analyysiä (kaikki suotimet toimivat yhden läpiajon striimissä) |

Pisteytysasteikko subjektiivisille kriteereille (5, 6, 7): **1 = huono/rikki,
3 = ok mutta huomauttamista, 5 = erinomainen**. Kriteeri 2 on portti — jos
mikään variantti clippaa, se hylätään suoraan riippumatta muista pisteistä.

## Miksi kriteeri 4 on painotettu näin raskaasti

Käyttäjän oma ehto: kenttäaudion parannuksen EI pidä lytistää pelin
tunnelmaa liian monotoniseksi lopputuotteeksi. Tekninen riski on todellinen:
edellisen demo-kierroksen "05-combo" (highpass+compressor+dynaudnorm+limiter
oletusarvoilla) pudotti LRA:n 18,4 → 8,3 LU eli **yli puolet** alkuperäisestä
vaihtelusta hävisi. Se voi mitata "hyvin" tasapainoisuuden kannalta (kriteeri
3) ja silti epäonnistua kriteerissä 4 — juuri tätä ristiriitaa tämä
kriteeristö on tarkoitettu tekemään näkyväksi, jotta valinta ei perustu
pelkkään "tasaisempi on parempi" -oletukseen.

## Maamerkkikohdat kuuntelua varten (koko 19 min lähdeklipistä)

Datavetoisesti tunnistettu `parse_ebur128.py`:llä ja matalataajuusskannauksella
alkuperäisestä (ei arvattu):

- **Kovin/äänekkäin hetki:** n. 17:20 (1040 s) — M-arvo −7,7 LUFS, todennäköisesti
  iso pelitilanne/kannustushuuto. Tämä on kriteerin 2 (clipping) ja 5
  (artefaktit kovan signaalin kohdalla) kannalta tärkein testikohta.
- **Tuulisin jakso:** n. 17:15 (1035 s) — matalataajuusenergia (<150 Hz)
  −15,5 dB, selvästi korkein koko klipistä. Samalla alueella kuin käyttäjän
  alun perin mainitsema ~15 min kohta (898 s) — tuuli jatkuu/voimistuu
  loppua kohti. Tärkein kohta kriteerille 1.
- **Rauhallisin/hiljaisin vakaa jakso:** n. 8:47 (527 s) — keskimääräinen
  M n. −37 LUFS, matala varianssi. Tärkein kohta kriteerille 4 (nouseeko
  tausta epäluonnollisen kuuluvaksi/kohisevaksi tässä kohdassa
  normalisoinnin takia?) ja 5 (afftdn/dynaudnorm-artefaktit kuuluvat
  useimmiten juuri hiljaisimmassa kohdassa).

Suositus: hyppää suoraan näihin kolmeen kohtaan jokaisessa full-length-
tiedostossa sen sijaan että kuuntelet koko 19 minuuttia joka variantista.
