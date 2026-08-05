// Google-yhteyden vartija (#188): vanheneminen ja kiintiö puhelimeen.
//
// Vartijan arvo on samassa paikassa kuin muidenkin ilmoitusten: siinä mitä se
// EI lähetä. Tarkistus ajetaan tunnin välein kuukausikaupalla, joten sääntö
// joka piippaa tilanteesta eikä sen muutoksesta lähettäisi saman varoituksen
// satoja kertoja — ja opettaisi operaattorin pyyhkäisemään ne pois ennen
// lukemista. Nämä testit kiinnittävät hiljaisuuden yhtä tarkasti kuin
// varoituksen.
import { describe, expect, it, vi } from "vitest";
import { authAlert, createAuthWatch, type AuthAlert } from "../src/server/authWatch.js";
import type { AuthHealth } from "../src/server/googleAuth.js";

function health(p: Partial<AuthHealth> = {}): AuthHealth {
  return {
    connected: true,
    health: "ok",
    headline: "Yhdistetty kanavaan Kuvitteellinen kanava.",
    channel: { id: "UC0", title: "Kuvitteellinen kanava" },
    scopes: ["https://www.googleapis.com/auth/youtube"],
    missingScopes: [],
    tokenObtainedAt: "2026-08-01T06:00:00.000Z",
    lastRefreshAt: "2026-08-05T06:00:00.000Z",
    daysSinceSuccess: 0.2,
    tokenAgeDays: 4,
    warnings: [],
    quota: { day: "2026-08-05", used: 100, limit: 10_000, remaining: 9900 },
    pending: null,
    ...p,
  };
}

describe("authAlert", () => {
  it("vaikenee kun yhteys on kunnossa ja kiintiötä on jäljellä", () => {
    expect(authAlert(health())).toBeNull();
  });

  it("vaikenee kun yhteyttä ei ole lainkaan — se on valmistelun este, ei muutos huonompaan", () => {
    expect(authAlert(health({ connected: false, health: "idle" }))).toBeNull();
  });

  it("varoittaa vanhenevasta yhteydestä ennen kuin se katkeaa", () => {
    const alert = authAlert(health({ daysSinceSuccess: 6.2 }));
    expect(alert?.kind).toBe("expiry");
    // Käskymuoto (#174): lukijan on tehtävä jotain, ja teko on ohjaamon huollossa.
    expect(alert?.title).toBe("Uusi Google-yhteys");
    expect(alert?.body).toContain("huollosta");
  });

  it("varoittaa kiintiöstä vasta kun luonti on oikeasti vaarassa", () => {
    expect(authAlert(health({ quota: { day: "d", used: 7000, limit: 10_000, remaining: 3000 } }))).toBeNull();
    const alert = authAlert(health({ quota: { day: "d", used: 8200, limit: 10_000, remaining: 1800 } }));
    expect(alert?.kind).toBe("quota");
    expect(alert?.body).toContain("82 %");
  });

  it("nostaa vanhenemisen kiintiön edelle: katkennut yhteys estää enemmän kuin loppuva kiintiö", () => {
    const alert = authAlert(
      health({ health: "fail", daysSinceSuccess: 7.5, quota: { day: "d", used: 9500, limit: 10_000, remaining: 500 } }),
    );
    expect(alert?.kind).toBe("expiry");
  });
});

describe("vartijan reuna", () => {
  it("lähettää varoituksen kerran, ei joka tunti", async () => {
    const send = vi.fn(async () => undefined);
    const watch = createAuthWatch({ readHealth: async () => health({ daysSinceSuccess: 6.5 }), send });

    await watch.check();
    await watch.check();
    await watch.check();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("varoittaa uudelleen sen jälkeen kun tilanne on korjaantunut", async () => {
    const send = vi.fn(async () => undefined);
    let current = health({ daysSinceSuccess: 6.5 });
    const watch = createAuthWatch({ readHealth: async () => current, send });

    await watch.check();
    current = health();
    await watch.check(); // paluu kuntoon ei piippaa
    current = health({ daysSinceSuccess: 6.5 });
    await watch.check();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("erottaa kiintiövaroituksen vanhenemisvaroituksesta — eri teko, oma piippaus", async () => {
    const kinds: string[] = [];
    const send = vi.fn(async (alert: AuthAlert) => void kinds.push(alert.kind));
    let current = health({ daysSinceSuccess: 6.5 });
    const watch = createAuthWatch({ readHealth: async () => current, send });

    await watch.check();
    current = health({ quota: { day: "d", used: 9000, limit: 10_000, remaining: 1000 } });
    await watch.check();

    expect(send).toHaveBeenCalledTimes(2);
    expect(kinds).toEqual(["expiry", "quota"]);
  });

  it("on hiljaa kun terveystarkistus itse kaatuu: verkkovirhe ei ole vanheneminen", async () => {
    const send = vi.fn(async () => undefined);
    const watch = createAuthWatch({
      readHealth: async () => {
        throw new Error("verkko poikki");
      },
      send,
    });

    await expect(watch.check()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
