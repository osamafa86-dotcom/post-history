import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
export default defineConfig({
  testDir: "./e2e", fullyParallel: false, workers: 1, retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:3100", trace: "off", screenshot: "only-on-failure" },
  reporter: "list", timeout: 30000,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "node --import tsx scripts/fixture-api.ts", url: "http://127.0.0.1:3201/health", reuseExistingServer: !process.env.CI },
    { command: "npm start", url: "http://127.0.0.1:3100/ar/login", reuseExistingServer: !process.env.CI, env: {
      NEXT_TELEMETRY_DISABLED: "1", WEB_ORIGIN: "http://127.0.0.1:3100", API_BASE_URL: "http://127.0.0.1:3201/v1", WEB_ALLOW_INSECURE_LOCALHOST: "true", WEB_MEDIA_ORIGINS: "http://127.0.0.1:3201", WEB_TUS_ORIGINS: "http://127.0.0.1:3201", WEB_CHECKOUT_ORIGINS: "http://127.0.0.1:3201",
      WEB_REDIS_URL: process.env.WEB_TEST_REDIS_URL ?? "redis://127.0.0.1:6381/1", WEB_SESSION_KEY: randomBytes(32).toString("base64"),
    } },
  ],
});
