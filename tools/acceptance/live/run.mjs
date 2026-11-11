#!/usr/bin/env node
// Runs every server-backed acceptance script against a freshly started API and a throwaway seeded database.
//   DATABASE_URL=postgres://… (migrated)  node live/run.mjs [--dry-run] [--port=13000] [--only=a,b]
// Prerequisite: apps/api is built (npm ci && npm run build) and src/db/migrate.sh up has run against DATABASE_URL.
// Exit: 0 nothing failed, 1 a criterion failed, 2 environment problem.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "../lib/measurement.mjs";
import { startApi } from "./stack.mjs";
import { seed } from "./seed.mjs";
import { seedTenantCommerce } from "./tenant-commerce.mjs";
import { CONTRIBUTORS } from "./contributors.mjs";
import { startFakeStripe } from "../lib/fake-stripe.mjs";
import { setLogSource } from "../scripts/pii-leak.mjs";
import { setLogSource as setRecoveryLogSource } from "../scripts/account-recovery.mjs";

const args = parseArgs(process.argv.slice(2));
// pii-leak reads the server logs of everything before it; dynamic-fields last: it publishes the shared form, which becomes the current form (with required fields) for every later material
const CORE = ["reporter-identity-access", "reservation-conflict", "optimistic-concurrency", "admin-quorum", "notification-delivery"];
const coreOn = process.env.CORE_ACCEPTANCE === "1";
const names = ["tenant-isolation", "duplicate-payment", "upload-contract", "outbox-transaction", "material-state-independence", "invalid-file", "receipt-notification", "concurrent-load", "performance", ...(coreOn ? CORE : []), "sandbox-purchase", "rights-exclusivity", "payout-concurrent", "refund-after-payout", "sensitive-material-visibility", "account-recovery", "pii-leak", "dynamic-fields"];
const only = typeof args.only === "string" ? args.only.split(",") : null;
// a name that is not in this run would select nothing and exit 0, and a row delegated here by name (lib/delegate.mjs) would pass unmeasured:
// refused before anything starts
const stray = (only ?? []).filter((n) => !names.includes(n));
if (stray.length) {
  const gated = stray.some((n) => CORE.includes(n)) ? " (the core-gate scripts need CORE_ACCEPTANCE=1)" : "";
  console.error(`ENVIRONMENT: --only: not in this run: ${stray.join(", ")}${gated}; nothing measured\nthis run has: ${names.join(", ")}`);
  process.exit(2);
}
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

let stack, stripeStack, fakeStripe, worst = 0;
// the internal sandbox payment provider (no real money; development mode only here): sandbox-purchase signs the notifications with this secret
const sandboxSecret = randomBytes(32).toString("hex"), livePort = Number(args.port ?? 13000);
try {
  // optional backing services: with them the server verifies uploads against real object storage and shares the rate limit via Redis
  const s3 = process.env.LIVE_S3_ENDPOINT ? { endpoint: process.env.LIVE_S3_ENDPOINT, accessKey: process.env.LIVE_S3_ACCESS_KEY, secretKey: process.env.LIVE_S3_SECRET_KEY, region: process.env.LIVE_S3_REGION } : undefined;
  if (s3) {
    const { s3FromEnv } = await import("../lib/s3.mjs");
    await s3FromEnv({ S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey, S3_REGION: s3.region }).ensureBucket("uploads");
  }
  stack = await startApi({ databaseUrl, port: livePort, redisUrl: process.env.LIVE_REDIS_URL, s3,
    extraEnv: { PAYMENT_PROVIDER: "sandbox", PAYOUT_RELEASE_AFTER_DAYS: "0", PAYOUT_WORKER_INTERVAL_MS: "300", PAYOUT_DEFAULT_MINIMUM_MINOR: "1000", SANDBOX_WEBHOOK_SECRET: sandboxSecret, SANDBOX_CHECKOUT_BASE_URL: `http://127.0.0.1:${livePort}`,
      // passkeys (ADR 0107) for account-recovery: the software authenticator signs for this origin; no domain, localhost alone
      WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: "http://localhost:3000" } });
  // a second API on the same database with the Stripe test-mode adapter against a local stand-in for Stripe's API
  // (duplicate-payment replays Stripe notifications too). Same JWT and field keys, so the seeded sessions work on both;
  // its background workers stay off (the first API runs them)
  fakeStripe = await startFakeStripe();
  const stripeWebhookSecret = `whsec_${randomBytes(24).toString("hex")}`;
  stripeStack = await startApi({ databaseUrl, port: livePort + 1, redisUrl: process.env.LIVE_REDIS_URL, s3,
    extraEnv: { PAYMENT_PROVIDER: "stripe", STRIPE_TEST_SECRET_KEY: `sk_test_${randomBytes(24).toString("hex")}`, STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
      STRIPE_API_BASE: fakeStripe.url, JWT_SECRET: stack.cliEnv.JWT_SECRET, FIELD_ENCRYPTION_KEY: stack.fieldKey, TUSD_HOOK_SECRET: stack.hookToken,
      OUTBOX_DISPATCHER_ENABLED: "false", UPLOAD_VERIFIER: "external" } });
  const s = await seed({ databaseUrl, apiUrl: stack.apiUrl, fieldKey: coreOn ? stack.fieldKey : null });
  let sha = "unknown";
  try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(); } catch { /* not a checkout */ }
  const tokens = JSON.stringify(s.tokens);
  // the second buyer organization's order, licence and a listing not on sale: tenant-isolation's organization cases
  const tenantFixtures = { ...s.fixtures, ...(await seedTenantCommerce({ databaseUrl, apiUrl: stack.apiUrl, rootUrl: stack.baseUrl, tokens: { ...s.allTokens, reporter: s.allTokens[CONTRIBUTORS["tenant-isolation"]] } })) };
  const common = {
    PII_BASE_URL: stack.apiUrl, PII_TOKENS: tokens,
    PII_CANARIES: JSON.stringify(s.canaries.coordinates), PII_CHANNEL_CANARIES: JSON.stringify(s.canaries.titles),
    TENANT_BASE_URL: stack.apiUrl, TENANT_TOKENS: tokens, TENANT_FIXTURES: JSON.stringify(tenantFixtures),
    // duplicate-payment: sandbox on the first API, Stripe test mode on the second, one database
    DP_API_URL: stack.apiUrl, DP_ROOT_URL: stack.baseUrl, DP_WEBHOOK_SECRET: sandboxSecret, DP_DATABASE_URL: databaseUrl,
    DP_STRIPE_API_URL: stripeStack.apiUrl, DP_STRIPE_ROOT_URL: stripeStack.baseUrl, DP_STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    DP_TOKENS: JSON.stringify({ reporter: s.allTokens[CONTRIBUTORS["duplicate-payment"]], rights_officer: s.allTokens.rights_officer, buyer_admin: s.allTokens.buyer_admin }),
    // rights-exclusivity: sandbox provider, buyers of both seeded organizations
    RX_API_URL: stack.apiUrl, RX_ROOT_URL: stack.baseUrl, RX_DATABASE_URL: databaseUrl, RX_WEBHOOK_SECRET: sandboxSecret,
    RX_TOKENS: JSON.stringify({ reporter: s.allTokens[CONTRIBUTORS["rights-exclusivity"]], rights_officer: s.allTokens.rights_officer, buyer_admin: s.allTokens.buyer_admin, buyer_member: s.allTokens.buyer_member, buyer_admin_b: s.allTokens.buyer_admin_b }),
    UPLOAD_CONTRACT_API_URL: stack.apiUrl, UPLOAD_CONTRACT_TOKENS: tokens,
    OUTBOX_API_URL: stack.apiUrl, OUTBOX_TOKENS: tokens, OUTBOX_DATABASE_URL: databaseUrl,
    STATE_API_URL: stack.apiUrl, STATE_TOKENS: tokens,
    // sensitive-material-visibility: the role tokens (the buyer admin's organization is seeded active), and this run's database for the
    // two sale conditions no API path reaches in this stack (ADR 0118: the published version and the verified original)
    SENSITIVE_API_URL: stack.apiUrl, SENSITIVE_TOKENS: tokens, SENSITIVE_DATABASE_URL: databaseUrl,
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
    RID_USERS: JSON.stringify({ identity_holder: s.users.editor_in_chief.id, source_holder: s.users.system_admin_b.id }),
    // sandbox-purchase: the whole sandbox purchase (API on /v1, the hosted page and the notification at the server root)
    SP_ENV_LABEL: `live stack: API from main@${sha} (dev mode, sandbox provider), Postgres 16${process.env.LIVE_REDIS_URL ? ", Redis" : ""}`,
    SP_API_URL: stack.apiUrl, SP_ROOT_URL: stack.baseUrl, SP_DATABASE_URL: databaseUrl, SP_WEBHOOK_SECRET: sandboxSecret,
    ACCT_API_URL: stack.apiUrl, ACCT_ORIGIN: "http://localhost:3000",
    ACCT_TOKENS: JSON.stringify({ system_admin: s.allTokens.system_admin, target: s.allTokens.recovery_target }),
    ACCT_TARGET: JSON.stringify(s.users.recovery_target),
    ACCT_ENV_LABEL: `live stack: API from main@${sha} (dev mode, passkeys on localhost), Postgres 16${process.env.LIVE_REDIS_URL ? ", Redis" : ""}`,
    SP_TOKENS: JSON.stringify({ system_admin: s.allTokens.system_admin, rights_officer: s.allTokens.rights_officer, reporter: s.allTokens.reporter, finance: s.allTokens.finance, buyer_admin: s.allTokens.buyer_admin, buyer_member: s.allTokens.buyer_member }),
  };
  Object.assign(process.env, common);
  const note = `الخادم من main@${sha} على Postgres 16 بقاعدة مؤقتة${process.env.LIVE_REDIS_URL ? " وRedis" : ""}${s3 ? " وتخزين S3" : ""}؛ بلا Cloudflare ولا tusd (الخطّاف مُحاكى)`;
  const passthrough = args["dry-run"] ? ["--dry-run"] : [];
  setLogSource(() => stack.logs());
  setRecoveryLogSource(() => stack.logs());
  const summary = [];
  // the payout scripts judge their reporter's balance to the unit: each sells its own contributor's material, so no other script's
  // sale is released into that balance while it counts (the payout worker releases every due sale a moment after it is paid)
  const spTokens = JSON.parse(common.SP_TOKENS);
  const own = (name) => ({ SP_TOKENS: JSON.stringify({ ...spTokens, reporter: s.allTokens[CONTRIBUTORS[name]] }) });
  const perScript = { "payout-concurrent": own("payout-concurrent"), "refund-after-payout": own("refund-after-payout") };
  for (const name of names.filter((n) => !only || only.includes(n))) {
    const mod = await import(["sandbox-purchase", "payout-concurrent", "refund-after-payout"].includes(name) ? `./${name}.mjs` : `../scripts/${name}.mjs`);
    try {
      const { code, doc } = perScript[name] ? await mod.run(passthrough, { ...process.env, ...perScript[name] }) : await mod.run(passthrough);
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
  if (stripeStack) await stripeStack.stop();
  if (fakeStripe) await fakeStripe.close();
  if (stack) await stack.stop();
}
process.exit(worst);
