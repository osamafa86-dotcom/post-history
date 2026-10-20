// The field-trial acceptance pack: one command runs the live scripts against a remote host with test accounts, and leaves a
// folder holding the result files (measurement.json schema) and one unified REPORT.md.
//   FT_ACCOUNTS='{"reporter":{"email":"…","password":"…"},…}' node run.mjs --target https://host --confirm [--out-dir=DIR]
// Safety: the pack WRITES to the host (materials with synthetic canary data, uploads of synthetic clips, and it revokes every
// session of the `reporter` test account). It therefore refuses to run without --confirm, runs nothing against a host whose accounts
// are not given, and never reads or prints a password. dynamic-fields publishes a new form version that becomes the current form for
// everyone: it runs only with --allow-publish-form. No real reporter file is used: clips are generated here by FFmpeg.
// Exit: 0 nothing failed, 1 a criterion failed, 2 not run (missing confirmation, accounts or a script's environment).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountsFromEnv, parseTarget, remoteSeed } from "../lib/target.mjs";
import { EXIT_PENDING } from "../lib/pending.mjs";

const STEPS = ["tenant-isolation", "pii-leak", "upload-resume", "media-remote", "session-revocation", "dynamic-fields"];

export function plan(args) {
  return STEPS.filter((n) => n !== "dynamic-fields" || args["allow-publish-form"]);
}

/** Env each script reads, derived from the target and the seed; no secret is written anywhere but the process env. */
export function envFor(target, seed, accounts, args) {
  const tokens = JSON.stringify(seed.tokens);
  return {
    TENANT_BASE_URL: target.apiUrl, TENANT_TOKENS: tokens, TENANT_FIXTURES: JSON.stringify(seed.fixtures),
    PII_BASE_URL: target.apiUrl, PII_TOKENS: tokens, PII_CANARIES: JSON.stringify(seed.canaries.coordinates), PII_CHANNEL_CANARIES: JSON.stringify(seed.canaries.titles),
    UPLOAD_ENDPOINT: target.tusUrl, UPLOAD_API_URL: target.apiUrl, UPLOAD_TOKEN: seed.allTokens.reporter, UPLOAD_SIZE_MB: String(args["resume-mb"] ?? 24), UPLOAD_CHUNK_MB: "4",
    UPLOAD_NETWORK_PROFILE: "remote host", UPLOAD_ENV_NOTE: `المضيف ${new URL(target.url).hostname}`,
    MEDIA_REMOTE_API_URL: target.apiUrl, MEDIA_REMOTE_TUS_URL: target.tusUrl, MEDIA_REMOTE_TOKEN: seed.allTokens.reporter, MEDIA_REMOTE_ENV_LABEL: `remote host ${new URL(target.url).hostname}: API and tus only`,
    REVOKE_API_URL: target.apiUrl, REVOKE_TUS_URL: target.tusUrl, REVOKE_REPORTER_EMAIL: accounts.reporter.email, REVOKE_REPORTER_PASSWORD: accounts.reporter.password, REVOKE_ADMIN_TOKEN: seed.allTokens.system_admin,
    REVOKE_ENV_LABEL: `remote host ${new URL(target.url).hostname}`,
    DYN_API_URL: target.apiUrl, DYN_TOKENS: tokens,
  };
}

export async function runPack(args, env = process.env) {
  let target;
  try { target = parseTarget(args.target, env); } catch (e) { console.error(`ENVIRONMENT: ${e.message}`); return 2; }
  const { accounts, missing } = accountsFromEnv(env);
  const names = plan(args);
  console.log(`field-trial pack → ${target.url}\n  api ${target.apiUrl}\n  tus ${target.tusUrl}\n  steps: ${names.join(", ")}${args["allow-publish-form"] ? "" : "  (dynamic-fields skipped: it publishes a form; add --allow-publish-form)"}`);
  if (!args.confirm) { console.error("NOT RUN: this writes synthetic data to the host and revokes the reporter test account's sessions; pass --confirm"); return 2; }
  if (!accounts || missing.length) { console.error(`ENVIRONMENT: FT_ACCOUNTS must hold ${missing.join(", ")}; nothing was run`); return 2; }

  const out = resolve(typeof args["out-dir"] === "string" ? args["out-dir"] : `field-trial-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  process.env.ACCEPTANCE_RESULTS_DIR = out;
  let seed;
  try { seed = await remoteSeed({ apiUrl: target.apiUrl, accounts }); } catch (e) { console.error(`ENVIRONMENT: ${e.message}`); return 2; }
  Object.assign(process.env, envFor(target, seed, accounts, args));

  const summary = [];
  let worst = 0;
  for (const name of names) {
    const mod = await import(`../scripts/${name}.mjs`);
    try {
      const { code, doc } = await mod.run([]);
      summary.push([name, code === EXIT_PENDING ? "pending" : code === 2 ? "not run (environment)" : code ? "FAIL" : doc?.result ?? "ok"]);
      if (code !== EXIT_PENDING) worst = Math.max(worst, code);
    } catch (e) {
      console.error(`${name}: ${e.message}`);
      summary.push([name, "ERROR"]); worst = Math.max(worst, 1);
    }
  }
  // the unified report reads only this run's folder
  const { buildReport, loadEntries } = await import("../report.mjs");
  const roles = Object.keys(accounts);
  const header = [`# تقرير قبول التجربة الميدانية`, "", `المضيف: ${new URL(target.url).hostname} — ${new Date().toISOString()}`, `الأدوار المستعملة: ${roles.join("، ")}`,
    "الخطوات: " + summary.map(([n, o]) => `${n}=${o}`).join("، "), "", "ما لا تقيسه هذه الحزمة عن بُعد: دقة القص وسلامة الأصل في التخزين وسجل عامل الوسائط (media-e2e على compose)، والجهاز الفعلي (قائمة الفحص الميدانية).", ""].join("\n");
  writeFileSync(join(out, "REPORT.md"), `${header}\n${buildReport(loadEntries(out))}`);
  console.log(`\n== pack summary → ${out}`);
  for (const [n, o] of summary) console.log(`${n.padEnd(22)} ${o}`);
  return worst;
}
