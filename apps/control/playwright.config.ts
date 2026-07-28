import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Browser UI tests for the control app.
 *
 *  SAFETY: the server under test is started on its own port with EVERY write
 *  path redirected into a scratch directory (see `env` below). It cannot touch
 *  the real apps/broadcast/.env.relay, the relay's control files, or the real
 *  systemd unit — the unit name handed in does not exist, so a stray
 *  start/stop/restart is a no-op error instead of a cut broadcast.
 *
 *  WebKit is the primary target: the operator uses this from an iPhone in
 *  Safari, standing on a field. Chromium runs second as a cross-check. */

const CONTROL_ROOT = fileURLToPath(new URL(".", import.meta.url));
const SCRATCH = join(CONTROL_ROOT, ".playwright-tmp");
const PORT = Number(process.env.CONTROL_TEST_PORT ?? 3099);

/** iPhone 15 / 15 Pro logical viewport — the device this app is built for. */
const IPHONE = {
  viewport: { width: 393, height: 853 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
} as const;

export default defineConfig({
  testDir: "./test-ui",
  outputDir: "./test-results",
  // The app talks to a live server; a stray leaked timer must not wedge CI.
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "fi-FI",
    timezoneId: "Europe/Helsinki",
  },

  projects: [
    {
      name: "webkit",
      use: {
        ...IPHONE,
        browserName: "webkit",
      },
    },
    {
      name: "chromium",
      use: {
        ...IPHONE,
        browserName: "chromium",
      },
    },
  ],

  webServer: {
    // Build first: the single bug a screenshot check has already caught here
    // was a client bundle that never loaded, so the tests must always run
    // against a freshly built bundle rather than whatever dist/ happens to hold.
    command: "npm run build && npx tsx src/server/index.ts",
    cwd: CONTROL_ROOT,
    url: `http://127.0.0.1:${PORT}/api/live`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      CONTROL_PORT: String(PORT),
      CONTROL_HOST: "127.0.0.1",
      // Every write path points into .playwright-tmp/ — nothing under this
      // config may reach production state.
      CONTROL_STATE_DIR: join(SCRATCH, "state") + "/",
      CONTROL_RELAY_ENV: join(SCRATCH, "relay-env", ".env.relay"),
      CONTROL_RELAY_RUN_DIR: join(SCRATCH, "relay-run") + "/",
      CONTROL_DEPLOY_DIR: join(SCRATCH, "deploy"),
      // Deliberately not a real unit: systemctl fails fast on it, so no test
      // can start, stop or restart the actual broadcast.
      CONTROL_RELAY_UNIT: "pesisselostaja-relay-uitest-nonexistent.service",
    },
  },
});
