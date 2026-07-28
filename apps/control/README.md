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

## Rakenne

| Polku | Vastuu |
|-------|--------|
| `src/shared/` | Palvelimen ja clientin **sitova sopimus** (`types.ts`, `api.ts`). Muutos täällä rikkoo typecheckin molemmilla puolilla — se on tarkoitus. |
| `src/server/` | node:http-palvelin, SSE, JSON-tallennus, relay-ohjaus, pesistulokset-haut |
| `src/client/` | React + Vite -käyttöliittymä |
| `tools/` | `pesaysit-thumbnail-compose.py` — thumbnailin PIL-komposiitti |
| `docs/` | Nykyisen YouTube-työnkulun kanoniset ohjeet ja templaatit |
| `assets/` | Operaattorin brändimedia + PWA-kuvakkeet. **Ei gitissä** (repo on julkinen). |
| `run/` | Ajonaikainen tila (työt, asetukset). Ei gitissä. |

## Suhde relayhin

Ohjaamo **ei muuta relayn koodia**. Se kirjoittaa kaksi tiedostoa ja lukee
kolmea lähdettä:

- kirjoittaa `apps/broadcast/.env.relay` (vain ottelukohtaiset avaimet;
  `ELEVENLABS_API_KEY` ja `RELAY_URL_REFRESH_MS` säilytetään koskemattomina)
- kirjoittaa `apps/broadcast/run/.control-<ID>.json` (relay lukee joka pollilla)
- lukee `systemctl --user show`, `journalctl --user -u`, ja pesistulokset-API:n

`run/` on symlinkattu ajokopiosta työpuuhun, joten ohjaamo näkee samat
tiedostot jotka ajossa oleva relay kirjoittaa.

## Vaiheet

**Vaihe A (tehty ensin):** ottelun valinta, `.env.relay`, preflight, relayn
käynnistys/pysäytys/uudelleenkäynnistys, live-näkymä ilman relay-muutoksia,
ajonaikaiset ohjaimet nykyisillä control-avaimilla.

**Vaihe B:** relayn telemetria (`run/status-<ID>.json` + `timeline-<ID>.ndjson`),
lokitasot ja pysyvät tapahtumakoodit, kaksivaiheinen selostuslista, uudet
control-avaimet (mykistys, äänenvoimakkuus, oma selostus), Google-auth ja koko
YouTube-osio, thumbnailit, ajastus ja jono, jälkityöt.

Vaiheen B relay-muutokset vaativat `npm run relay:deploy` — ja se kieltäytyy
ajamasta lähetyksen aikana. Se on tarkoituksellinen este, ei vika.
