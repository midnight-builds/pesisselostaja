# Pesisselostaja Control — suunnitelma

Mobiilikäyttöinen (iPhone Safari) ohjaussovellus, joka hoitaa koko
broadcast-produktion ketjun: ottelun valinta → YouTube-lähetysten luonti →
ajastus → relayn käynnistys ja valvonta → jälkityöt.

Syntynyt grillauksesta 29.7.2026 00:00–00:30. Jokainen alla oleva päätös on
käyttäjän vahvistama; perustelut ovat mukana, koska ne ovat se osa joka
unohtuu ensin.

---

## Rajaus ja perusmalli

| Päätös | Valinta | Miksi |
|--------|---------|-------|
| Rinnakkaisuus | **Yksi lähetys kerrallaan + jono** | Yksi puhelin = yksi lähde. Relayn nykyinen yksikkömalli säilyy, monimutkaisuus menee jonoon. |
| Työn yksikkö | **1 ottelu = 2 YouTube-lähetystä = 1 relay-ajo** | Uusi live joka pelille → jokaisesta pelistä jää katsottava tallenne. |
| Sijainti | **Uusi `apps/control` tässä monorepossa** | Tarvitsee `@pesisselostaja/core`n, `preflight.ts`:n ja relayn sopimuspinnan. Repo-rajan yli ne joko kopioituisivat tai jäätyisivät — ja silloin UI näyttäisi vihreää kun relay kaatuisi. |
| Prosessiraja | Oma systemd-unit, oma portti | Relay ajaa pinnatusta `~/relay-deploy`:sta; ohjauspalvelun restart ei kosketa lähetystä. |
| Pääsy | **`tailscale serve` → `https://codexsrv.tail6875ae.ts.net/`** | Oikea sertti = secure context = PWA kotivalikkoon, Web Push, Wake Lock. http-IP ei olisi kumpaakaan. Ei Funnelia: vain tailnet. |
| Frontend | **React + TypeScript + Vite** | Kahdeksan näkymää jatkuvasti päivittyvällä tilalla. Tyylikieli peritään `apps/web`:n CSS:stä (#1C7A43, Archivo/Hanken Grotesk). |
| Tallennus | **JSON-tiedostot + NDJSON-lokit** | Sama idiomi kuin `.state-*.json`/`.control-*.json`. Kymmeniä töitä kaudessa — ei syytä skeemoille eikä natiiviriippuvuuksille. Tila luettavissa tiedostoselaimesta kun jokin on päin seiniä. |
| Suojaus | Ei kirjautumista; **Face ID (passkey) tuhoaviin toimiin** | Tailnet on raja, eikä kesken pelin ehdi kirjautua. Videon poisto / lähetyksen katkaisu / auth-yhteyden purku vaativat tunnistuksen. Stream keyt peitossa napautuksen takana. |

## YouTube-ketju

- **Lähde ja kohde ovat samalla kanavalla, yksi Google-kirjautuminen.**
- **Kirjautuminen laitevirralla** (OAuth client: *TVs and Limited Input
  devices*). Ei paluuosoitetta eikä verkkotunnuksen omistusvahvistusta — emme
  omista `ts.net`-domainia, joten web-redirect voisi kaatua juuri siihen.
- **UI luo molemmat lähetykset etukäteen.** Puhelimella kuvataan
  **Streamlabsilla**, joka on RTMP-enkooderi → se työntää lähteen stream
  keyhin. Etukäteen luotu lähetys on siis täsmälleen se mitä se haluaa.
- **Uusi stream key per lähetys** (ei uudelleenkäytettävää striimiä). UI hoitaa
  kopioinnin, joten avainten vaihtuminen ei maksa käsityötä.
- **Terveystarkistus** seuraa: tokenin ikä ja viimeisin onnistunut päivitys
  (7 vrk:n vanheneminen jos sovellus jää *Testing*-tilaan), myönnetyt scopet,
  **mikä kanava on valtuutettu** (väärä tili = lähetys väärälle kanavalle),
  sekä oma kiintiölaskuri (YouTube ei kerro jäljellä olevaa kiintiötä).
- **Menneet videot:** lista + katselukerrat + linkit, metatietojen muokkaus
  jälkikäteen (myös eränä), soittolistat, sekä poisto/piilotus (vahvistus +
  Face ID).

## Ottelun valinta

`matches-list?date=` toimii millä tahansa päivämäärällä ja antaa kellonajan,
**kentän nimen ja numeron**, osoitteen, sarjan, lohkon, **seurojen logot** ja
`result`/`liveResult`-kentät. Tänään listassa oli 31 sarjaa / ~200 ottelua,
joten suodatus on pakollinen.

Neljä reittiä: **päivä → kenttä → rastita ottelut** (pääreitti: olet päivän
yhdellä kentällä, ja yhdellä kertaa syntyy monta työtä), sarja-/leiriselaus,
URL/ottelu-ID, sekä suosikkijoukkueet etusivulla.

## Ajastus ja käynnistys

- **Laukaisu: lähde menee liveen → relay käynnistyy.** UI pollaa YouTubea;
  kun Streamlabs alkaa työntää, UI ajaa preflightin ja käynnistää relayn.
  Nolla klikkiä kentällä. Preflightin este estää käynnistyksen ja lähettää
  ilmoituksen.
- Koska UI luo lähdelähetyksen **ajastettuna**, yt-dlp saa YouTubelta "alkaa N
  minuutin kuluttua" ja relay osaa jo nyt odottaa kuluttamatta
  luovutusikkunaansa (`SourceNotLiveYetError`).
- **Törmäys** (B:n lähde menee liveen kun A on ajossa): B jää jonoon, **A ei
  katkea koskaan automaattisesti** (uptime first). Ilmoitus jossa yhden napin
  "lopeta A, aloita B".
- **Häiriöt: UI korjaa itse ja kertoo jälkikäteen.** Turvalliset korjaukset
  (relayn uudelleenkäynnistys kun prosessi on kuollut mutta ottelu kesken,
  delta→täyshaku oireiden perusteella) tehdään automaattisesti ja niistä tulee
  push-ilmoitus. Kaikki toimet jäävät aikajanalle.

## Metatiedot

- Otsikko ja kuvaus templaateista; **lopputulosta EI otsikkoon** — tallenteen
  katsoja ei halua spoileria.
- **Lukumerkit (chapters) kuvaukseen** ottelun jälkeen, **neutraalisti
  nimettyinä** ("2. jakso", "Kotiutus — JoMa", "Kolmas palo"), ei pisteitä.
  Ajastus on likimääräinen (video- ja API-viive).
- **Soittolistaan lisäys** automaattisesti; soittolista luodaan jos puuttuu.
- **Ajoraportti** talteen: kesto, selostuksia, respawnit, virheet,
  ElevenLabs-merkit, deployattu commit.
- **Thumbnail: PIL** piirtää tekstit pohjakuvan päälle, automaattinen fontin
  kutistus pitkille nimille. Esikatselu kutsuu samaa renderöijää → esikatselu
  on totuus. Seurojen logot ovat saatavilla API:sta jos ne halutaan mukaan.
  *(Pohjakuva ja templaattien nykyiset muodot vielä saamatta.)*

## Live-näkymä

Ilman vierittämistä: **iso terveystila + syy** ("Lähetys kunnossa, 42 min" /
"ffmpeg respawnasi 2× viime minuutissa"), **pelitilanne** (pisteet, jakso,
palot), **viimeisimmät selostukset** (rivi ilmestyy kun tapahtuma havaitaan,
korostuu kun se puhutaan), ja **statusruudukko** (lähde / relay / jono / kohde
/ API:t) napautettavina.

## Relayn muutokset

| Muutos | Vaihe |
|--------|-------|
| **Telemetria run/-tiedostoihin**: `status-<ID>.json` (atominen snapshot joka pollilla) + `timeline-<ID>.ndjson` (havaittu → syntetisoitu → puhuttu, virheet, respawnit) | B |
| **Lokitasot + pysyvät tapahtumakoodit** (`ffmpeg.respawn`, `source.not_live`, …), 90 kutsupaikkaa | B |
| Uusi control-avain: **mykistys/tauko** | B |
| Uusi control-avain: **äänenvoimakkuus lennossa** — toteutus PCM-skaalauksena `narrationFifo`ssa, EI ffmpeg-filtterin muutoksena (gain on nyt `volume=` käynnistyksessä) | B |
| Uusi control-avain: **oma selostus puhuttavaksi** (`run/.say-<ID>.ndjson`, loop tyhjentää joka pollilla) | B |
| **±500 ms viivenapit** — toimii jo nyt olemassa olevalla `narrationDelayMs`-avaimella | A |

`run/` on symlinkattu ajokopiosta työpuuhun, joten ohjaussovellus lukee samat
tiedostot jotka ajossa oleva relay kirjoittaa. Uudet tiedostokuviot on
lisättävä `runRetention.ts`:ään, muuten ne joko kasaantuvat tai jäävät
siivoamatta.

## Rakennusjärjestys

**Vaihe A — valmiina 29.7. klo 8:30 mennessä.** Relayn koodiin ei kosketa;
ajokopio pysyy commitissa `bbd3baf`. Aamun lähetys ajetaan **käsin luoduilla
YouTube-lähetyksillä** (Google-automaatio ei ole aamun polulla).

1. `apps/control`-palvelu (node:http + SSE), JSON-tallennus, systemd-unit,
   `tailscale serve` https, PWA-manifesti
2. Ottelun valinta pesistulokset-API:sta (päivä → kenttä → rastitus)
3. Lähteen URLin ja stream keyn syöttö → `.env.relay`:n kirjoitus
4. Preflight napista (`runPreflight` sellaisenaan) + tulosten esitys
5. Relayn käynnistys / pysäytys / uudelleenkäynnistys (`systemctl --user`)
6. Live-näkymä ilman relay-muutoksia: systemd-tila, journald, YouTube-tila,
   pesistulokset-tapahtumat, levy/CPU/RAM
7. Ajonaikaiset ohjaimet nykyisillä control-avaimilla + ±500 ms -napit
8. Push-ilmoitukset (rikki / valmistelu ja käynnistys / korjaus tehty /
   päättyi)

**Vaihe B — aamun lähetyksen jälkeen.** Relay-telemetria ja lokikoodit,
kaksivaiheinen selostuslista, uudet control-avaimet, Google-auth + koko
YouTube-osio, thumbnailit, ajastus ja jono, jälkityöt, ElevenLabs-osio
(kiintiömittari + kulutus per lähetys), passkey-suojaus, menneiden videoiden
hallinta.

## Avoimet asiat

- Thumbnail-pohjakuva ja nykyiset otsikko-/kuvausmuodot saamatta
- Aamun 8:30 ottelu yksilöimättä (UI:n ottelunvalinta ratkaisee tämän itse)
- Google Cloud -projekti ja OAuth-client luomatta (vaatii käyttäjän, ~10 min)
