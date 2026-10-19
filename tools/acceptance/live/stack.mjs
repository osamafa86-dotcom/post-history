// Starts the built API (apps/api/dist) against a migrated Postgres with throwaway secrets generated per run.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "../lib/measurement.mjs";

export async function startApi({ databaseUrl, port = 13000, apiDir = join(ROOT, "apps/api"), extraEnv = {} } = {}) {
  if (!databaseUrl) throw new Error("databaseUrl is required");
  const secrets = {
    JWT_SECRET: randomBytes(32).toString("hex"),
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    TUSD_HOOK_SECRET: randomBytes(24).toString("hex"),
  };
  const env = {
    ...process.env,
    ...secrets,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(port),
    LOG_LEVEL: "info",
    S3_BUCKET_UPLOADS: "uploads",
    TUSD_OBJECT_PREFIX: "tus/",
    OUTBOX_DISPATCHER_ENABLED: "true",
    OUTBOX_POLL_INTERVAL_MS: "200",
    RESERVATION_SWEEP_ENABLED: "false",
    LOGIN_RATE_LIMIT_MAX: "1000",
    LOGIN_RATE_LIMIT_IP_MAX: "100000",
    ...extraEnv,
  };
  const child = spawn("node", ["dist/main.js"], { cwd: apiDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`api exited early:\n${log.slice(-2000)}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
    if (i === 59) { child.kill(); throw new Error(`api did not become healthy:\n${log.slice(-2000)}`); }
  }
  return {
    baseUrl, apiUrl: `${baseUrl}/v1`, hookToken: secrets.TUSD_HOOK_SECRET, objectPrefix: "tus/", bucket: "uploads",
    logs: () => log,
    stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }),
  };
}
