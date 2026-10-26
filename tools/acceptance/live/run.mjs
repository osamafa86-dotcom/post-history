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

/** The two-person admin CLI (apps/api dist/cli/set-admin-status.js) as the commands admin-quorum runs: refused with one approver, accepted with two, and the quorum guard through the vault path. */
function quorumCli(stack, s) {
  const run = `node "${stack.apiDir}/dist/cli/set-admin-status.js"`;
  return {
    QUORUM_CLI_ENV: JSON.stringify({ ...stack.cliEnv, VAULT_TOKEN: stack.vaultToken }),
    QUORUM_TOTP: JSON.stringify({ a: s.totp.system_admin, c: s.totp.system_admin_c, e: s.totp.editor_in_chief }),
    QUORUM_CLI_ONE: `printf '%s\\n' "$TOTP_A" | ${run} --user "$TARGET_ID" --status suspended --mode two-admins --approver "$ID_A"`,
    QUORUM_CLI_TWO: `printf '%s\\n%s\\n' "$TOTP_A" "$TOTP_C" | ${run} --user "$TARGET_ID" --status suspended --mode two-admins --approver "$ID_A" --approver "$ID_C"`,
    QUORUM_CLI_GUARD: `printf '%s\\n%s\\n' "$TOTP_E" "$VAULT_TOKEN" | ${run} --user "$ID_C" --status suspended --mode vault --approver "$ID_E"`,
  };
}

let stack, worst = 0;
try {
  // optional backing services: with them the server verifies uploads against real object storage and shares the rate limit via Redis
  const s3 = process.env.LIVE_S3_ENDPOINT ? { endpoint: process.env.LIVE_S3_ENDPOINT, accessKey: process.env.LIVE_S3_ACCESS_KEY, secretKey: process.env.LIVE_S3_SECRET_KEY, region: process.env.LIVE_S3_REGION } : undefined;
  if (s3) {
    const { s3FromEnv } = await import("../lib/s3.mjs");
    await s3FromEnv({ S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_REGION: s3.region }).ensureBucket("uploads");
  }
  stack = await startApi({ databaseUrl, port: Number(args.port ?? 13000), redisUrl: process.env.LIVE_REDIS_URL, s3 });
  const coreOn = process.env.CORE_ACCEPTANCE === "1";
  const s = await seed({ databaseUrl, apiUrl: stack.apiUrl, fieldKey: coreOn ? stack.fieldKey : null });
  let sha = "unknown";
  try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(); } catch { /* not a checkout */ }
  const tokens = JSON.stringify(s.tokens);
  const common = {
    PII_BASE_URL: stack.apiUrl, PII_TOKENS: tokens,
    PII_CANARIES: JSON.stringify(s.canaries.coordinates), PII_CHANNEL_CANARIES: JSON.stringify(s.canaries.titles),
    TENANT_BASE_URL: stack.apiUrl, TENANT_TOKENS: tokens, TENANT_FIXTURES: JSON.stringify(s.fixtures),
    IDEM_BASE_URL: stack.apiUrl, IDEM_TOKENS: tokens,
    UPLOAD_CONTRACT_API_URL: stack.apiUrl, UPLOAD_CONTRACT_TOKENS: tokens,
    OUTBOX_API_URL: stack.apiUrl, OUTBOX_TOKENS: tokens, OUTBOX_DATABASE_URL: databaseUrl,
    STATE_API_URL: stack.apiUrl, STATE_TOKENS: tokens,
    HOOK_BASE_URL: stack.baseUrl, HOOK_TOKEN: stack.hookToken, HOOK_SESSIONS: JSON.stringify(s.uploads.hookSessions),
    INVALID_API_URL: stack.apiUrl, INVALID_TOKENS: tokens, DYN_API_URL: stack.apiUrl, DYN_TOKENS: tokens,
    HOOK_OBJECT_PREFIX: stack.objectPrefix, HOOK_BUCKET: stack.bucket,
    RECEIPT_ESCALATION_SECONDS: String(stack.escalationSeconds),
    ...(s3 ? { S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_REGION: s3.region ?? "us-east-1" } : {}),
    LOAD_API_URL: stack.apiUrl, LOAD_TOKENS: tokens, PERF_API_URL: stack.apiUrl, PERF_TOKENS: tokens,
    RECEIPT_API_URL: stack.apiUrl, RECEIPT_TOKENS: tokens, RECEIPT_RUNS: process.env.RECEIPT_RUNS ?? "20",
    // core-gate scripts (run only with CORE_ACCEPTANCE=1: they measure server work that lands with #69 and #75)
    RESERVE_API_URL: stack.apiUrl, RESERVE_TOKENS: JSON.stringify({ ...s.tokens, producer_b: s.allTokens.producer_b }),
    OCC_API_URL: stack.apiUrl, OCC_TOKENS: tokens,
    QUORUM_API_URL: stack.apiUrl, QUORUM_TOKENS: JSON.stringify({ ...s.tokens, victim: s.allTokens.victim_reporter }), QUORUM_TOKEN_B: s.allTokens.system_admin_b, QUORUM_TOKEN_C: s.allTokens.system_admin_c,
    QUORUM_USERS: JSON.stringify({
      system_admin_id: s.users.system_admin.id, system_admin_b_id: s.users.system_admin_b.id, victim_id: s.users.victim_reporter.id,
      a: s.users.system_admin.id, c: s.users.system_admin_c.id, e: s.users.editor_in_chief.id,
    }),
    ...(coreOn ? quorumCli(stack, s) : {}),
    NOTIF_API_URL: stack.apiUrl, NOTIF_TOKENS: JSON.stringify({ ...s.tokens, supervisor_b: s.allTokens.supervisor_b }), NOTIF_ESCALATION_S: String(stack.escalationSeconds),
    NOTIF_RULES: process.env.RULES_ACCEPTANCE ?? "0",
    RID_API_URL: stack.apiUrl, RID_MATERIAL_ID: s.uploads.materialA, RID_LEGAL_NAME: s.legalName ?? "",
    RID_TOKENS: JSON.stringify({ system_admin: s.tokens.system_admin, identity_holder: s.tokens.editor_in_chief, source_holder: s.allTokens.system_admin_b, reporter: s.tokens.reporter }),
    RID_USERS: JSON.stringify({ identity_holder: s.users.editor_in_chief.id, source_holder: s.allTokens.system_admin_b.id }),
  };
  Object.assign(process.env, common);
  const note = `الخادم من main@${sha} على Postgres 16 بقاعدة مؤقتة${process.env.LIVE_REDIS_URL ? " وRedis" : ""}${s3 ? " وتخزين S3" : ""}؛ بلا Cloudflare ولا tusd (الخطّاف مُحاكى)`;
  const passthrough = args["dry-run"] ? ["--dry-run"] : [];
  setLogSource(() => stack.logs());
    // pii-leak reads the server logs of everything before it; dynamic-fields last: it publishes the shared form, which becomes the current form (with required fields) for every later material
  const core = process.env.CORE_ACCEPTANCE === "1" ? ["reporter-identity-access", "reservation-conflict", "optimistic-concurrency", "admin-quorum", "notification-delivery"] : [];
  const names = ["tenant-isolation", "duplicate-payment", "upload-contract", "outbox-transaction", "material-state-independence", "invalid-file", "receipt-notification", "concurrent-load", "performance", ...core, "pii-leak", "dynamic-fields"];
  const summary = [];
  const only = typeof args.only === "string" ? args.only.split(",") : null;
  for (const name of names.filter((n) => !only || only.includes(n))) {
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
