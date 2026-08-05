# Ohjaamo — voimassa olevat päätökset

Mobiilikäyttöinen (iPhone Safari) ohjaussovellus, joka hoitaa koko
broadcast-produktion ketjun: ottelun valinta → YouTube-lähetysten luonti →
ajastus → relayn käynnistys ja valvonta → siivous.

Tässä ovat rakennepäätökset ja niiden perustelut — perustelut siksi, että ne
ovat se osa joka unohtuu ensin. **Vain voimassa olevat:** rakennusvaiheet,
ratkaistut avoimet kysymykset ja purettua välilehtirakennetta kuvanneet kohdat
on poistettu, koska niitä luettiin ohjeina. Käyttöliittymän nykyinen rakenne on
`README.md`:n "Käyttöliittymä: yksi tilakortti".

## Rajaus ja perusmalli

| Päätös | Valinta | Miksi |
|--------|---------|-------|
| Rinnakkaisuus | **Yksi lähetys kerrallaan + jono** | Yksi puhelin = yksi lähde. Relayn yksikkömalli säilyy, monimutkaisuus menee jonoon. |
| Työn yksikkö | **1 ottelu = 2 YouTube-lähetystä = 1 relay-ajo** | Uusi live joka pelille → jokaisesta pelistä jää katsottava tallenne. |
| Sijainti | **`apps/control` tässä monorepossa** | Tarvitsee `@pesisselostaja/core`n, `preflight.ts`:n ja relayn sopimuspinnan. Repo-rajan yli ne joko kopioituisivat tai jäätyisivät — ja silloin UI näyttäisi vihreää kun relay kaatuisi. |
| Prosessiraja | Oma systemd-unit, oma portti | Relay ajaa pinnatusta `~/relay-deploy`:sta; ohjaamon restart ei kosketa lähetystä. |
| Pääsy | **`tailscale serve` → tailnetin `*.ts.net`-HTTPS-osoite** | Oikea sertti = secure context = PWA kotivalikkoon, Web Push, Wake Lock. http-IP ei olisi kumpaakaan. Ei Funnelia: vain tailnet. |
| Frontend | **React + TypeScript + Vite** | Jatkuvasti päivittyvä tila. Tyylikieli peritään `apps/web`:n CSS:stä (#1C7A43, Archivo/Hanken Grotesk). |
| Tallennus | **JSON-tiedostot + NDJSON-lokit** | Sama idiomi kuin `.state-*.json`/`.control-*.json`. Kymmeniä töitä kaudessa — ei syytä skeemoille eikä natiiviriippuvuuksille. Tila luettavissa tiedostoselaimesta kun jokin on päin seiniä. |
| Suojaus | **Ei kirjautumista; tailnet on raja** | Kesken pelin ei ehdi kirjautua. |

## YouTube-ketju

- **Lähde ja kohde ovat samalla kanavalla, yksi Google-kirjautuminen.**
- **Kirjautuminen laitevirralla** (OAuth client: *TVs and Limited Input
  devices*). Ei paluuosoitetta eikä verkkotunnuksen omistusvahvistusta — emme
  omista `ts.net`-domainia, joten web-redirect voisi kaatua juuri siihen.
- **Ohjaamo luo molemmat lähetykset etukäteen.** Kuvauspuhelimen **Streamlabs
  käyttää YouTube-integraatiota** ja näyttää kanavan kaikki ajastetut
  lähetykset — kuvauksen alussa valitaan vain oikea listalta. Streamlabs ei siis
  luo lähetystä eikä tarvitse meiltä stream keytä; se kiinnittyy etukäteen
  luotuun. Ennakkoon luominen on tämän vuoksi **välttämätöntä, ei
  valinnaista**.
- **Vain selostettu lähetys saa meiltä stream keyn** — kertakäyttöinen striimi
  per lähetys (`isReusable: false`). Ohjaamo kirjoittaa avaimen työhön ja
  sieltä `.env.relay`:hin, joten avainten vaihtuminen ei maksa käsityötä.
  Raakalähetys luodaan **ilman striimiä** ja ilman autostartia.
- **Terveystarkistus** seuraa: tokenin ikä ja viimeisin onnistunut päivitys
  (7 vrk:n vanheneminen jos sovellus jää *Testing*-tilaan), myönnetyt scopet,
  **mikä kanava on valtuutettu** (väärä tili = lähetys väärälle kanavalle),
  sekä oma kiintiölaskuri (YouTube ei kerro jäljellä olevaa kiintiötä).
  Vanhenemisesta ja kiintiöstä lähtee **push**, ei arkin punainen rivi: token
  vanhenee ottelupäivien *välissä*, jolloin kukaan ei avaa ohjaamoa (#188).

## Ottelun valinta

`matches-list?date=` toimii millä tahansa päivämäärällä ja antaa kellonajan,
**kentän nimen ja numeron**, osoitteen, sarjan, lohkon, **seurojen logot** ja
`result`/`liveResult`-kentät. Yhtenä päivänä listalla on helposti 31 sarjaa ja
~200 ottelua, joten suodatus on pakollinen.

Reitit: **päivä → kenttä → ottelu** (pääreitti: olet päivän yhdellä kentällä),
sarja-/leiriselaus sekä URL tai ottelu-ID.

## Ajastus ja käynnistys

- **Laukaisu: lähde menee liveen → relay käynnistyy.** Käynnistysvahti pollaa
  YouTubea; kun Streamlabs alkaa työntää, ohjaamo ajaa valmiustarkistuksen ja
  käynnistää relayn. Nolla napautusta kentällä. Este pysäyttää käynnistyksen ja
  lähettää ilmoituksen.
- Koska raakalähetys luodaan **ajastettuna**, yt-dlp saa YouTubelta "alkaa N
  minuutin kuluttua" ja relay osaa odottaa kuluttamatta luovutusikkunaansa
  (`SourceNotLiveYetError`).
- **Törmäys** (B:n lähde menee liveen kun A on ajossa): B jää jonoon, **A ei
  katkea koskaan automaattisesti** (uptime first). Käynnistysvahti kertoo
  syyn — *"Ei jonossa olevia töitä — A on ajossa"* — eikä käynnistä mitään
  (`blockingJob`, `src/server/scheduler.ts`).
- **Häiriöt: ohjaamo korjaa itse ja kertoo tekonsa.** Turvalliset korjaukset
  (sidonta valittuun otteluun, käynnistysvahdin kytkeminen päälle, relayn
  uudelleenkäynnistys kun prosessi on kuollut mutta ottelu kesken) tehdään
  automaattisesti ja näytetään rivinä *"Korjattiin: …"*. Hiljaista
  itsekorjausta ei tehdä. Itsekorjautuvasta esteestä ei lähde pushia (#174).

## Metatiedot

- Otsikko ja kuvaus templaateista; **lopputulosta EI otsikkoon** — tallenteen
  katsoja ei halua spoileria.
- **Soittolistaan lisäys** automaattisesti, soittolista nimellä; soittolista
  luodaan jos puuttuu. PL-tunnistetta ei näytetä eikä kysytä (#176).
- **Thumbnail:** renderöijä piirtää tekstit pohjakuvan päälle, automaattinen
  fontin kutistus pitkille nimille. Esikatselu kutsuu samaa renderöijää →
  esikatselu on totuus.

## Relayn sopimuspinta

`run/` on symlinkattu ajokopiosta työpuuhun, joten ohjaamo lukee samat
tiedostot jotka ajossa oleva relay kirjoittaa:

- **Telemetria:** `status-<ID>.json` (atominen snapshot joka pollilla) ja
  `timeline-<ID>.ndjson` (havaittu → syntetisoitu → puhuttu, virheet,
  respawnit). Relay on lähde, ohjaamo lukee eikä päättele (#97).
- **Lokitasot ja pysyvät tapahtumakoodit** (`ffmpeg.respawn`,
  `source.not_live`, …) journaldiin.
- **Ohjaus:** `.env.relay` ja `run/.control-<ID>.json`. Näitä on kaksi eikä
  kolmatta rakenneta (#59) — relayn ajokopio voi olla ohjaamoa vanhempi.

Uudet tiedostokuviot on lisättävä `runRetention.ts`:ään, muuten ne joko
kasaantuvat tai jäävät siivoamatta.

## Ei toteutettu

Nämä ovat suunniteltuja mutta rakentamatta. Ne ovat tässä siksi, ettei niitä
kuvitella olevan olemassa:

- Control-avaimet **mykistys/tauko**, **äänenvoimakkuus lennossa** ja **oma
  selostus puhuttavaksi**. Ottelunaikaisia säätöjä on kaksi: selostuksen
  ajoitus ja vaihtoselostus (#186).
- **Lukumerkit (chapters)** ottelun jälkeen ja **ajoraportti**.
- **Törmäyksen purku yhdellä napautuksella** ("lopeta A, aloita B"). Jono
  estää, mutta vaihtoa ei tarjota.
- **Menneiden videoiden hallinta** (lista, katselukerrat, eräajona muokkaus,
  poisto) ja **passkey-suojaus tuhoaville toimille**.
- **ElevenLabs-osio** (kiintiömittari, kulutus per lähetys).
