# Aamun 29.7.2026 ohje

Yön aikana rakennettu ohjaamo on ajossa. **Relayn koodiin ei ole koskettu:**
ajokopio `~/relay-deploy` on yhä commitissa `bbd3baf`, `apps/broadcast` on
nollamuutoksissa ja palvelu oli `inactive` koko yön. Aamun lähetys ajaa siis
täsmälleen samaa koeteltua koodia kuin eilen.

## Osoite

**https://codexsrv.tail6875ae.ts.net/** — aito sertti, näkyy vain tailnetissä.

## Aamun kulku (8:30, Pesä Ysit – Imatran Pallo-Veikot)

Työ on jo luotu ja odottaa Työ-välilehdellä: **ottelu 145889**, Naperoleiri
F-poikien sarja, Liperin kirkonkylän kenttä 4.

1. Luo YouTube-lähetykset kuten ennenkin (Studiossa tai vanhalla skriptillä).
   **YouTube-automaatio ei ole aamun polulla** — se odottaa Google-tunnuksia.
2. Ohjaamo → **Työ**-välilehti:
   - **LÄHDE — YouTube-URL**: puhelimen oman lähetyksen katselu-URL
   - **KOHDE — stream key**: selostetun lähetyksen avain
   - (LÄHDE luetaan, KOHTEESEEN pushataan. Lomake varoittaa tästä.)
3. **Kirjoita .env.relay** → **Aja preflight** → **Käynnistä relay**.
   Käynnistysnappi on lukossa niin kauan kuin preflightissa on esteitä.
4. **Live**-välilehti kertoo lopun. Jos selostus tulee väärään kohtaan, käytä
   isoja nappeja *Puhui liian aikaisin* / *liian myöhään* (±500 ms).

Lopetus kuten ennen: älä pysäytä kesken ottelun, kuollut lähde voi palata.

## Kaksi asiaa jotka on hyvä tietää

**ElevenLabsissa on ~11 700 merkkiä eli noin kaksi ottelua.** Sinulla on
huomenna kuusi Pesä Ysit -peliä (8:30, 9:30, 12:30, 13:30, 13:30 ja 18:00
Naisten Ykköspesis). Loput menisivät Piperillä — ääni vaihtuu kuuluvasti.

**Push-ilmoitukset vaativat kotivalikkoasennuksen.** Safari → Jaa → *Lisää
kotivalikkoon* → avaa kuvakkeesta → Live-välilehti → *Ota ilmoitukset
käyttöön* → **lähetä testi-ilmoitus ennen ottelua**, ei sen aikana.

## Streamlabs-kytkentä — vastattu 29.7.2026

**Kuvauskännykässä on Streamlabs YouTube-integraatiolla, ja se näyttää kaikki
kanavan ajastetut lähetykset.** Kuvauksen alussa valitaan vain oikea listalta.
Streamlabs ei siis luo lähetystä, vaan kiinnittyy etukäteen luotuun — eli
UI:n ennakkoon luoma lähdelähetys on täsmälleen oikea ratkaisu, ei turha.

Tämä vahvistaa myös sen, että **API:lla luodut lähetykset näkyvät puhelimen
listassa**: nykyinen käsityökulku käyttää jo YouTube Data API v3:a
(`tools/youtube-create-broadcast.js`, jaettu 28.7. paketissa) ja toimii.
Erillistä koeajoa ei tarvita.

Oletus on siis lukittu, ja `src/server/youtube.ts` toteuttaa sen jo oikein:

- **Normaali lähetys** luodaan **ilman omaa striimiä** ja
  `enableAutoStart/-Stop: false` — Streamlabs tuo oman striiminsä ja käynnistää.
  Me emme koskaan anna sille stream keytä.
- **Selostettu lähetys** saa oman kertakäyttöisen striimin
  (`liveStreams.insert` → `bind` → `liveStreams.list`) ja
  `enableAutoStart/-Stop: true`, koska relay työntää siihen automaattisesti.

## Google-yhteys (kun ehdit)

Tunnukset ovat toisella koneella polussa `/root/clawd/integrations/youtube/`.
**Nopein tie:** kopioi arvot kahteen tiedostoon `apps/control/run/`-hakemistoon:

```
google-client.json  {"clientId":"<GOOGLE_CLIENT_ID>","clientSecret":"<tai null>"}
google-token.json   {"refreshToken":"<token.json: refresh_token>",
                     "scope":"https://www.googleapis.com/auth/youtube",
                     "obtainedAt":"2026-07-28T00:00:00.000Z","lastRefreshAt":null}
```

Sen jälkeen `GET /api/youtube/health` kertoo heti kanavan — **varmista että
siinä lukee Talonkuningas / UC4oXm9z5eNyh1snqGsRqcnw.** Väärä tili tarkoittaisi
lähetystä väärälle kanavalle.

Pidemmän päälle kannattaa tehdä oma laitevirta-client (*TVs and Limited Input
devices*) ja **julkaista sovellus In production -tilaan** — Testing-tilassa
refresh token vanhenee 7 vuorokaudessa ja yhteys katkeaisi kesken lähetyksen.
Terveystarkistus varoittaa tästä 6 vrk:n kohdalla.

## Mitä on valmiina

Vaihe A kokonaan (ottelunvalinta, `.env.relay`, preflight, relayn ohjaus,
live-näkymä, ajonaikaiset ohjaimet, loki, push-ilmoitukset) sekä Vaihe B:stä
YouTube-moduuli, templaatit ja thumbnail-renderöinti — **kaikki ilman yhtään
kirjoittavaa YouTube-kutsua**, koska tunnuksia ei ole koneella.

Testit: 108 yksikkötestiä ja 92 selaintestiä (WebKit + Chromium).
`npx vitest run apps/control` ja `npm run test:ui -w @pesisselostaja/control`.

## Vielä tekemättä (vaihe B)

Relayn telemetria (`status-<ID>.json` + `timeline-<ID>.ndjson`), lokitasot ja
pysyvät tapahtumakoodit, kaksivaiheinen selostuslista, uudet control-avaimet
(mykistys, äänenvoimakkuus, oma selostus), ajastus ja jono, jälkityöt
(lukumerkit, soittolista, ajoraportti), ElevenLabs-osio ja passkey-suojaus.

Nämä vaativat muutoksia `apps/broadcast`iin ja siten `npm run relay:deploy` —
**ei ennen kuin päivän lähetykset ovat ohi.**
