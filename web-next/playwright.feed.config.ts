import { defineConfig, devices } from "@playwright/test"

const configuredBaseUrl = process.env.CORGI_FEED_TEST_BASE_URL?.trim() || undefined
const baseURL = configuredBaseUrl ?? "http://127.0.0.1:4311"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "public-feed.spec.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  reporter: "line",
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: configuredBaseUrl === undefined ? {
    command: "python3 -m http.server 4311 --bind 127.0.0.1 --directory out",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  } : undefined,
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 900 } },
    },
  ],
})
