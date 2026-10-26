import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const secret = "do-not-print-connection-password";
it.each([
  { WEB_FORMS_LIVE: "0" },
  { WEB_FORMS_LIVE: "1", WEB_LIVE_POSTGRES_URL: `postgres://u:${secret}@remote.example.test/test` },
  { WEB_FORMS_LIVE: "1", WEB_LIVE_POSTGRES_URL: `invalid-${secret}` },
  { WEB_FORMS_LIVE: "1", WEB_LIVE_POSTGRES_URL: "postgres://u@127.0.0.1/postgres", WEB_LIVE_REDIS_URL: "redis://127.0.0.1:6379/0" },
])("refuses a live run before opening unsafe services: %#", settings => {
  const result = spawnSync(process.execPath, ["scripts/measure-forms-live.mjs"], {
    cwd: web, encoding: "utf8", timeout: 5000,
    env: Object.assign({}, process.env, { WEB_FORMS_LIVE: "", WEB_LIVE_POSTGRES_URL: "", WEB_LIVE_REDIS_URL: "" }, settings),
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/Set WEB_FORMS_LIVE|Local test service|Local test services|disposable Redis/);
  expect(result.stderr + result.stdout).not.toContain(secret);
});
