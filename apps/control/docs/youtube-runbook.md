# Pesis AI — YouTube ajastuksen master-ohje

Last updated: 2026-07-17

> **Luettava näin (issue #124, 30.7.2026):** tämä tiedosto on yhä **kanoninen
> lähde lähetysten SISÄLLÖLLE** — nimeämismallit, kuvaukset, thumbnail-käytäntö,
> jaettavan viestin muoto, tilit ja aikakäsittely. `src/server/templates.ts` ja
> `test/templates.test.ts` tarkistavat kaavat tätä vasten, joten älä muuta
> kaavoja päivittämättä niitä.
>
> **TYÖNKULKU sen sijaan on ohjaamon**, ei tämän tiedoston eikä ulkopuolisen
> palvelun. Alla oleva "Workflow"-osio ja tiedostopolut (`/root/clawd/...`)
> kuvaavat maailmaa ennen ohjaamoa. Ottelupäivän ajaminen: `/relay-ottelu`
> (polku A = ohjaamo, polku B = käsityö poikkeuksena). Ketjun termit:
> repon juuren `CONTEXT.md`.

Tama on kanoninen yhden tiedoston ohje Pesä Ysit -YouTube-ajastuksiin.
Jos muu ohje on ristiriidassa taman kanssa, noudata tata tiedostoa.

## Tarkoitus

Kayttoprofiili on yksinkertainen:
- ajastetaan yksittaisia peleja
- joskus ajastetaan muutama leiripeli samalta paivalta
- kayttajia on kaytannossa yksi

Siksi ohje pidetaan yhtena master-ohjeena, jossa on:
- workflow
- vakioasetukset
- nimeamis- ja kuvausmallit
- thumbnail-kaytanto
- selostus-version lisavaihe
- palautettava jaettava viesti

## Tilit ja perustiedot

- Kanava: `Talonkuningas`
- Handle: `@talonkuningas`
- ChannelId: `UC4oXm9z5eNyh1snqGsRqcnw`
- Omistajatili: `talonkuningas@gmail.com`

## Tiedostot

- OAuth env: `/root/clawd/integrations/youtube/.env`
- OAuth token: `/root/clawd/integrations/youtube/token.json`
- Luontiloki: `/root/clawd/brain/pesis-ai/logs/youtube-created.jsonl`
- Hyvaksytty thumbnail-tausta: `/root/.openclaw/media/pesaysit-bg-raw-001.png`

## Lahdeaineisto

- `pesistulokset.fi`-ottelulinkki tai joukkueen ottelulista kelpaa lahteeksi.
- Kalenterimerkintaa ei vaadita, jos ottelu voidaan vahvistaa luotettavasti `pesistulokset.fi`-lahteesta.

## Aikakasittely

- Kaikki kayttajan antamat otteluajat ja `pesistulokset.fi`-sivulta luetut otteluajat ovat Suomen paikallisaikaa.
- Kayta lahteen kellonaikaa sellaisenaan. Ala siirra aikaa UTC:n, selaimen aikavyohykkeen tai palvelimen kellon perusteella.
- Kun ajat vietaan YouTube API:lle, anna skriptille sama paivamaara ja kellonaika seka oletusvyohyke `Europe/Helsinki`. Skripti tekee vain API:n vaatiman teknisen ISO/UTC-esityksen.
- Kayttajalle, thumbnailiin, otsikkoon, kuvaukseen ja jaettavaan viestiin palautetaan aina alkuperainen paikallisaika, esimerkiksi `15.7.2026 klo 13:30`.

## Workflow

### 1. Poimi ottelutiedot

Tarvittavat kentat:
- joukkue / sarja
- vastustaja
- paivamaara
- kellonaika
- tarkka pelipaikka
- kaupunki tai lyhyt paikkamuoto titlea varten
- tapahtuma
- vaihe
- oikea soittolista

### 2. Esita tekstit ennen luontia

Ennen kuin mitaan luodaan, nayta kayttajalle:
- otsikkoehdotus
- soittolista
- kuvaus
- thumbnail-tekstit

Odota vahvistus.

### 3. Renderoi thumbnail-preview

- Kayta aina taustaa `/root/.openclaw/media/pesaysit-bg-raw-001.png`.
- Ala koskaan kayta vanhoja taustoja, joissa on valmiiksi aiempien pelien teksteja.
- Laheta preview kayttajalle hyvaksyttavaksi ennen YouTube-luontia.

### 4. Luo normaali ajastus

- Luo ensin normaali YouTube-ajastus.
- Aseta thumbnail.
- Kirjaa tiedot lokiin.

### 5. Palauta kayttajalle kaksi viestia

Laheta aina erikseen:
- onnistumisviesti + YouTube-linkki + mahdolliset huomiot
- valmis copy-paste jaettava viesti

Tama vaihe on pakollinen, sita ei saa jattaa valista.

### 6. Kysy selostus-versiosta

Kun normaali ajastus on valmis, kysy aina:

`Tehdaanko myos selostettu versio?`

Jos vastaus on kylla:
- luo toinen ajastus samalle ottelulle
- kayta samaa kuvausta
- renderoi selostetulle oma thumbnail-variantti
- lisaa vasempaan ylareunaan badge `Selostettu tekoälyllä`
- lisaa otsikon alkuun sana `Selostettu`
- luo ajastukselle oma streami / stream key
- laita selostetulle broadcastille `enableAutoStart=true` ja `enableAutoStop=true`

Sen jalkeen palauta kayttajalle:
- RTMP URL
- backup URL
- video id
- Stream Key

`watchUrl` on hyodyllinen lisa, mutta nuo nelja ovat pakolliset.

Palautusviestin vakiorunko on:

```text
YouTube: <youtube-linkki>
YouTube selostettu: <selostettu-youtube-linkki>
Tulospalvelu: <pesistulokset-linkki>

Broadcast:
Otsikko: <selostetun broadcastin otsikko>
RTMP URL: <primary ingestion url>
Backup URL: <backup ingestion url>
Video ID: <broadcast id>
Stream Key: <stream name>
```

## Otsikointisaannot

### Yleinen kaava

Kanavan nykyinen toimiva muoto on:

`<Pesa Ysit joukkue/sarja> - <vastustaja>, <pvm> <lyhyt paikka>`

Esimerkki:

`Pesä Ysit E-tytöt kilpa - Hyvinkään Tahko, 15.7.2026 Tenavaleiri Kempele`

Jos otsikko uhkaa venya liian pitkaksi mobiilinakaymaa tai YouTuben merkkirajaa ajatellen, pitkia joukkue- tai seuranimia saa lyhentaa yleisesti tunnettuun muotoon.

Esimerkkeja:
- `Seinäjoen Maila-Jussit` -> `SMJ`
- `Hyvinkään Tahko` -> `Tahko`

Lyhennys tehdään ensisijaisesti otsikkoon. Kuvauksessa voi tarvittaessa pitaa tayden nimen.

### Leiripelit

- Otsikossa kayta lyhytta paikkamuotoa.
- Tarkkaa kenttanimea ei tarvitse otsikkoon, ellei kayttaja erikseen pyydä.
- Jos kayttaja haluaa muun lyhyen paikkamuodon, se ohittaa oletuksen.

Esimerkkeja:
- `Kempele`
- `Tenavaleiri Kempele`

### Selostus-versio

Selostus-version otsikko on sama kuin normaalin, mutta alkuun lisataan:

`Selostettu `

Esimerkki:

`Selostettu Pesä Ysit E-tytöt kilpa - Hyvinkään Tahko, 15.7.2026 Tenavaleiri Kempele`

## Kuvausmalli

Kuvauksessa pidetaan tarkka pelipaikka.
Kuvaukseen lisataan aina myos suora `pesistulokset.fi`-ottelulinkki.

Rakenne:

```text
Ottelu: <kotijoukkue> - <vierasjoukkue>
Päivä: <d.m.yyyy> klo <HH:MM>
Paikka: <tarkka kenttä>, <kaupunki>
Tapahtuma: <tapahtuma>
Vaihe: <vaihe>
Tulospalvelu: <pesistulokset-linkki>
#pesäpallo #pesäysit #live #livestream ...
```

Selostus-versiossa kuvaus on sama kuin normaalissa versiossa.

## Thumbnail-saannot

### Vakiosaannot

- Kayta vain kanonista taustaa `/root/.openclaw/media/pesaysit-bg-raw-001.png`.
- Ala muuta itse taustakuvaa.
- Ala kayta vanhaa `pesäpallo + crossed bats` -ikonia.

### Leiripelit

Thumbnailissa riittaa lyhyt, selkea tieto:
- vastustaja tai lyhyt ottelupari
- pvm + kellonaika
- lyhyt paikkamuoto

Esimerkkiasettelu:
- rivi 1: `Tahko - Pesä Ysit`
- rivi 2: `15.7.2026 klo 13:30`
- rivi 3: `Tenavaleiri Kempele`

### Selostus-versio

- kayta samaa pohjaa ja samoja paateksteja kuin normaalissa thumbnailissa
- lisaa vasempaan ylareunaan musta badge tekstilla `Selostettu tekoälyllä`
- pida oikean ylareunan `LIVE` badge ennallaan
- ala muuta kanonista taustakuvaa; renderoi aina erillinen uusi tiedosto

## Soittolistat 2026

- G: `Pesä Ysit G 2026` -> `PLRxzlzu4-aUMrFdCP3Z98zaPKfRfSS2FQ`
- E: `Pesä Ysit E 2026` -> `PLRxzlzu4-aUMy_J6dnRTQmjAmEYNNtpad`
- F: `Pesä Ysit F 2026` -> `PLRxzlzu4-aUMN4kmuRM5fQ8Zrotzv_uNK`
- D: `Pesä Ysit D 2026` -> `PLRxzlzu4-aUNSLP3iNS8bGiY_dL0jnXnl`

Kaikki vuoden 2026 videot kuuluvat oikeaan ika-luokan 2026-soittolistaan.

## Skriptit

### Normaali ajastus

- Broadcast: `/root/clawd/tools/youtube-create-broadcast.js`
- Thumbnail render: `/root/clawd/tools/pesaysit-render-thumbnail.sh`
- Thumbnail upload: `/root/clawd/tools/youtube-set-thumbnail.js`

### Selostus-versio

- Broadcast + oma streami: `/root/clawd/tools/youtube-create-broadcast-with-stream.js`
- Thumbnail render: `/root/clawd/tools/pesaysit-render-thumbnail.sh --selostettu`
- Thumbnail upload: `/root/clawd/tools/youtube-set-thumbnail.js`

## Selostus-version palautettavat tiedot

Kun selostettu versio on luotu, palauta kayttajalle ainakin:

```text
RTMP URL: <primary ingestion url>
Backup URL: <backup ingestion url>
Video ID: <broadcast id>
Stream Key: <stream name>
```

Tarvittaessa voit lisata myos:
- `YouTube: <watchUrl>`
- `Stream ID: <liveStream id>`

## Jaettava viesti

### Yksi peli

Kun peleja on vain yksi, kayta tiivista formaattia:

```text
Kuvaan tänään klo <HH:MM> <joukkueen/sarjan> pelin: <ottelupari>. Alla linkit:
YouTube: <youtube-linkki>
YouTube selostettu: <selostettu-youtube-linkki>
Tulospalvelu: <pesistulokset-linkki>

Broadcast:
Otsikko: <selostetun broadcastin otsikko>
RTMP URL: <primary ingestion url>
Backup URL: <backup ingestion url>
Video ID: <broadcast id>
Stream Key: <stream name>
```

### Useampi peli samalta paivalta

```text
Kuvaan tänään <joukkue/ryhmä> <paikkakunnalla/tapahtumassa>.

Klo <HH:MM> <Kotijoukkue> - <Vierasjoukkue>
YouTube: <youtube-linkki>
YouTube selostettu: <selostettu-youtube-linkki>
Tulospalvelu: <pesistulokset-linkki>

Broadcast:
Otsikko: <selostetun broadcastin otsikko>
RTMP URL: <primary ingestion url>
Backup URL: <backup ingestion url>
Video ID: <broadcast id>
Stream Key: <stream name>
```

Listaa ottelut aikajarjestyksessa.

## Lokitus

Kirjaa luodut broadcastit tiedostoon:

`/root/clawd/brain/pesis-ai/logs/youtube-created.jsonl`

Tallenna mahdollisuuksien mukaan:
- `createdAtUtc`
- `videoId`
- `watchUrl`
- `title`
- `scheduledLocal`
- `thumbnail`
- `sourceMatchId`
- `sourceMatchUrl`
- mahdollinen `streamId` selostus-versiolle

## Turvasaanto

- Ala poista tai muuta olemassa olevia videoita haitallisesti ilman erillista vahvistusta.
- Thumbnail-paivitykset ovat ok, kun ne on pyydetty tai kuuluvat normaaliin luontiin.
