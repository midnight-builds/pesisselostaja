# Pesisselostaja — sanasto

Yksi lähetysketju: ohjaamo ajastaa YouTube-lähetykset, relay miksaa selostuksen,
katsojat saavat linkit. Tämä sanasto määrittelee ketjun käsitteet niin, ettei
"lähde" tai "ajastus" tarkoita eri asiaa eri dokumentissa.

`apps/web` on tämän ulkopuolella — ks. **Selainkuuntelija**.

## Roolit

**Operaattori**:
Ohjaamoa käyttävä henkilö: valitsee ottelun, ajastaa lähetysparin, käynnistää ja
ohjaa relayta, valvoo lähetystä ja siivoaa sen jälkeen. Ainoa rooli joka koskee
ohjaamoa.

**Kuvaaja**:
Henkilö joka pystyttää kuvauspuhelimen, **käynnistää** siitä StreamLabsin ennen
ottelua ja **lopettaa** sen ottelun päätyttyä. Molemmat ovat normaali tapa, jolla
raakalähetys alkaa ja loppuu; ohjaamon ja relayn hard stop -keinot ovat
erikoistilanteita varten, eivät oletus. Ottelun aikana kuvaaja ei ole
kuvauspuhelimen luona.

Operaattori ja kuvaaja **voivat olla sama henkilö tai eri henkilöt** — kumpaakaan
ei saa olettaa. Käytännössä se tarkoittaa, ettei ohjaamo voi olettaa operaattorin
ylettävän kuvauspuhelimeen, eikä myöskään sitä ettei hän ylettäisi.

**Katsoja**:
Jakoviestin linkistä YouTube-lähetystä seuraava henkilö. Katsoo joko
raakalähetystä tai selostettua lähetystä.

**Selainkuuntelija**:
`apps/web`-sovelluksen käyttäjä: avaa julkisesti GitHub Pagesissa olevan
web-sovelluksen omalla laitteellaan ja **kuulee** selostuksen selaimestaan, ilman
videota.

Selainkuuntelija ei ole osa lähetysketjua. `apps/web` on periaatteessa oma
projektinsa, eikä sitä käytetä YouTube-lähetyksiin lainkaan; se on samassa
repossa siksi, että rajapinta tulospalveluun, sen tulkinta ja selostustekstien
muodostus ovat samat (`packages/core`). Kun mietit muutoksen vaikutuksia, kysy
kumpaa käyttäjää se koskee — vastaus on usein vain toinen.
_Vältä_: "katsoja" selainkuuntelijasta (hän ei katso mitään).

## Laitteet

Ketjussa on **kaksi puhelinta**, ja ne ovat eri ihmisen kädessä eri paikassa.
Paljas "puhelin" ei siksi kerro mitään — käytä aina jompaakumpaa näistä.
(Selainkuuntelijan laite ei ole kumpikaan näistä eikä sitä nimetä: se voi olla
mikä tahansa.)

**Kuvauspuhelin**:
Kentällä kolmen metrin tolpan päässä oleva puhelin, jonka StreamLabs työntää
raakalähetystä. **Ei operoitavissa ottelun aikana** — kaikki mitä siltä
tarvitaan on tehtävä ennen kuin se nousee tolppaan.
_Vältä_: paljas "puhelin"/"kännykkä", "kuvaajan puhelin" (kuvaaja ei ole sen
luona ottelun aikana).

**Operaattorin puhelin**:
Operaattorin oma laite, jolla ohjaamoa käytetään: ajastus, relayn käynnistys ja
ohjaus, live-valvonta, push-ilmoitukset. Kun dokumentti sanoo "ohjaamoa
käytetään puhelimella kentän laidalla", se tarkoittaa tätä.
_Vältä_: paljas "puhelin"/"kännykkä".

## Lähetykset ja linkit

**Raakalähetys**:
Kuvauspuhelimen StreamLabsista tuleva YouTube-lähetys sellaisenaan, ilman
selostusta. Jaetaan katsojille siinä missä selostettukin. Relay lukee videonsa
tästä.
_Huom_: ohjaamopolulla raakalähetyksen **luo ohjaamo**, ei kuvauspuhelin —
StreamLabs vain poimii sen kanavan lähetyslistasta ja työntää siihen. "Puhelimen
oma live" on siksi harhaanjohtava kuvaus.
_Vältä_: "lähdelähetys", "lähde-URL", pelkkä "lähde" ilman määrettä,
"piilotettu lähetys" (väärin — linkki jaetaan katsojille).

**Selostettu lähetys**:
YouTube-lähetys, johon relay työntää raakalähetyksen videon selostuksella
miksattuna. Katsojille näkyvä "pääkanava".
_Vältä_: pelkkä "kohde" ilman määrettä, "kohdelähetys", ja ennen kaikkea
**"normaali"** raakalähetyksestä — se väittää selostetun olevan epänormaali eikä
kerro kummastakaan mitään.

**Pari ja lyhytmuodot.** Lähetyksiä on kaksi ja ne ovat aina tämä pari:
`raakalähetys` ↔ `selostettu lähetys`. Kun tila on tiukalla (kenttien otsikot,
taulukot, välilehdet), lyhytmuodot ovat **`raaka`** ↔ **`selostettu`** — molemmat
määreitä, joten pari pysyy symmetrisenä.

Koodin englanninkieliset tunnisteet **eivät** noudata tätä, tarkoituksella:
`sourceUrl`/`RELAY_YOUTUBE_URL`/`normal` = raakalähetys, `target*`/`narrated` =
selostettu lähetys. Ne on jätetty rauhaan, koska nimeäminen uusiksi koskisi
`.env.relay`-muuttujaa, työjonon levylle kirjoitettua JSONia ja telemetriaa —
se olisi datamigraatio, ei termisiivous. Älä siis "korjaa" niitä; korjaa
suomenkielinen teksti niiden ympärillä.

**Tulospalvelun ottelusivu**:
Ottelun sivu pesistulokset.fi:ssä (`matchId`). Tapahtumadatan ja selostuksen
sisällön lähde — dataa, ei videota. Ilmoitetaan usein URL-muodossa, mikä on
syy välttää paljasta "lähde-URL"-termiä.
_Vältä_: "lähde" videomerkityksessä tästä puhuttaessa.

**Jakoviesti**:
Katsojille jaettava viesti, jossa kolme linkkiä: raakalähetys, selostettu
lähetys ja tulospalvelun ottelusivu.

## Ottelupäivän hetket

**Ajastushetki**:
Hetki jolloin ajastus *tehdään*: molemmat YouTube-lähetykset luodaan ja työ
kirjataan työjonoon (esim. edellisenä iltana). Molempien lähetysten
katselu-URLit syntyvät tällöin.
_Vältä_: "ajastushetki" merkityksessä "kun toimet alkavat ennen ottelua" —
se on käynnistysikkuna.

**Suunniteltu alkuaika**:
Ottelun ilmoitettu alkuhetki tulospalvelun datassa. Kiintopiste, josta
käynnistysikkuna lasketaan.

**Käynnistysikkuna**:
Suunniteltua alkuaikaa edeltävä jakso, jonka aikana ohjaamo vahtii
raakalähetystä ja käynnistää relayn heti kun kuvaaja aloittaa lähetyksen.

**Lopetus**:
Se, miten lähetysketju päättyy. Oletus on yksi ketju: kuvaaja sulkee
StreamLabsin → raakalähetys päättyy → relay havaitsee sen ja sammuu itse →
YouTube sulkee selostetun lähetyksen omalla AutoStopillaan. Ohjaamo ei lopeta
mitään; se siivoaa vasta jälkikäteen.

**Tämä on oletus, ei ainoa tapa, eikä ketju pääty aina kokonaisena.**
Raakalähetys, relayn ajo, selostettu lähetys ja työ päättyvät kukin erikseen ja
voivat päättyä eri syistä — raakalähetys myös yllättäen (akku, verkko, puhelin
kaatuu), relayn ajo myös luovutukseen tai hard stopiin, ja työ kirjautuu
päättyneeksi tai peruuntuneeksi sen mukaan ehtikö relay käynnistyä.

Älä siis kirjoita "kun ottelu loppuu, …" ilman että kerrot **mikä** loppuu ja
**miten**. Syyt luetellaan tyhjentävästi kahdessa paikassa, ei täällä:
`SourceEndReason` (`packages/core/src/types.ts`) relayn ajolle ja `closedStatus`
(`apps/control/src/server/jobs.ts`) työlle. Molemmat on kirjoitettu niin, että
uusi arvo kaataa käännöksen — sanasto ei voisi luvata samaa.

**Luovutusikkuna**:
Aika, jonka relay yrittää saada **yllättäen** katkennutta raakalähetystä
takaisin ennen kuin se luovuttaa ja sammuu. Yllätyksellisyys on olennaista:
hallittu lopetus tunnistetaan omakseen eikä sitä yritetä palauttaa. Katve
luovutusikkunan sisällä **ei ole lopetus** — selostettu lähetys pysyy pystyssä
sen ajan.

**Hard stop**:
Ohjaamon tai relayn tekemä sammutus silloin kun normaalia lopetusta ei tullut:
ottelu on päättynyt, uusia tapahtumia ei tule ja raakalähetys oireilee (#123).
Erikoistilanne, ei vaihtoehtoinen oletus — ja ainoa tilanne jossa ohjaamo saa
kirjoittaa raakalähetykseen.

## Muualla määritelty

Pesäpallotermit (palo, tuoja, vuorossa/lyömässä, lyöntipisteet) on määritelty
CLAUDE.md:n Terminology-osiossa.
