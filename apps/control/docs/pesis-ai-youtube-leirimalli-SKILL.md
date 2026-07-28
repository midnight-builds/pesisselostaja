---
name: "pesis-ai-youtube-leirimalli"
description: "Pesä Ysit YouTube workflow: always create narrated version and start share copy with 'Seuraava live on'."
---

# Pesä Ysit leiripelien YouTube-malli

Kanoninen ohje on nyt:

`/root/clawd/brain/pesis-ai/youtube-runbook.md`

Taman skillin tarkoitus on kertoa, miten Pesä Ysit -pelien YouTube-ajastus tehdään jatkossa.

## Pakolliset toimintatavat

- luo aina normaali YouTube-ajastus
- luo aina myos `Selostettu`-versio samalle ottelulle ilman erillista jatkokysymysta
- selostetulle tehdaan oma streami
- selostetulle asetetaan `enableAutoStart=true` ja `enableAutoStop=true`
- selostetun thumbnailiin lisataan badge `Selostettu tekoälyllä`
- normaalin ja selostetun linkit palautetaan aina samassa onnistumiskokonaisuudessa

## Copy/paste-viestin alku

Kayttajille tarkoitettu jaettava viesti aloitetaan aina tarkalla fraasilla:

`Seuraava live on `

Yhden ottelun viestin suositusmuoto:

```text
Seuraava live on klo <HH:MM>: <ottelupari>. Alla linkit:
YouTube: <youtube-linkki>
YouTube selostettu: <selostettu-youtube-linkki>
Tulospalvelu: <pesistulokset-linkki>
```

Jos otteluita on useita samalle paivalle, viestin ensimmaisen rivin tulee silti alkaa sanoilla `Seuraava live on`, vaikka lopullinen muoto muuten mukautetaan tilanteeseen.

## Leiripelit

- kayta lyhytta paikkamuotoa otsikossa ja thumbnailissa
- pida tarkka kentta kuvauksessa
- tee preview ennen luontia silloin kun laatu tai layout on epavarma

Jos jokin on ristiriidassa taman skillin ja master-ohjeen valilla, noudata tata paivitettya toimintalinjaa siihen asti kunnes master-ohje on sovitettu samaan kaytantoon.
