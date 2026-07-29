# @pesisselostaja/control — Ohjaamo

Mobiilikäyttöinen (iPhone Safari) ohjaussovellus, jolla koko broadcast-tuotanto
hoidetaan puhelimesta: ottelun valinta, relayn elinkaari, live-valvonta ja
YouTube-ketju. Suunnitelma ja päätösten perustelut: `DESIGN.md`.

## Miksi tämä on oma palvelunsa

- **`apps/web` julkaistaan GitHub Pagesiin.** Hallinta ei voi olla siellä: se
  näkee stream keyt ja OAuth-tokenit.
- **Relay ajaa pinnatusta ajokopiosta `~/relay-deploy`.** Ohjaamo ajaa
  työpuusta, joten sen uudelleenkäynnistys ei kosketa käynnissä olevaa
  lähetystä — ohjaamoa saa päivittää kesken ottelun.
- **Ohjaamo ei ole lähetyksen elinehto.** Jos se kaatuu, relay jatkaa. Kaikki
  ohjaus menee tiedostojen kautta (`.env.relay`, `run/.control-<ID>.json`),
  ei prosessien välisenä yhteytenä.

## Ajaminen

```bash
npm run build -w @pesisselostaja/control     # client → dist/client
systemctl --user restart pesisselostaja-control.service
systemctl --user is-active pesisselostaja-control.service
```

Unit-tiedosto on `ops/pesisselostaja-control.service` (kopioi
`~/.config/systemd/user/`). Palvelin kuuntelee porttia 3002; pääsy tapahtuu
`tailscale serve`n kautta osoitteessa `https://codexsrv.tail6875ae.ts.net/`.
HTTPS ei ole koristetta: ilman sitä iOS ei anna asentaa sovellusta
kotivalikkoon eikä salli push-ilmoituksia.

## Testit

```bash
npm run test:ui -w @pesisselostaja/control                      # WebKit + Chromium
npm run test:ui -w @pesisselostaja/control -- --project=webkit  # vain Safarin moottori
npm run test:ui -w @pesisselostaja/control -- --headed --project=webkit
```

Selain­testit (`test-ui/`, Playwright) ajetaan **WebKitillä ensisijaisesti** —
kohde on iPhonen Safari, 393×853. Ne kattavat ulkoasun (ei vaakavieritystä,
kosketuskohteiden koot, live-näkymän lukittu järjestys, kontrastit, pitkät
joukkuenimet) ja toiminnan (välilehdet, ottelunvalinta, työn lomake,
preflight-portti, kaksoisvahvistus, viivenapit, lokisuodatin, SSE-katko).

Testit käynnistävät oman palvelimen porttiin **3099** ja ohjaavat kaikki
kirjoitukset hakemistoon `.playwright-tmp/` (`CONTROL_STATE_DIR`,
`CONTROL_RELAY_ENV`, `CONTROL_RELAY_RUN_DIR`, `CONTROL_RELAY_UNIT`,
`CONTROL_DEPLOY_DIR`). **Ne eivät koske oikeaan `.env.relay`-tiedostoon eivätkä
oikeaan relay-yksikköön** — annettua unit-nimeä ei ole olemassa. `/api/**` on
mockattu ja `EventSource` korvattu testien ohjaamalla tuplalla; sivun tarjoaa
silti oikea palvelin, koska juuri staattisen tarjoilun rikkoutuminen (tyhjä
kuori) on tämän sovelluksen kertaalleen sattunut vika. Kuvakaappaukset:
`test-results/screenshots/`.

Yksikkötestit (`test/`, vitest) ajetaan erikseen.

## Rakenne

| Polku | Vastuu |
|-------|--------|
| `src/shared/` | Palvelimen ja clientin **sitova sopimus** (`types.ts`, `api.ts`). Muutos täällä rikkoo typecheckin molemmilla puolilla — se on tarkoitus. |
| `src/server/` | node:http-palvelin, SSE, JSON-tallennus, relay-ohjaus, pesistulokset-haut |
| `src/client/` | React + Vite -käyttöliittymä. Kaikki viisi näkymää ovat **jatkuvasti mountattuina** (`App.tsx`, `TabPanel`); välilehti vain valitsee näytettävän. Näkymän oma tila (Ottelut-suodattimet ja rastit, lokitaso, valittu työ) säilyy siis välilehteä vaihtaessa. Testeissä tämä tarkoittaa, että useassa näkymässä esiintyvä teksti pitää rajata näkymään (`view(page, "job")`). |
| `tools/` | `pesaysit-thumbnail-compose.py` — thumbnailin PIL-komposiitti |
| `docs/` | Nykyisen YouTube-työnkulun kanoniset ohjeet ja templaatit |
| `assets/` | Operaattorin brändimedia + PWA-kuvakkeet. **Ei gitissä** (repo on julkinen). |
| `run/` | Ajonaikainen tila (työt, asetukset). Ei gitissä. |

## Push-ilmoitukset

Ilmoitukset lähetetään palvelimelta selaimen push-palvelun kautta (`web-push`,
ainoa ajonaikainen riippuvuus — VAPID-JWT ja hyötykuorman salaus ovat kryptoa,
jota ei kirjoiteta itse). Neljä laukaisijaa, kaikki kytkettävissä pois
live-näkymän **Ilmoitukset**-kortista:

| Laukaisija | Ehto |
|-----------|------|
| Lähetys rikki | `health` on ollut `fail` yhtäjaksoisesti 60 s |
| Automaattinen korjaus | `notifyAutoFix()` — rajapinta valmiina, kutsuja tulee vaiheessa B |
| Valmistelu ja käynnistys | relay siirtyi ajoon, tai preflightissä oli esteitä |
| Lähetys päättyi | relay siirtyi pois ajosta kun työ oli aktiivinen |

Ilmoitus lähtee vain **tilan muutoksesta**, ei joka pollilla, ja sama aihe
enintään kerran 10 minuutissa (`src/server/notifications.ts`). Liika
ilmoittelu tarkoittaa, että käyttäjä lakkaa lukemasta niitä.

Tila levyllä: `run/vapid.json` (avainpari, luodaan kerran — **älä poista**, se
mitätöi kaikki tilaukset), `run/push-subscriptions.json` (laitteet; vanhentuneet
poistuvat itsestään kun push-palvelu vastaa 404/410) ja `run/push-prefs.json`.

**iPhonella ilmoitukset toimivat vasta kun sovellus on lisätty
kotivalikkoon** — se on iOS:n vaatimus, ei tämän sovelluksen. Jaa-painike →
"Lisää koti­valikkoon", avaa kuvakkeesta, ja vasta sitten "Ota ilmoitukset
käyttöön". Luvan kysely vaatii käyttäjän napautuksen. Testinappi lähettää
oikean push-ilmoituksen, jotta ketjun voi todeta toimivaksi kentällä ennen
ottelua.

## Suhde relayhin

Ohjaamo **ei muuta relayn koodia**. Se kirjoittaa kaksi tiedostoa ja lukee
kolmea lähdettä:

- kirjoittaa `apps/broadcast/.env.relay` (vain ottelukohtaiset avaimet;
  `ELEVENLABS_API_KEY` ja `RELAY_URL_REFRESH_MS` säilytetään koskemattomina)
- kirjoittaa `apps/broadcast/run/.control-<ID>.json` (relay lukee joka pollilla)
- lukee `systemctl --user show`, `journalctl --user -u`, ja pesistulokset-API:n

### `sourceIngest` — lähteen tila YouTube-API:sta (#104 vaihe 1)

Ohjaamo on ainoa jolla on Google-tunnukset, joten se katsoo lähteen puolesta ja
relay lukee. Relay **ei** kysy Googlelta itse: kaksi refresh_tokenin päivittäjää
rikkoisi authin kesken ottelun, eikä lähetyksen jatkuminen saa riippua
Google-yhteydestä.

30 s välein ohjaamo hakee lähdelähetyksen `lifeCycleStatus`in
(`liveBroadcasts.list`) ja siihen sidotun syötteen `streamStatus`in
(`liveStreams.list`), ja kirjoittaa havainnon control-tiedoston
`sourceIngest`-avaimeen (`observedAt`, `videoId`, tilat raakoina merkkijonoina,
`error`). Arvot julkaistaan sellaisinaan — **päätös kuuluu relaylle, ei
ohjaamolle**. Vain `streamStatus === "active"` tarkoittaa että dataa virtaa;
`null` ja vanhentunut `observedAt` tarkoittavat *ei tietoa*, eivät *poikki*.

Vaiheessa 1 relay ohittaa avaimen: käytös ei muutu. Vaihe 2 lukee sen ja
vaihtaa katvekuvaan.

Pollaus on portitettu tiukasti — työ tilassa `arming`/`live`, relay-yksikkö
ajossa **ja relayn oma telemetria (`run/status-<ID>.json`) kertoo että se ajaa
juuri tätä ottelua**, lähde-URL jäsentyy eikä ole sama kuin kohdevideo, Google-
token tallennettu, kiintiötä yli varauksen. Portin sulkeutuminen ei ole vika
vaan normaali lepotila, ja se näkyy ohjaamon Lähde-rivillä syynä.

`run/` on symlinkattu ajokopiosta työpuuhun, joten ohjaamo näkee samat
tiedostot jotka ajossa oleva relay kirjoittaa.

## Vaiheet

**Vaihe A (tehty ensin):** ottelun valinta, `.env.relay`, preflight, relayn
käynnistys/pysäytys/uudelleenkäynnistys, live-näkymä ilman relay-muutoksia,
ajonaikaiset ohjaimet nykyisillä control-avaimilla.

**Vaihe B, tehty 29.7.:** Google-auth ja YouTube-osio omalla välilehdellään
(yhteys, lähetysparin luonti, menneet videot), thumbnailit, sekä ajastimen
kortti Työ-välilehdellä. Ajastin pysyy **oletuksena pois päältä**: kortti
näyttää `wouldHaveDone`-kuivaharjoituksen, ja päälle kytkeminen vaatii
vahvistuksen. YouTube-osiota ei ole vielä ajettu oikeita tunnuksia vasten —
Google Cloud -projekti ja OAuth-client puuttuvat.

**Vaihe B, relayn telemetria (29.7.):** relay kirjoittaa nyt
`run/status-<ID>.json`n ja `run/timeline-<ID>.ndjson`n, ja jokainen lokirivi
kantaa pysyvää tapahtumakoodia ja oikeaa tasoa (syslog-prioriteetti
journaldiin). `journal.ts`:n sanahaku on kutistunut varajärjestelmäksi, joka
koskee enää koodittomia rivejä — eli vanhempia relay-buildeja, joita journald
yhä säilöö. **Vaatii `npm run relay:deploy`n** ennen kuin ohjaamo näkee
koodeja.

**Vaihe B, yhä tekemättä:** kaksivaiheinen selostuslista (tämä on nyt
mahdollinen — timeline erottaa havaitun, syntetisoidun ja puhutun), uudet
control-avaimet (mykistys, äänenvoimakkuus, oma selostus), jono, jälkityöt,
ElevenLabs-osio ja passkey-suojaus.

Vaiheen B relay-muutokset vaativat `npm run relay:deploy` — ja se kieltäytyy
ajamasta lähetyksen aikana. Se on tarkoituksellinen este, ei vika.
