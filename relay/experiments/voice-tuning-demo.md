# Ääniparametrien testi (noise_w / length_scale) — handoff

## Mitä tehtiin

Synteettinen ~99s äänidemo joka käyttää oikeita selostusrivejä ottelusta
**143267** (Ikaalisten Tarmo - IPV, D-tytöt) ja demonstroi Piperin
`noise_w`- ja `length_scale`-parametrien vaikutusta **ilman mallin vaihtoa**
(sama `fi_FI-harri-medium`). Ei liity videoon, pelkkä ääni.

**Kuuntele:**
`relay/run/voice-tuning-demo/demo.mp3`, tai selaimessa dufsin kautta:
http://100.112.217.85:5000/pesistulokset-voice-watcher/relay/run/voice-tuning-demo/demo.mp3

## Rakenne

Joka segmentissä puhuttu selitys (oletusarvoilla) ennen näytettä, lyhyt tauko,
sitten oikea selostusrivi säädetyillä arvoilla:

1. Intro
2. Oletusarvot (`noise_w=0.8, length_scale=1.0`) — "4 A Tiainen löi juoksun, tuojana 1 A Hupli. 1, 0, IPV johtaa."
3. `noise_w=1.3` (enemmän tavunpituusvaihtelua) — "6 J Puonti löi juoksun..."
4. `length_scale=0.85, noise_scale=0.8` (nopeutettu, kunnaria varten) — "8 N Lappalainen löi kunnarin! 22, 2, IPV johtaa."
5. `length_scale=1.15` (hidastettu, painotusta ottelun lopetukseen) — "Ottelu päättyi! IPV voitti, Tarmo 2, IPV 22."
6. Kolme peräkkäistä ilmoitusta **ilman** välikommentteja, `noise_w` vaihtelee kevyesti (0.75 / 0.95 / 0.85) rivi riviltä — testaa kuulostaako pitkä ottelu vähemmän toistuvalta, kun peräkkäiset samantyyppiset rivit eivät ole akustisesti identtisiä.

## Skripti

`relay/experiments/voice-tuning-demo.ts` — ei npm-scriptiä (tarkoituksella
throwaway, ei osa `relay/tsconfig.json`:n includea eli ei typecheck/lint-katettu).
Aja uudelleen: `npx tsx relay/experiments/voice-tuning-demo.ts` (~30-60s, ei
lataa mitään, käyttää jo asennettua Piperiä).

## Päätettävää seuraavassa sessiossa

- Kuulostaako korotettu `noise_w` (1.3) luonnollisemmalta, vai alkaako ääntämys rikkoutua?
- Onko `length_scale`-kontrasti (0.85 kunnarille / 1.15 lopetukselle) sopiva vai liioiteltu?
- Kuuluuko segmentti 6:n kevyt per-rivi `noise_w`-vaihtelu selvänä erona, vai pitääkö haarukkaa leventää?
- Jos tulos kelpaa: viedäänkö parametrit tuotantoon (`relay/src/piperTts.ts` +
  `v2/src/piper.ts`) kiinteinä uusina oletuksina, tapahtuvakohtaisina arvoina
  (kunnari/lopetus omat `length_scale`-arvot), vai satunnaistettuna joka
  synteesikutsulla väli sisällä?
- Tekstipuolen vaihteluun (huutomerkit, lauserakenne — alkuperäisen listan
  kohta 3) ei koskettu vielä; seuraava askel jos pelkkä parametrisäätö ei riitä.

## Rajaukset

- Ei muutoksia tuotantokoodiin — pelkkä erillinen demo.
- `relay/run/voice-tuning-demo/` on gitignoroitu (`relay/run/`) — `demo.mp3`
  säilyy vain tällä palvelimella, ei repossa. Regeneroitavissa skriptillä.
