// Starts the built API (apps/api/dist) against a migrated Postgres with throwaway secrets generated per run.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "../lib/measurement.mjs";

export async function startApi({ databaseUrl, port = 13000, apiDir = join(ROOT, "apps/api"), extraEnv = {}, redisUrl, s3 } = {}) {
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
    // short injected timers so escalation and verification are measurable in seconds, not the production minutes
    ESCALATION_URGENT_SECONDS: "3",
    ESCALATION_IMPORTANT_SECONDS: "6",
    ESCALATION_POLL_INTERVAL_MS: "200",
    VERIFY_POLL_INTERVAL_MS: "200",
    ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
    ...(s3 ? { S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_REGION: s3.region ?? "us-east-1" } : {}),
    ...extraEnv,
  };
  // a leftover server on the port would answer /health and make every secret in this run meaningless
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    throw new Error(`port ${port} already serves something; stop it first`);
  } catch (e) { if (/already serves/.test(e.message)) throw e; }
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
    baseUrl, apiUrl: `${baseUrl}/v1`, hookToken: secrets.TUSD_HOOK_SECRET, objectPrefix: "tus/", bucket: "uploads", escalationSeconds: 3,
    logs: () => log,
    stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }),
  };
}
