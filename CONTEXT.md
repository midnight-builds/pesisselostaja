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
ohjaamo sulkee selostetun lähetyksen **hallitusti** (#153). Raakalähetykseen
ohjaamo ei tässä koske: se päättyi jo itse, ja juuri siitä relay tiesi sammua.

**Hallittu lopetus** on nimenomaan tämä: ohjaamo transitoi selostetun
lähetyksen `complete`ksi laskevalla reunalla, kun relayn telemetria kertoo sekä
`endReason === "ended"` että `match.finished`. Ehto vaatii molemmat, koska
kesken ottelun kuollut raakalähetys antaa myös `ended`in — ja liian aikainen
`complete` katkaisisi elävän lähetyksen katsojilta. Kun ehto ei täyty, kohteen
sulkee YouTuben oma AutoStop kuten ennenkin; se on peräytymistie, ei oletus,
koska katsojalle AutoStopin lopetus ei erotu katkosta.

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

Pituuksia on kaksi. **Ottelun ollessa kesken ikkuna on pitkä** (oletuksena 12
min): keskeytynyt ottelu jatkuu yleensä, ja katsojille on parempi että relay
odottaa. **Ottelun päätyttyä ikkuna on lyhyt** (oletuksena 2 min): kun ottelu on
ohi, kadonnutta lähdettä ei kannata jäädä odottamaan. Koodissa ja englanniksi
sama asia on `giveUpWindowMs` / *give-up window*.

**Olennaisin kohta: ikkunaa tarkastellaan vain yrityksen yhteydessä, ei kellon
mukaan.** Relay ei katso ajastinta ja luovuta hetkellä X. Se yrittää avata
lähteen uudelleen, ja *vasta silloin* se laskee, kuinka pitkään epäonnistuminen
on jatkunut. Jos yritysten väli on venynyt minuutteihin (ks. **Perääntyminen**),
12 minuutin ikkuna voi umpeutua vasta reilusti myöhemmin — luovutus tapahtuu
seuraavalla yrityksellä, ei sillä sekunnilla kun ikkuna teoriassa täyttyi.
Suunta on turvallinen, koska katkennut lähde ehtii palata, mutta **ikkunan
pituus ei ole lupaus siitä, milloin relay sammuu**.

**Hard stop**:
Ohjaamon tai relayn tekemä sammutus silloin kun normaalia lopetusta ei tullut:
ottelu on päättynyt, uusia tapahtumia ei tule ja raakalähetys oireilee (#123).
Erikoistilanne, ei vaihtoehtoinen oletus — ja ainoa tilanne jossa ohjaamo saa
kirjoittaa raakalähetykseen.

## Valvonta ja hälytykset

**Kohdevahti**:
Ohjaamon toiminto, joka kysyy YouTubelta noin puolen minuutin välein, onko
selostettu lähetys yhä elossa. Se on olemassa siksi, ettei relay voi tietää sitä
itse: RTMP-työntö onnistuu myös kuolleeseen lähetykseen, joten relayn mielestä
kaikki on kunnossa samalla kun katsojat eivät näe mitään. Näin kävi 16.8.2026
(ottelu 136771) — YouTuben autostop päätti selostetun lähetyksen kesken ottelun,
relay työnsi loppuottelun tyhjään, ja asia selvisi vasta käsin tarkistamalla.
Vahti huomaa kaksi eri kuolemaa: YouTuben päättämän lähetyksen ja käsin
poistetun lähetyksen, jota ei enää löydy kanavalta lainkaan.

**Kohdevahti vain lukee; se ei korjaa mitään.** Se ei kirjoita YouTubelle eikä
luo uutta lähetystä. Havainto menee tilakortille, otsikkoon ja
push-ilmoitukseen, ja korjaus jää operaattorille. (#250, #252)

**Vaimennuslukko**:
Lippu, joka menee päälle kun hälytys on kerran annettu, ja vaimentaa saman
hälytyksen toistumisen. Ilman sitä yksi vika piippaisi operaattorin puhelimessa
joka pollikierroksella — kerran puolessa minuutissa koko loppuottelun ajan —
eikä yksikään piippaus kertoisi mitään uutta.

Lukko **ei purkaudu ajan kulumisesta**. Se aukeaa vain tietystä tapahtumasta:
siitä, että vikajakso todella päättyy — esimerkiksi siitä, että työlle on luotu
uusi selostettu lähetys entisen kuolleen tilalle. Vertaa palovaroittimeen, jonka
hiljennys ei raukea itsestään vaan vasta kun koko laite vaihdetaan.

**Ongelma syntyy, jos purkavaa tapahtumaa ei voi saada aikaan.** Kohdevahdin
lukko aukeaa vasta kun työn selostettu lähetys vaihtuu toiseksi, mutta sitä ei
voi tehdä ohjaamon käyttöliittymästä. Vahti hälyttää siis kerran ottelua kohti ja
vaikenee sen jälkeen — myös aivan muista vioista kuin siitä, josta se ehti
kertoa. (#265)

**Vaimennuslukon avaaminen**:
Toimenpide, joka purkaa vaimennuslukon, minkä jälkeen hälytykset voivat taas
laueta. Operaattori päätti 18.8.2026, että tällainen avaaminen tehdään (#265).

Toteutustapaa ei ole vielä suunniteltu, eikä tämä merkintä ota siihen kantaa.
Termi on kirjattu tähän, jotta asiasta voi puhua yksiselitteisesti ennen kuin se
on rakennettu.

## Relayn sinnikkyys ja sen rajat

**Perääntyminen**:
Uudelleenyritysten välin kasvattaminen, jottei epäonnistuva yritys toistu
tiheästi: ensimmäisen epäonnistumisen jälkeen odotetaan hetki, seuraavan jälkeen
pidempään, ja niin edelleen kattoon asti.

Tavallisessa katkoksessa perääntyminen säästää lähinnä turhaa työtä. **YouTuben
bottitarkistuksessa (HTTP 429) se on ainoa asia joka auttaa:** tiheä koputtelu
pitää eston voimassa, joten nopeampi yrittäminen tekee tilanteesta huonomman
eikä paremman. Relay tunnistaa torjunnan ja siirtyy silloin selvästi harvempaan
tahtiin — minuutteihin, ei sekunteihin. Samasta syystä relayn restart on tässä
tilanteessa huono keino: raakalähetys voi olla aivan kunnossa, ja tuore prosessi
aloittaa koputtelun alusta. (#249)

Perääntyminen ja **luovutusikkuna** kytkeytyvät toisiinsa: koska ikkunaa
tarkastellaan vain yrityksen yhteydessä, harvemmat yritykset siirtävät myös
luovutushetkeä myöhemmäksi. Siksi torjunnan aikainen odotus katkaistaan
enintään puoleen kulloinkin voimassa olevasta luovutusikkunasta — muuten yksi
uni voisi niellä koko ikkunan.

**Säiepooli**:
Node ei tee tiedosto-operaatioita pääsäikeessä vaan antaa ne pienelle joukolle
taustasäikeitä — **oletuksena neljälle**. Säie palaa joukkoon, kun operaatio
valmistuu. Jos operaatio ei koskaan valmistu, säie ei palaa: se on pois
käytöstä pysyvästi.

Neljä on vähän. Kun kaikki neljä ovat jumissa, jokainen seuraava
tiedosto-operaatio jää jonottamaan loputtomiin, ja **relay ei kaadu vaan lakkaa
etenemästä** — prosessi on pystyssä, palvelu näyttää elävän, mutta mikään ei
enää edisty. Se on vaikeampi huomata kuin kaatuminen, koska mikään ei ilmoita
mitään.

Konkreettinen esimerkki: nimetyn putken (FIFO) avaaminen jää käyttöjärjestelmän
tasolla odottamaan lukijaa, joka ei koskaan ilmesty. Odotus istuu yhdessä
neljästä säikeestä, ja jos sama epäonnistuva yritys toistuu silmukassa, pooli
täyttyy sekunneissa. (#274)

## Muualla määritelty

Pesäpallotermit (palo, tuoja, vuorossa/lyömässä, lyöntipisteet) on määritelty
CLAUDE.md:n Terminology-osiossa.
