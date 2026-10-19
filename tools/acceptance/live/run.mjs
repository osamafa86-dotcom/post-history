#!/usr/bin/env node
// Runs every server-backed acceptance script against a freshly started API and a throwaway seeded database.
//   DATABASE_URL=postgres://… (migrated)  node live/run.mjs [--dry-run] [--port=13000]
// Prerequisite: apps/api is built (npm ci && npm run build) and src/db/migrate.sh up has run against DATABASE_URL.
// Exit: 0 nothing failed, 1 a criterion failed, 2 environment problem.
import { execFileSync } from "node:child_process";
import { parseArgs } from "../lib/measurement.mjs";
import { startApi } from "./stack.mjs";
import { seed } from "./seed.mjs";
import { setLogSource } from "../scripts/pii-leak.mjs";

const args = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) { console.error("DATABASE_URL is required"); process.exit(2); }

let stack, worst = 0;
try {
  stack = await startApi({ databaseUrl, port: Number(args.port ?? 13000) });
  const s = await seed({ databaseUrl, apiUrl: stack.apiUrl });
  let sha = "unknown";
  try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(); } catch { /* not a checkout */ }
  const tokens = JSON.stringify(s.tokens);
  const common = {
    PII_BASE_URL: stack.apiUrl, PII_TOKENS: tokens,
    PII_CANARIES: JSON.stringify(s.canaries.coordinates), PII_CHANNEL_CANARIES: JSON.stringify(s.canaries.titles),
    TENANT_BASE_URL: stack.apiUrl, TENANT_TOKENS: tokens, TENANT_FIXTURES: JSON.stringify(s.fixtures),
    IDEM_BASE_URL: stack.apiUrl, IDEM_TOKENS: tokens,
    HOOK_BASE_URL: stack.baseUrl, HOOK_TOKEN: stack.hookToken, HOOK_SESSIONS: JSON.stringify(s.uploads.hookSessions),
    HOOK_OBJECT_PREFIX: stack.objectPrefix, HOOK_BUCKET: stack.bucket,
    RECEIPT_API_URL: stack.apiUrl, RECEIPT_TOKENS: tokens, RECEIPT_RUNS: process.env.RECEIPT_RUNS ?? "20",
  };
  Object.assign(process.env, common);
  const note = `الخادم من main@${sha} على Postgres 16 محلي بقاعدة مؤقتة؛ لا Cloudflare ولا S3 ولا tusd في هذا التشغيل`;
  const passthrough = args["dry-run"] ? ["--dry-run"] : [];
  setLogSource(() => stack.logs());
  // pii-leak last: it also reads the server logs produced by everything before it
  const names = ["tenant-isolation", "duplicate-payment", "invalid-file", "receipt-notification", "pii-leak"];
  const summary = [];
  for (const name of names) {
    const mod = await import(`../scripts/${name}.mjs`);
    try {
      const { code, doc } = await mod.run(passthrough);
      summary.push([name, code ? "FAIL" : doc?.result ?? "ok"]);
      worst = Math.max(worst, code);
    } catch (e) {
      console.error(`${name}: ${e.stack ?? e}`);
      summary.push([name, "ERROR"]); worst = Math.max(worst, 1);
    }
  }
  console.log(`\n== live summary (${note})`);
  for (const [n, o] of summary) console.log(`${n.padEnd(24)} ${o}`);
} catch (e) {
  console.error(`ENVIRONMENT: ${e.message}`);
  worst = 2;
} finally {
  if (stack) await stack.stop();
}
process.exit(worst);
