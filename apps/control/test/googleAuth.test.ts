// googleAuth.ts:n kaksi kriittistä osaa:
//
//  1. **Kiintiölaskuri.** YouTube ei kerro jäljellä olevaa kiintiötä missään,
//     joten tämä laskuri on ainoa tieto siitä ollaanko lähellä rajaa — ja se
//     nollautuu Yhdysvaltain Tyynenmeren keskiyöllä, ei Suomen.
//  2. **Terveysraportin varoituslogiikka.** Testing-tilaan jäänyt
//     OAuth-sovellus vanhentaa refresh tokenin 7 vuorokaudessa. Varoituksen on
//     tultava ENNEN sitä, tai yhteys katkeaa kesken lähetyksen.
//
// Verkko on mockattu kokonaan, eikä yksikään testi tee kirjoittavaa
// YouTube-kutsua. Levylle kirjoittavat osat ohjataan väliaikaishakemistoon
// (CONTROL_STATE_DIR) ennen moduulin latausta, jottei testi koske
// run/-hakemiston oikeisiin tokeneihin.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GoogleAuth = typeof import("../src/server/googleAuth.js");

let auth: GoogleAuth;

beforeAll(async () => {
  process.env.CONTROL_STATE_DIR = await mkdtemp(join(tmpdir(), "control-google-"));
  auth = await import("../src/server/googleAuth.js");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Yksi mock koko Google-pinnalle: reititys osoitteen perusteella, jotta
 *  testi voi vaihtaa vain sen vastauksen josta se on kiinnostunut. */
interface MockRoutes {
  deviceCode?: () => Response;
  token?: () => Response;
  tokenInfo?: () => Response;
  channels?: () => Response;
}

function mockFetch(routes: MockRoutes): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/device/code")) {
        return routes.deviceCode?.() ?? jsonResponse(500, { error: "unexpected device/code call" });
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return routes.token?.() ?? jsonResponse(500, { error: "unexpected token call" });
      }
      if (url.includes("tokeninfo")) {
        return routes.tokenInfo?.() ?? jsonResponse(200, { scope: auth.SCOPES.join(" ") });
      }
      if (url.includes("youtube/v3/channels")) {
        return routes.channels?.() ?? jsonResponse(200, { items: [{ id: "UC123", snippet: { title: "Kanava" } }] });
      }
      throw new Error(`Mockkaamaton kutsu: ${url}`);
    })
  );
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  delete process.env.GOOGLE_CLIENT_SECRET;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await auth.disconnect();
});

describe("kiintiölaskuri", () => {
  it("hinnoittelee listaukset yhteen ja kirjoittavat kutsut 50:een", () => {
    expect(auth.QUOTA_COST.list).toBe(1);
    expect(auth.QUOTA_COST.insert).toBe(50);
    expect(auth.QUOTA_COST.bind).toBe(50);
    expect(auth.QUOTA_COST.thumbnail).toBe(50);
    expect(auth.DEFAULT_QUOTA_LIMIT).toBe(10_000);
  });

  it("laskee yhden ottelun lähetysparin hinnan yhteen", () => {
    const day = Date.parse("2026-07-15T12:00:00Z");
    let state: import("../src/server/googleAuth.js").QuotaState = {
      day: auth.pacificDayKey(day),
      units: 0,
      byOp: {},
    };
    // Normaali: insert + recordingDetails-update + playlist-insert + stream
    // insert + bind + liveStreams.list.
    for (const op of ["insert", "update", "insert", "insert", "bind", "list"] as const) {
      state = auth.applyQuota(state, op, day);
    }
    expect(state.units).toBe(50 * 5 + 1);
    expect(state.byOp.insert).toBe(3);
  });

  it("nollautuu Tyynenmeren keskiyöllä, ei Suomen", () => {
    // 06:59 UTC = 23:59 PDT edellisenä päivänä.
    const beforeMidnight = Date.parse("2026-07-15T06:59:00Z");
    const afterMidnight = Date.parse("2026-07-15T07:00:00Z");
    expect(auth.pacificDayKey(beforeMidnight)).toBe("2026-07-14");
    expect(auth.pacificDayKey(afterMidnight)).toBe("2026-07-15");

    const used = auth.applyQuota({ day: "2026-07-14", units: 9000, byOp: { insert: 180 } }, "insert", beforeMidnight);
    expect(used.units).toBe(9050);

    const reset = auth.applyQuota(used, "insert", afterMidnight);
    expect(reset.day).toBe("2026-07-15");
    expect(reset.units).toBe(50);
    expect(reset.byOp.insert).toBe(1);
  });

  it("kirjaa kulutuksen levylle ja säilyttää sen kutsujen välillä", async () => {
    const now = Date.now();
    await auth.recordQuota("insert", now);
    const state = await auth.recordQuota("list", now);
    expect(state.units).toBe(51);
    expect((await auth.getQuota(now)).units).toBe(51);
  });

  // Taustapollerin kiintiöportti lukee tämän: se on paikallinen tiedostoluku,
  // ei verkkokutsu, joten sitä voi kysyä joka kierroksella.
  it("kertoo jäljellä olevat yksiköt eikä koskaan mene pakkaselle", async () => {
    const now = Date.parse("2026-07-16T12:00:00Z");
    expect(await auth.getQuotaRemaining(now)).toBe(auth.DEFAULT_QUOTA_LIMIT);
    await auth.recordQuota("insert", now);
    expect(await auth.getQuotaRemaining(now)).toBe(auth.DEFAULT_QUOTA_LIMIT - 50);
  });
});

describe("terveysraportin varoitukset", () => {
  const now = Date.parse("2026-07-28T09:00:00Z");

  function health(overrides: Partial<Parameters<GoogleAuth["buildAuthHealth"]>[0]> = {}) {
    return auth.buildAuthHealth({
      now,
      token: {
        refreshToken: "rt",
        scope: auth.SCOPES.join(" "),
        obtainedAt: new Date(now - 2 * 86_400_000).toISOString(),
        lastRefreshAt: new Date(now - 3_600_000).toISOString(),
      },
      channel: { id: "UC123", title: "Talonkuningas" },
      scopes: auth.SCOPES,
      quota: { day: auth.pacificDayKey(now), units: 0, byOp: {} },
      quotaLimit: auth.DEFAULT_QUOTA_LIMIT,
      pending: null,
      ...overrides,
    });
  }

  it("tuore, oikealla kanavalla oleva yhteys on ok ja kertoo kanavan nimen", () => {
    const result = health();
    expect(result.connected).toBe(true);
    expect(result.health).toBe("ok");
    expect(result.headline).toContain("Talonkuningas");
    expect(result.channel?.id).toBe("UC123");
    expect(result.warnings).toEqual([]);
  });

  it("yhdistämätön tila on idle, ei vika", () => {
    const result = health({ token: null });
    expect(result.connected).toBe(false);
    expect(result.health).toBe("idle");
    expect(result.headline).toMatch(/ei ole yhdistetty/i);
  });

  // obtainedAt on tarkoituksella lähellä lastRefreshAt:ia: tokenin IKÄ on oma
  // sääntönsä (ks. "tokenin ikä myöntämisestä" alla), joten 10 vrk vanha token
  // olisi fail riippumatta siitä milloin sitä viimeksi päivitettiin.
  it("varoittaa 6 vrk:n kohdalla Testing-tilan 7 vrk:n vanhenemisesta", () => {
    const result = health({
      token: {
        refreshToken: "rt",
        scope: auth.SCOPES.join(" "),
        obtainedAt: new Date(now - 6.6 * 86_400_000).toISOString(),
        lastRefreshAt: new Date(now - 6.5 * 86_400_000).toISOString(),
      },
    });
    expect(result.health).toBe("warn");
    expect(result.warnings.join(" ")).toMatch(/Testing/);
    expect(result.warnings.join(" ")).toMatch(/7 vuorokaudessa/);
    expect(result.daysSinceSuccess).toBe(6.5);
  });

  it("yli 7 vrk ilman onnistunutta päivitystä on vika, ei varoitus", () => {
    const result = health({
      token: {
        refreshToken: "rt",
        scope: auth.SCOPES.join(" "),
        obtainedAt: new Date(now - 30 * 86_400_000).toISOString(),
        lastRefreshAt: new Date(now - 7.5 * 86_400_000).toISOString(),
      },
    });
    expect(result.health).toBe("fail");
    expect(result.headline).toMatch(/vanhentunut/i);
  });

  it("laskee iän tokenin saamisesta jos päivityksiä ei ole vielä ollut", () => {
    const result = health({
      token: {
        refreshToken: "rt",
        scope: auth.SCOPES.join(" "),
        obtainedAt: new Date(now - 6.2 * 86_400_000).toISOString(),
        lastRefreshAt: null,
      },
    });
    expect(result.daysSinceSuccess).toBe(6.2);
    expect(result.health).toBe("warn");
  });

  /** Pelkkä youtube-oikeus on TÄYSI oikeus tälle sovellukselle: laitevirta ei
   *  hyväksy force-ssl:ää, eikä mikään sovelluksen kutsu tarvitse sitä. */
  it("pitää pelkkää youtube-oikeutta riittävänä", () => {
    const result = health({ scopes: ["https://www.googleapis.com/auth/youtube"] });
    expect(result.missingScopes).toEqual([]);
    expect(result.warnings.join(" ")).not.toMatch(/oikeudet/i);
  });

  it("varoittaa jos youtube-oikeus puuttuu kokonaan", () => {
    const result = health({ scopes: ["https://www.googleapis.com/auth/youtube.readonly"] });
    expect(result.health).toBe("warn");
    expect(result.missingScopes).toEqual(["https://www.googleapis.com/auth/youtube"]);
  });

  it("varoittaa jos kanavaa ei saatu varmistettua — väärä tili on kallis virhe", () => {
    const result = health({ channel: null });
    expect(result.health).toBe("warn");
    expect(result.warnings.join(" ")).toMatch(/väärälle kanavalle/);
  });

  it("loppuun käytetty kiintiö on vika ja näkyy otsikossa", () => {
    const result = health({ quota: { day: auth.pacificDayKey(now), units: 10_000, byOp: {} } });
    expect(result.health).toBe("fail");
    expect(result.quota.remaining).toBe(0);
    expect(result.headline).toMatch(/kiintiö/i);
  });

  it("vähissä oleva kiintiö on varoitus mutta ei este", () => {
    const result = health({ quota: { day: auth.pacificDayKey(now), units: 9_900, byOp: {} } });
    expect(result.health).toBe("warn");
    expect(result.quota.remaining).toBe(100);
  });

  // Vaiheen 1 taustapollaus uusii access tokenin noin tunnin välein, jolloin
  // lastRefreshAt on aina tuore eikä daysSinceSuccess kasva koskaan. Testing-
  // tilan refresh token kuolee silti 7 vrk myöntämisestä — ilman tokenin iän
  // tarkistusta terveysnäkymä olisi vihreä siihen asti kunnes yhteys katkeaa
  // kesken ottelun.
  describe("tokenin ikä myöntämisestä", () => {
    function agedToken(ageDays: number) {
      return {
        refreshToken: "rt",
        scope: auth.SCOPES.join(" "),
        obtainedAt: new Date(now - ageDays * 86_400_000).toISOString(),
        // Juuri päivitetty: taustapollaus on käynyt tunti sitten.
        lastRefreshAt: new Date(now - 3_600_000).toISOString(),
      };
    }

    it("on warn — ei fail — 7 vrk:n kohdalla vaikka päivitys onnistui tunti sitten", () => {
      const result = health({ token: agedToken(7.4) });
      // Ikä yksin ei ole todiste katkeamisesta: 7 vrk:n vanheneminen koskee
      // vain Testing-tilaa, ja julkaistulla sovelluksella token ei vanhene
      // iän takia lainkaan. Failinä tämä jäisi päivästä 7 eteenpäin pysyvästi
      // punaiseksi ja peittäisi alleen oikean vian.
      expect(result.health).toBe("warn");
      expect(result.tokenAgeDays).toBe(7.4);
      // daysSinceSuccess ei kerro tästä mitään — juuri se on regressio.
      expect(result.daysSinceSuccess).toBeLessThan(1);
      expect(result.warnings.join(" ")).toMatch(/myöntämisestä/i);
      // Ehdollinen sanamuoto: "jos sovellus on yhä Testing-tilassa".
      expect(result.warnings.join(" ")).toMatch(/Jos OAuth-sovellus on yhä Testing-tilassa/);
    });

    it("pysyy warnina vaikka token olisi kuukausia vanha", () => {
      // Julkaistu sovellus: refresh token ei vanhene, mutta tokenAgeDays
      // kasvaa loputtomiin.
      const result = health({ token: agedToken(120) });
      expect(result.health).toBe("warn");
    });

    it("aidosti katkennut yhteys on yhä fail — daysSinceSuccess hoitaa sen", () => {
      // Refresh lakkasi onnistumasta 8 vrk sitten, joten lastRefreshAt on
      // jäänyt paikalleen. Tämä polku on se joka saa olla punainen.
      const result = health({
        token: {
          refreshToken: "rt",
          scope: auth.SCOPES.join(" "),
          obtainedAt: new Date(now - 30 * 86_400_000).toISOString(),
          lastRefreshAt: new Date(now - 8 * 86_400_000).toISOString(),
        },
      });
      expect(result.health).toBe("fail");
      expect(result.headline).toMatch(/vanhentunut/i);
    });

    it("on warn 6 vrk:n kohdalla vaikka päivitys onnistui tunti sitten", () => {
      const result = health({ token: agedToken(6.2) });
      expect(result.health).toBe("warn");
      expect(result.tokenAgeDays).toBe(6.2);
      expect(result.warnings.join(" ")).toMatch(/myöntämisestä/i);
      expect(result.headline).toMatch(/vanhenemassa/i);
    });

    it("tuore token pysyy ok:na", () => {
      const result = health({ token: agedToken(5.9) });
      expect(result.health).toBe("ok");
      expect(result.warnings).toEqual([]);
    });

    // Laitevirta kirjoittaa lastRefreshAt:in ja obtainedAt:in SAMALLA
    // hetkellä, joten juuri tuo muoto — ei koskaan lastRefreshAt: null — on
    // se jonka tuotanto tuottaa kun päivityksiä ei ole vielä ollut.
    it("ei toista samaa syytä kahdesti kun päivityksiä ei ole vielä ollut", () => {
      const obtained = new Date(now - 6.2 * 86_400_000).toISOString();
      const result = health({
        token: {
          refreshToken: "rt",
          scope: auth.SCOPES.join(" "),
          obtainedAt: obtained,
          lastRefreshAt: obtained,
        },
      });
      expect(result.health).toBe("warn");
      expect(result.warnings).toHaveLength(1);
      // Yllä oleva daysSinceSuccess-sääntö sanoo asian; ikäsääntö vaikenee.
      expect(result.warnings[0]).not.toMatch(/myöntämisestä/i);
    });

    it("ei ylikirjoita ankarampaa löydöstä otsikosta", () => {
      const result = health({
        token: agedToken(6.2),
        quota: { day: auth.pacificDayKey(now), units: 10_000, byOp: {} },
      });
      expect(result.health).toBe("fail");
      expect(result.headline).toMatch(/kiintiö/i);
      // Varoitus on silti tallella, vaikka otsikko kertoo kiintiöstä.
      expect(result.warnings.join(" ")).toMatch(/myöntämisestä/i);
    });
  });

  it("ei siivoa aiempaa vikaa varoitukseksi vaikka myöhempi sääntö osuisi", () => {
    const result = health({
      channel: null,
      token: {
        refreshToken: "rt",
        scope: auth.SCOPES.join(" "),
        obtainedAt: new Date(now - 30 * 86_400_000).toISOString(),
        lastRefreshAt: new Date(now - 9 * 86_400_000).toISOString(),
      },
    });
    expect(result.health).toBe("fail");
  });
});

describe("laitevirta", () => {
  it("palauttaa käyttäjäkoodin ja vahvistusosoitteen", async () => {
    mockFetch({
      deviceCode: () =>
        jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        }),
    });
    const started = await auth.startDeviceFlow();
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.verificationUrl).toBe("https://www.google.com/device");
    expect(started.instructions).toContain("ABCD-EFGH");
    // Regressio, 29.7.2026: force-ssl listalla Google vastasi
    // "Invalid device flow scope" eikä kirjautumista voinut edes aloittaa.
    // Laitevirta tukee vain osaa scopeista, ja force-ssl on niiden ulkopuolella.
    const body = decodeURIComponent(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body).toContain("https://www.googleapis.com/auth/youtube");
    expect(body).not.toContain("force-ssl");
  });

  it("käsittelee authorization_pendingin normaalina kulkuna, ei virheenä", async () => {
    mockFetch({
      deviceCode: () =>
        jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        }),
      token: () => jsonResponse(428, { error: "authorization_pending" }),
    });
    await auth.startDeviceFlow();
    const poll = await auth.pollDeviceFlow();
    expect(poll.status).toBe("pending");
    expect(poll.intervalSec).toBe(5);
    expect(poll.userCode).toBe("ABCD-EFGH");
  });

  it("kasvattaa pollausväliä kun Google pyytää hidastamaan", async () => {
    mockFetch({
      deviceCode: () =>
        jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        }),
      token: () => jsonResponse(403, { error: "slow_down" }),
    });
    await auth.startDeviceFlow();
    expect((await auth.pollDeviceFlow()).intervalSec).toBe(10);
    expect((await auth.pollDeviceFlow()).intervalSec).toBe(15);
  });

  it("kertoo vanhentuneesta laitekoodista sen sijaan että jäisi pollaamaan", async () => {
    mockFetch({
      deviceCode: () =>
        jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        }),
      token: () => jsonResponse(400, { error: "expired_token" }),
    });
    await auth.startDeviceFlow();
    const poll = await auth.pollDeviceFlow();
    expect(poll.status).toBe("expired");
    // Vanhentunut virta ei jää roikkumaan levylle.
    expect((await auth.pollDeviceFlow()).status).toBe("none");
  });

  it("tallentaa refresh tokenin hyväksynnän jälkeen ja raportoi kanavan", async () => {
    mockFetch({
      deviceCode: () =>
        jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        }),
      token: () =>
        jsonResponse(200, {
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: auth.SCOPES.join(" "),
        }),
      channels: () => jsonResponse(200, { items: [{ id: "UC4oXm9", snippet: { title: "Talonkuningas" } }] }),
    });
    await auth.startDeviceFlow();
    const poll = await auth.pollDeviceFlow();
    expect(poll.status).toBe("connected");
    expect(poll.channel).toEqual({ id: "UC4oXm9", title: "Talonkuningas" });

    const health = await auth.getAuthHealth();
    expect(health.connected).toBe(true);
    expect(health.channel?.title).toBe("Talonkuningas");
    expect(health.missingScopes).toEqual([]);
    expect(health.health).toBe("ok");
  });

  // Taustapolleri lukitsee itsensä kun refresh token kuolee, ja avaa lukon
  // vasta kun tunnukset vaihtuvat. Uudelleenkirjautuminen YLIKIRJOITTAA
  // tokenin — tiedosto ei käy koskaan nollassa — joten pelkkä olemassaolo ei
  // kelpaa signaaliksi, mutta sormenjäljen on vaihduttava.
  it("sormenjälki vaihtuu uudelleenkirjautumisessa ilman että token käy nollassa", async () => {
    const connected = {
      deviceCode: () =>
        jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        }),
      token: () =>
        jsonResponse(200, {
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: auth.SCOPES.join(" "),
        }),
    };
    vi.useFakeTimers();
    try {
      expect(await auth.getTokenFingerprint()).toBeNull();

      vi.setSystemTime(Date.parse("2026-07-29T15:00:00.000Z"));
      mockFetch(connected);
      await auth.startDeviceFlow();
      await auth.pollDeviceFlow();
      const first = await auth.getTokenFingerprint();
      expect(first).not.toBeNull();

      // Sama tilanne kuin kentällä: operaattori kirjautuu uudelleen ilman että
      // vanhaa tokenia poistetaan välissä.
      vi.setSystemTime(Date.parse("2026-07-29T15:20:00.000Z"));
      mockFetch(connected);
      await auth.startDeviceFlow();
      await auth.pollDeviceFlow();
      expect(await auth.getTokenFingerprint()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kääntää invalid_grantin suomenkieliseksi uudelleenkirjautumisohjeeksi", async () => {
    mockFetch({
      deviceCode: () =>
        jsonResponse(200, {
          device_code: "DC-1",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 900,
          interval: 5,
        }),
      token: () =>
        jsonResponse(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: auth.SCOPES.join(" ") }),
    });
    await auth.startDeviceFlow();
    await auth.pollDeviceFlow();
    auth.clearAccessTokenCache();

    mockFetch({ token: () => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }) });
    await expect(auth.getAccessToken()).rejects.toThrow(/Testing-tilassa/);

    // Terveysraportti ei kaadu verkkovirheeseen vaan raportoi sen.
    const health = await auth.getAuthHealth();
    expect(health.health).toBe("fail");
    expect(health.warnings.join(" ")).toMatch(/Testing-tilassa/);
  });
});
