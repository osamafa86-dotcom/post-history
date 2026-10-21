// The field-trial acceptance pack: one command runs the live scripts against a remote host with test accounts, and leaves a
// folder holding the result files (measurement.json schema) and one unified REPORT.md.
//   FT_ACCOUNTS='{"reporter":{"email":"…","password":"…"},…}' node run.mjs --target https://host --confirm [--out-dir=DIR]
// Safety: the pack WRITES to the host (materials with synthetic canary data, uploads of synthetic clips, and it revokes every
// session of the `reporter` test account). It therefore refuses to run without --confirm, runs nothing against a host whose accounts
// are not given, and never reads or prints a password. dynamic-fields publishes a new form version that becomes the current form for
// everyone only with --allow-publish-form, which is refused for any host but the local machine; on a trial host it only reads. No real reporter file is used: clips are generated here by FFmpeg.
// Least privilege: every script gets the lowest role it needs. The system_admin account is read only for a run that needs it (--allow-publish-form
// publishes a form, which only an administrator may), and then: TOTP must be enrolled on it (a password-only login is refused and logged out),
// FT_SUSPEND_ADMIN_CMD must be given before anything starts (the command that suspends the administrator on the host, e.g. the two-person
// `cli:set-admin-status`; it reads the approvers' TOTP from this terminal), and it runs in `finally`, whatever failed, followed by a check that the
// administrator can no longer log in. An administrator still reachable at the end is exit 1.
// Exit: 0 nothing failed, 1 a criterion failed, 2 not run (missing confirmation, accounts or a script's environment).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountsFromEnv, isLoopback, parseTarget, remoteSeed } from "../lib/target.mjs";
import { client } from "../lib/live.mjs";
import { totp, totpStep, TOTP_STEP_MS } from "../lib/totp.mjs";
import { EXIT_PENDING } from "../lib/pending.mjs";

// session-revocation last: it revokes every session of the reporter account, so any step after it would hold a dead token
const STEPS = ["tenant-isolation", "pii-leak", "upload-resume", "media-remote", "dynamic-fields", "session-revocation"];

// dynamic-fields always runs, read-only on a trial host (it reads the current and previous form versions); publishing a form needs the
// administrator and is allowed on a local compose only (--allow-publish-form), where CI and rehearsals run it.
export function plan(_args) {
  return STEPS;
}

/** Env each script reads, derived from the target and the seed; no secret is written anywhere but the process env. */
export function envFor(target, seed, accounts, args) {
  const { system_admin: adminToken, ...others } = seed.tokens;
  const tokens = JSON.stringify(others);   // the matrices (tenant-isolation, pii-leak) run without the administrator: it is never needed to prove a denial
  return {
    TENANT_BASE_URL: target.apiUrl, TENANT_TOKENS: tokens, TENANT_FIXTURES: JSON.stringify(seed.fixtures),
    PII_BASE_URL: target.apiUrl, PII_TOKENS: tokens, PII_CANARIES: JSON.stringify(seed.canaries.coordinates), PII_CHANNEL_CANARIES: JSON.stringify(seed.canaries.titles),
    UPLOAD_ENDPOINT: target.tusUrl, UPLOAD_API_URL: target.apiUrl, UPLOAD_TOKEN: seed.allTokens.reporter, UPLOAD_SIZE_MB: String(args["resume-mb"] ?? 24), UPLOAD_CHUNK_MB: "4",
    UPLOAD_NETWORK_PROFILE: "remote host", UPLOAD_ENV_NOTE: `المضيف ${new URL(target.url).hostname}`,
    MEDIA_REMOTE_API_URL: target.apiUrl, MEDIA_REMOTE_TUS_URL: target.tusUrl, MEDIA_REMOTE_TOKEN: seed.allTokens.reporter, MEDIA_REMOTE_ENV_LABEL: `remote host ${new URL(target.url).hostname}: API and tus only`,
    REVOKE_API_URL: target.apiUrl, REVOKE_TUS_URL: target.tusUrl, REVOKE_REPORTER_EMAIL: accounts.reporter.email, REVOKE_REPORTER_PASSWORD: accounts.reporter.password,
    REVOKE_ENV_LABEL: `remote host ${new URL(target.url).hostname}`,
    DYN_API_URL: target.apiUrl, DYN_TOKENS: JSON.stringify(adminToken ? { ...others, system_admin: adminToken } : others),
  };
}


/** Suspends the administrator on the host, then proves it: the command's exit code AND a login that no longer succeeds. */
export async function suspendAdmin({ api, account, token, cmd, startStep, deps = {} }) {
  const spawn = deps.spawn ?? ((c) => spawnSync("bash", ["-c", c], { stdio: "inherit", timeout: 15 * 60 * 1000 }));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  if (token) await api.call(token, "POST", "/auth/logout", { key: null }).catch(() => {});
  console.log("\nsuspending the system_admin account (FT_SUSPEND_ADMIN_CMD)…");
  const r = spawn(cmd);
  const cmdOk = !r.error && r.status === 0;
  if (!cmdOk) console.error(`FAIL the suspend command did not succeed (exit ${r.status ?? "none"}${r.error ? `, ${r.error.code ?? r.error.message}` : ""})`);
  // a TOTP code is single-use per window: wait for a window the start did not use, so a refusal means "suspended", not "code reused"
  if (startStep != null && totpStep(now()) <= startStep) await sleep(TOTP_STEP_MS - (now() % TOTP_STEP_MS) + 1000);
  const body = { email: account.email, password: account.password, ...(account.totp_secret ? { totp_code: totp(account.totp_secret, now()) } : {}) };
  const login = await api.call(null, "POST", "/auth/login", { body, key: null });
  const stillActive = login.status === 200;
  if (stillActive) {
    await api.call(login.body.access_token, "POST", "/auth/logout", { key: null }).catch(() => {});
    console.error("FAIL ADMIN STILL ACTIVE: the system_admin account can still log in. Suspend it now (apps/api cli:set-admin-status) before anything else.");
  } else console.log(`ok   the system_admin account no longer logs in (login answered ${login.status})`);
  return { suspended: cmdOk && !stillActive };
}

export async function runPack(args, env = process.env, deps = {}) {
  let target;
  try { target = parseTarget(args.target, env); } catch (e) { console.error(`ENVIRONMENT: ${e.message}`); return 2; }
  const { accounts, missing } = accountsFromEnv(env);
  const names = plan(args);
  console.log(`field-trial pack → ${target.url}\n  api ${target.apiUrl}\n  tus ${target.tusUrl}\n  steps: ${names.join(", ")}${args["allow-publish-form"] ? "" : "  (dynamic-fields read-only: it does not publish a form)"}`);
  if (args["allow-publish-form"] && !isLoopback(target.url)) { console.error("NOT RUN: --allow-publish-form needs the system_admin account and is allowed on a local compose only; a trial host is never given one (dynamic-fields reads there)"); return 2; }
  if (!args.confirm) { console.error("NOT RUN: this writes synthetic data to the host and revokes the reporter test account's sessions; pass --confirm"); return 2; }
  if (!accounts || missing.length) { console.error(`ENVIRONMENT: FT_ACCOUNTS must hold ${missing.join(", ")}; nothing was run`); return 2; }
  const adminNeeded = Boolean(args["allow-publish-form"]);
  if (adminNeeded && !accounts.system_admin) { console.error("ENVIRONMENT: --allow-publish-form needs FT_ACCOUNTS.system_admin (with totp_secret); nothing was run"); return 2; }
  if (adminNeeded && !env.FT_SUSPEND_ADMIN_CMD) { console.error("ENVIRONMENT: --allow-publish-form uses the system_admin account, which must be suspended afterwards: give FT_SUSPEND_ADMIN_CMD (the command that suspends it on the host); nothing was run"); return 2; }

  const out = resolve(typeof args["out-dir"] === "string" ? args["out-dir"] : `field-trial-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  process.env.ACCEPTANCE_RESULTS_DIR = out;
  const api = client(target.apiUrl, deps.fetchImpl);
  const summary = [];
  let worst = 0, seed = null, adminState = "لم يُستعمل (أدنى دور)";
  // from here on the administrator account is in play: whatever happens below, it is suspended and checked at the end
  try {
    try { seed = await (deps.remoteSeed ?? remoteSeed)({ apiUrl: target.apiUrl, accounts, adminNeeded, fetchImpl: deps.fetchImpl }); } catch (e) { console.error(`ENVIRONMENT: ${e.message}`); worst = 2; }
    if (seed) {
      Object.assign(process.env, envFor(target, seed, accounts, args));
      for (const name of names) {
        try {
          const { code, doc } = await (deps.runScript ?? (async (n) => (await import(`../scripts/${n}.mjs`)).run([])))(name);
          summary.push([name, code === EXIT_PENDING ? "pending" : code === 2 ? "not run (environment)" : code ? "FAIL" : doc?.result ?? "ok"]);
          if (code !== EXIT_PENDING) worst = Math.max(worst, code);
        } catch (e) {
          console.error(`${name}: ${e.message}`);
          summary.push([name, "ERROR"]); worst = Math.max(worst, 1);
        }
      }
    }
  } finally {
    if (adminNeeded) {
      const done = await suspendAdmin({ api, account: accounts.system_admin, token: seed?.allTokens?.system_admin, cmd: env.FT_SUSPEND_ADMIN_CMD, startStep: seed ? seed.adminStep ?? null : null, deps });
      adminState = done.suspended ? "استُعمل ثم عُلِّق وتُحقق من تعليقه" : "استُعمل ولم يُتحقق من تعليقه — يجب تعليقه فورًا";
      if (!done.suspended) worst = Math.max(worst, 1);
    }
  }
  if (!seed) return worst;
  // the unified report reads only this run's folder
  const { buildReport, loadEntries } = await import("../report.mjs");
  const roles = Object.keys(seed.users);
  const header = [`# تقرير قبول التجربة الميدانية`, "", `المضيف: ${new URL(target.url).hostname} — ${new Date().toISOString()}`, `الأدوار المستعملة: ${roles.join("، ")}`, `system_admin: ${adminState}`,
    "الخطوات: " + summary.map(([n, o]) => `${n}=${o}`).join("، "), "", "ما لا تقيسه هذه الحزمة عن بُعد: دقة القص وسلامة الأصل في التخزين وسجل عامل الوسائط (media-e2e على compose)، والجهاز الفعلي (قائمة الفحص الميدانية).", "ومصفوفتا العزل والكشف تعملان بلا حساب مدير النظام (لا يلزم لإثبات رفض)؛ قراءة أحداث الرفع الجاري في session-revocation لا تتم عن بُعد.", ""].join("\n");
  writeFileSync(join(out, "REPORT.md"), `${header}\n${buildReport(loadEntries(out))}`);
  console.log(`\n== pack summary → ${out}`);
  for (const [n, o] of summary) console.log(`${n.padEnd(22)} ${o}`);
  return worst;
}
