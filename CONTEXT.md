# Pesisselostaja — sanasto

Yksi lähetysketju: ohjaamo ajastaa YouTube-lähetykset, relay miksaa selostuksen,
katsojat saavat linkit. Tämä sanasto määrittelee ketjun käsitteet niin, ettei
"lähde" tai "ajastus" tarkoita eri asiaa eri dokumentissa.

## Laitteet

Ketjussa on **kaksi puhelinta**, ja ne ovat eri ihmisen kädessä eri paikassa.
Paljas "puhelin" ei siksi kerro mitään — käytä aina jompaakumpaa näistä.

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
_Vältä_: pelkkä "kohde" ilman määrettä.

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

## Muualla määritelty

Pesäpallotermit (palo, tuoja, vuorossa/lyömässä, lyöntipisteet) on määritelty
CLAUDE.md:n Terminology-osiossa.
