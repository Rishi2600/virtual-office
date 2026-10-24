import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests: two real Chromium contexts with fake mic, camera
 * and screen, talking through the real server and the Vite dev client.
 *
 * The dev client is used on purpose: it exposes `window.__store` and
 * `window.__session`, which is how the tests see peer connection state.
 * Run `npm run build:shared` first (`npm run test:e2e` does it for you).
 */
export default defineConfig({
  testDir: "e2e",
  // Every test shares the one office room; parallel tests would walk into
  // each other's calls.
  workers: 1,
  fullyParallel: false,
  // No retries: a call that only works on the second try is a bug to see.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    permissions: ["microphone", "camera"],
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--auto-select-desktop-capture-source=Entire screen",
        // Keeps autoplay policy out of the picture: these tests are about
        // whether media flows, not whether the page had a user gesture.
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: [
    {
      command: "npx tsx server/src/dev.ts",
      url: "http://localhost:2567/health",
      env: { LOG_LEVEL: "warn" },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm -w @vo/client run dev -- --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
