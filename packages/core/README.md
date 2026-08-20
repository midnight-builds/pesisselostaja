# @pesisselostaja/core

Puhdas domain-logiikka: tyypit, pesistulokset-API-asiakas, puheteksti, pisteiden
laskenta ja ääntämiskorvaukset. **Ei localStoragea, ei fs:ää, ei DOMia** — kaikki
sovelluskohtainen elää `apps/`-puolella.

## API-pinta (pesistulokset)

Kirjattu tänne, koska se löytyi aiemmin vain lukemalla `src/api.ts`, ja yhden
curl-testin kokoaminen maksoi viisi työkalukutsua (issue #70).

**Base:** `https://api.pesistulokset.fi/api/v1` (`ApiOptions.apiBase` ohittaa)

### Avain vaaditaan vain osaan endpointeista

Tämä on epäsymmetria, joka kannattaa tietää ennen kuin epäilee 403:a omaksi
virheekseen. Todennettu curlilla 30.7.2026:

| Polku | Avain | Ilman avainta |
|---|---|---|
| `/public/**` | `?apikey=<avain>` **pakollinen** | `403` |
| `/online/**` | ei käytetä lainkaan | `200` |

Oletusavain on `src/api.ts`:ssä ja **tarkoituksella versionhallinnassa**: repo on
julkinen, ja avain on julkisen lukurajapinnan tunniste eikä salaisuus. Sen voi
ohittaa `ApiOptions.apiKey`:llä.

### Endpointit

| Funktio | Polku |
|---|---|
| `fetchMatchMetadata(matchId)` | `GET /public/match?id=<id>&apikey=<avain>` |
| `fetchLiveMatches({ date })` | `GET /public/matches-list?date=<YYYY-MM-DD>&apikey=<avain>` |
| `fetchTodayMatches()` | sama, päivä = tänään Suomen aikaa |
| `fetchLiveEvents(matchId, opts)` | `GET /online/<id>/events[?after=…][&skip-delay=true]` |

### Kokeile käsin

```bash
B=https://api.pesistulokset.fi/api/v1
K=wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9

curl -s "$B/online/145905/events" | head -c 400          # tapahtumat, ei avainta
curl -s "$B/public/match?id=145905&apikey=$K" | head -c 400
curl -sD- -o /dev/null "$B/online/145905/events" | grep -i '^etag\|^date'
```

### Kokoonpano: `players[].number` EI ole pelinumero

`/public/match`in `players[].number` on **lyöntijärjestyksen paikka hakuhetkellä**,
ei pelinumero: jokaisessa neljässä tutkitussa kokoonpanossa se on `1..N`
`players`-listan järjestyksessä. `players` on lyöntijärjestys, `all_players`
koko rinki (esim. 11 vs. 14) — erotus sisältää mm. jokerin, jolle listalla ei
ole nimeä lainkaan. `players[].defensive_position` on `null` tasan niillä, jotka
eivät ole kentällä.

**Metadata ei seuraa ottelunaikaista muutosta.** Ottelussa 136765 tapahtumavirta
sisälsi kaksi `substitution`-tapahtumaa, jotka järjestivät paikat 7–11 uusiksi,
mutta `/public/match` palautti yhä ottelua edeltävän järjestyksen vielä ottelun
päätyttyä haettuna. **Ainoa luotettava lähde järjestykselle on tapahtumavirta**,
jonka `newLineUp`-taulukon indeksi *on* uusi paikka. Järjestys voi muuttua myös
kesken vuoroparin, ei vain jaksotauolla (operaattorin vahvistus 6.8.2026).

Koodissa tätä ylläpitää `PlayerLookup.slotOf` / `byTeamSlot` (`speech.ts`), joka
rakennetaan metadatasta ja päivitetään `collectLineupChanges` + `withLineups`
-parilla joka pollilla. Issue #241.

### Kolme käyttäytymistä, jotka yllättävät

- **`/online/<id>/events` palauttaa aina koko historian tapahtumasta 0 alkaen**,
  ei ikkunaa — myös `after`-parametrilla, joka vain karsii vanhemmat pois
  vastauksesta. Älä koskaan päättele mitään siitä että `events.length === 0`.
- **Julkinen syöte on ~2 min jäljessä**; `skip-delay=true` antaa reaaliaikaisen.
  Relay käyttää sitä aina.
- **Avaamaton ottelu palauttaa paljaan `[]`:n** eikä `{"events": […]}`-kuorta
  (havaittu livenä 17.7.2026). `fetchLiveEvents` normalisoi tämän, mutta oma
  curl-kokeilu näyttää raakamuodon.

### Delta-haku

`after` + `If-None-Match` yhdessä: muuttumaton vastaus on `304` ilman runkoa.
Aikaleiman muoto on Helsingin paikallisaika (`formatHelsinkiTimestamp`), ja sen
välilyönti on koodattava `%20`:na — `URLSearchParams` tuottaa `+`:n, jota API ei
hyväksy. `fetchLiveEvents` rakentaa kyselyn siksi käsin.

Vastauksen `Date`-otsake on seuraavan `after`-arvon perusta: tapahtumilla ei ole
omaa seinäkelloaikaa. Delta-haun kokonaislogiikka (kursori, reset-vastaukset,
katkaisija) on `apps/broadcast/README.md`:ssä.

## Muualla dokumentoitu

- **Pisteiden ja jaksojen malli** (yksi merkintä = yksi juoksu, `event.period`):
  repon juuren `CLAUDE.md`, osio "Scoring".
- **Pesäpallotermit** (palo, tuoja, lyöntipisteet): `CLAUDE.md`, "Terminology".
- **Lähetysketjun termit** (raakalähetys, selostettu lähetys, ajastushetki):
  `CONTEXT.md`.
- **Ääntämiskorvaukset**: `CLAUDE.md`, "TTS pronunciation".
