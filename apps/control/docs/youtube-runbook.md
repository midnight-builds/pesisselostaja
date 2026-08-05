# Pesis AI — YouTube ajastuksen master-ohje

Last updated: 2026-07-17

> **Luettava näin (issue #124, päivitetty 5.8.2026):** tämä tiedosto on
> **kanoninen lähde lähetysten SISÄLLÖLLE** — nimeämismallit, kuvaukset,
> thumbnail-käytäntö, jaettavan viestin muoto, tilit ja aikakäsittely.
> `src/server/templates.ts` ja `test/templates.test.ts` tarkistavat kaavat tätä
> vasten, joten älä muuta kaavoja päivittämättä niitä.
>
> **Työnkulku ei ole tässä tiedostossa eikä missään ohjeessa: se on ohjaamon
> käyttöliittymässä.** Operaattori valitsee ottelun tilakortista, napauttaa
> "Luo lähetyspari" kahdesti, ja ohjaamo tekee kaikki alla kuvatut vaiheet
> itse — otsikot, kuvaukset, thumbnailit, molemmat lähetykset, soittolistan ja
> jakoviestin. **Älä aja näitä vaiheita käsin agenttina** äläkä palauta
> stream keytä käyttäjälle: käsikentät poistettiin käyttöliittymästä (#176),
> ja jos huomaat kopioivasi stream keytä, olet varapolulla.
>
> Varapolku — vain kun ohjaamo tai sen Google-valtuutus ei toimi — on
> `/relay-ottelu`-taidon osio **V5 (käsikierros Studiossa)**. Sama taito ei ole
> ottelupäivän ajotapa vaan varapolku. Ketjun termit: repon juuren `CONTEXT.md`.

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

Nämä ovat ohjaamon omia — operaattori ei kosketa niihin, eikä niitä lueta
käsin ottelupäivänä. Kaikki asuu `apps/control/run/`-hakemistossa
(`CONTROL_STATE_DIR`):

- OAuth-token: `google-token.json`. Valtuutus uusitaan huoltoarkin
  laitevirralla, ei tiedostoa muokkaamalla.
- Työt (ottelu, lähetyspari, stream key, siivous): `jobs.json`.
- Thumbnail-tausta: `apps/control/assets/pesaysit-bg-raw-001.png`.

Aiemmat `/root/clawd/...`-polut kuuluivat ulkopuoliselle palvelulle, jonka
korvaaminen oli #124:n koko tavoite. Ne ovat poissa; älä palauta niitä.

## Lahdeaineisto

- `pesistulokset.fi`-ottelulinkki tai joukkueen ottelulista kelpaa lahteeksi.
- Kalenterimerkintaa ei vaadita, jos ottelu voidaan vahvistaa luotettavasti `pesistulokset.fi`-lahteesta.

## Aikakasittely

- Kaikki kayttajan antamat otteluajat ja `pesistulokset.fi`-sivulta luetut otteluajat ovat Suomen paikallisaikaa.
- Kayta lahteen kellonaikaa sellaisenaan. Ala siirra aikaa UTC:n, selaimen aikavyohykkeen tai palvelimen kellon perusteella.
- Kun ajat vietaan YouTube API:lle, anna skriptille sama paivamaara ja kellonaika seka oletusvyohyke `Europe/Helsinki`. Skripti tekee vain API:n vaatiman teknisen ISO/UTC-esityksen.
- Kayttajalle, thumbnailiin, otsikkoon, kuvaukseen ja jaettavaan viestiin palautetaan aina alkuperainen paikallisaika, esimerkiksi `15.7.2026 klo 13:30`.

## Mitä luonti tekee

**Tämä ei ole tarkistuslista ajettavaksi.** Luonnin tekee ohjaamo yhtenä tekona
(`createBroadcastPair`, `src/server/youtube.ts`) kun operaattori napauttaa
"Luo lähetyspari". Osio kuvaa mitä siinä syntyy, jotta alla olevat
sisältösäännöt on helppo sijoittaa oikeaan kohtaan.

**Lähtötiedot** tulevat tulospalvelun ottelusta, eivät kyselemällä: joukkue ja
sarja, vastustaja, päivämäärä ja kellonaika, pelipaikka, kaupunki otsikkoa
varten, tapahtuma, vaihe ja soittolista. Soittolista valitaan **nimellä**,
automaattisesti — PL-tunnistetta ei näytetä eikä kysytä (#176).

**Esikatselu on pysyvästi näkyvissä** tilakortissa ennen luontia: otsikot,
alkamisaika ja thumbnail sellaisina kuin ne YouTubeen syntyvät. Se ei ole
erillinen hyväksymisvaihe eikä siinä ole rastia — vahvistus on itse
kaksoisnapautus, koska luonti on peruuttamaton ja ulospäin näkyvä (#171).
Jos joukkue, vastustaja tai paikka pitää kirjoittaa vakiintuneeseen muotoon,
se tehdään "Muokkaa otsikkoa" -taitoksessa ennen luontia.

**Syntyvä pari** on aina molemmat lähetykset kerralla:

- **raakalähetys** omalla stream keyllään StreamLabsia varten, ja
- **selostettu lähetys**, johon relay työntää: otsikon alussa sana
  `Selostettu`, sama kuvaus, oma thumbnail-variantti badgella
  `Selostettu tekoälyllä` vasemmassa yläkulmassa, oma streami ja stream key,
  sekä `enableAutoStart=true` ja `enableAutoStop=true`.

`enableAutoStart` **ei ole kytkettävissä päälle jälkikäteen** — siksi se
asetetaan luonnissa. Ilman sitä selostettu lähetys jää tilaan *"Waiting for
stream"* vaikka relay pushaa oikein.

**Thumbnail** renderöidään aina taustasta
`apps/control/assets/pesaysit-bg-raw-001.png`. Vanhoja taustoja, joissa on
valmiina aiempien pelien tekstejä, ei käytetä koskaan.

**Stream key kirjoittuu työhön, ei viestiin.** Sitä ei palauteta operaattorille
eikä sitä kopioida mihinkään: relayn sidonnan tekee ohjaamo. Jos puuttuva
stream key jää huomaamatta, seuraus on #162 — siksi puuttuva
`liveStreams.list`-rivi on virhe eikä hiljainen null (#184).

**Jakoviesti** muodostuu samalla, kolmella linkillä: raakalähetys, selostettu
lähetys ja tulospalvelun ottelusivu. Muoto on osiossa "Jaettava viesti".

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

## Missä koodi on

Ulkopuolisen palvelun skriptejä (`/root/clawd/tools/...`) ei enää ole. Sama työ
tehdään ohjaamossa:

- Lähetysparin luonti ja soittolista: `src/server/youtube.ts`
- Otsikot, kuvaukset ja soittolistan valinta: `src/server/templates.ts`
  (kaavat tarkistetaan `test/templates.test.ts`:ssä tätä ohjetta vasten)
- Thumbnailin renderöinti ja badge: `src/server/thumbnail.ts`

**Selostetun lähetyksen ingest-tietoja (RTMP URL, backup URL, video id, stream
key) ei palauteta käyttäjälle.** Ne kirjoittuvat työhön ja ohjaamo sitoo relayn
niillä itse. Käsin kopiointi kuuluu vain varapolulle V5, ja se on vika, joka
kuuluu kirjata.

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

Erillistä luontilokia ei kirjoiteta. Työ itse **on** kirjaus: ottelu,
molempien lähetysten video-id:t ja katselu-URLit, stream key, suunniteltu
alkuaika, soittolista ja siivouksen tiedot elävät `apps/control/run/jobs.json`
-tiedostossa, ja ohjaamon loki (huoltoarkin takana) kantaa tapahtumakoodit.

## Turvasaanto

- Ala poista tai muuta olemassa olevia videoita haitallisesti ilman erillista vahvistusta.
- Thumbnail-paivitykset ovat ok, kun ne on pyydetty tai kuuluvat normaaliin luontiin.
- **Raakalähetykseen ei kirjoiteta ottelun ollessa kesken.** Ainoa sallittu
  kirjoitus on hard stopin siivous päättyneen ottelun jälkeen (#123), ja sen
  tekee ohjaamo — ei agentti käsin.
