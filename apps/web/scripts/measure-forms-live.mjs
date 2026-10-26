// رحلة الويب الحية على قاعدة جديدة خاصة بالتشغيل؛ لا تُستعمل على بيانات تشغيلية.
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { platform, release } from "node:os";

const web = resolve(dirname(fileURLToPath(import.meta.url)), ".."), root = resolve(web, "../.."), api = resolve(root, "apps/api");
if (process.env.WEB_FORMS_LIVE !== "1") throw new Error("Set WEB_FORMS_LIVE=1 for disposable local testing");
function localUrl(name, protocols) {
  let url; try { url = new URL(process.env[name] ?? ""); } catch { throw new Error("Local test service URL required"); }
  if (!protocols.includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search || url.hash) throw new Error("Local test services required");
  return url;
}
const adminUrl = localUrl("WEB_LIVE_POSTGRES_URL", ["postgres:", "postgresql:"]);
const redisUrl = localUrl("WEB_LIVE_REDIS_URL", ["redis:"]);
if (!/^\/(1[0-5])$/.test(redisUrl.pathname)) throw new Error("Use a disposable Redis database numbered 10–15");
const requireApi = createRequire(resolve(api, "package.json")), requireWeb = createRequire(resolve(web, "package.json"));
const { Pool } = requireApi("pg"), { hash } = requireApi("@node-rs/argon2"), { chromium, expect } = requireWeb("@playwright/test");
const ar = requireWeb("./messages/ar.json"), en = requireWeb("./messages/en.json");
const started = new Date(), database = `web_forms_live_${randomBytes(8).toString("hex")}`;
const dataUrl = new URL(adminUrl); dataUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 }), db = new Pool({ connectionString: dataUrl.href, connectionTimeoutMillis: 5000 });
const metrics = { real_api: false, real_postgres: false, real_bff: false, synthetic_data_only: true, ios_measured: false, android_measured: false };
const children = []; let browser, created = false, failure = false;
const output = resolve(web, ".artifacts/forms-live"); await mkdir(output, { recursive: true });
const key = () => randomBytes(32).toString("base64");
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, NODE_ENV: "development", DATABASE_URL: dataUrl.href, REDIS_URL: redisUrl.href,
  JWT_SECRET: randomBytes(32).toString("hex"), FIELD_ENCRYPTION_KEY: key(), TUSD_HOOK_SECRET: randomBytes(24).toString("hex"),
  S3_BUCKET_UPLOADS: "uploads", PUSH_DELIVERY_ENABLED: "false", LOG_LEVEL: "silent", OUTBOX_DISPATCHER_ENABLED: "false", RESERVATION_SWEEP_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" };
function child(command, args, cwd, extraEnv = {}) {
  const p = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: "ignore" }); p.on("error", () => { p.setupFailed = true; }); children.push(p); return p;
}
async function command(command, args, cwd) {
  const p = child(command, args, cwd);
  await new Promise((ok, fail) => { p.once("error", fail); p.once("exit", code => code === 0 ? ok() : fail(new Error("Local setup command failed"))); });
}
async function port() {
  const s = createServer(); await new Promise(resolve => s.listen(0, "127.0.0.1", resolve)); const p = s.address().port;
  await new Promise(resolve => s.close(resolve)); return p;
}
async function healthy(url, process) {
  for (let i = 0; i < 100; i++) {
    if (process.setupFailed || process.exitCode !== null) throw new Error("Local service exited");
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* لم يجهز بعد */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("Local service did not become ready");
}
async function check(name, operation) {
  try { await operation(); metrics[name] = true; console.log(`PASS ${name}`); }
  catch { metrics[name] = false; failure = true; throw new Error(`Live check failed: ${name}`); }
}
try {
  // مدقق إعداد API نفسه، قبل إنشاء قاعدة أو بدء أي عملية.
  requireApi("./dist/config/config.js").loadConfig(env);
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await command("bash", ["src/db/migrate.sh", "up"], api);
  metrics.real_postgres = true;
  metrics.postgres_version = (await db.query("SHOW server_version")).rows[0].server_version;
  const password = randomBytes(18).toString("base64url"), passwordHash = await hash(password), users = {};
  for (const role of ["system_admin", "editor_in_chief", "reporter"]) {
    const email = `${role}-${randomUUID()}@example.test`;
    const id = (await db.query("INSERT INTO users (email, password_hash, status) VALUES ($1,$2,'active') RETURNING id", [email, passwordHash])).rows[0].id;
    await db.query("INSERT INTO user_roles (user_id,role,scope_kind,scope_id) VALUES ($1,$2,'all','')", [id, role]); users[role] = { id, email };
  }
  const original = { version: 1, fields: [{ key: "headline", type: "short_text", label: { ar: "العنوان القديم", en: "Old headline" }, required: true, validation: { min_length: 3, max_length: 30 } }] };
  await db.query("INSERT INTO upload_forms(version,schema,published_by) VALUES(1,$1,$2)", [original, users.system_admin.id]);
  const apiPort = await port(), webPort = await port(), apiOrigin = `http://127.0.0.1:${apiPort}`, webOrigin = `http://127.0.0.1:${webPort}`;
  const apiProcess = child("node", ["dist/main.js"], api, { HOST: "127.0.0.1", PORT: String(apiPort) }); await healthy(`${apiOrigin}/health`, apiProcess); metrics.real_api = true;
  const webProcess = child("node", [requireWeb.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(webPort)], web,
    { NODE_ENV: "production", WEB_ORIGIN: webOrigin, API_BASE_URL: `${apiOrigin}/v1`, WEB_ALLOW_INSECURE_LOCALHOST: "true", WEB_REDIS_URL: redisUrl.href, WEB_SESSION_KEY: key() });
  await healthy(`${webOrigin}/ar/login`, webProcess); metrics.real_bff = true;
  const auth = await fetch(`${apiOrigin}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: users.reporter.email, password }) });
  expect(auth.status).toBe(200); const token = (await auth.json()).access_token;
  const createdMaterial = await fetch(`${apiOrigin}/v1/materials`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ title: "Synthetic old-form material", material_types: ["report"], governorate: "gaza", city: "synthetic", priority: "normal", sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: "network" }, form_version: 1, dynamic_fields: { headline: "old-record-value" } }) });
  expect(createdMaterial.status).toBe(201); const material = await createdMaterial.json();
  browser = await chromium.launch(); metrics.browser_version = browser.version();
  let external = 0, pageErrors = 0;
  async function session(role, locale) {
    const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on("request", r => { if (!r.url().startsWith(webOrigin + "/")) external++; }); page.on("pageerror", () => pageErrors++);
    const m = locale === "ar" ? ar : en;
    await page.goto(`${webOrigin}/${locale}/login`); await page.getByLabel(m.email).fill(users[role].email); await page.getByLabel(m.password, { exact: true }).fill(password);
    await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page).toHaveURL(`${webOrigin}/${locale}/inbox`);
    await page.goto(`${webOrigin}/${locale}/forms`); return { context, page, m, t: m.formsAdmin };
  }
  async function publish(page, m) {
    await page.getByRole("button", { name: m.formsAdmin.preview, exact: true }).click(); await page.getByRole("button", { name: m.formsAdmin.publish, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: m.confirm, exact: true }).click();
  }
  const a = await session("system_admin", "ar");
  await check("arabic_ui_publish", async () => {
    await expect(a.page.locator("html")).toHaveAttribute("dir", "rtl"); await a.page.getByRole("button", { name: a.t.clone, exact: true }).click();
    const editor = a.page.getByTestId("field-editor").first(); await editor.getByRole("group", { name: a.t.label, exact: true }).getByLabel(a.t.arabic).fill("عنوان جديد");
    await editor.getByRole("group", { name: a.t.label, exact: true }).getByLabel(a.t.english).fill("New headline"); await editor.getByLabel(a.t.searchable, { exact: true }).check();
    await publish(a.page, ar); await expect(a.page.getByRole("combobox", { name: a.t.version, exact: true })).toHaveValue("2");
  });
  await check("current_history_and_database_snapshot", async () => {
    const snapshots = await a.page.evaluate(async () => ({ current: await (await fetch("/api/bff/forms/current")).json(), old: await (await fetch("/api/bff/forms/1")).json(), list: await (await fetch("/api/bff/forms")).json() }));
    expect(snapshots.current.fields[0].searchable).toBe(true); expect(snapshots.old.fields[0].label.en).toBe("Old headline"); expect(snapshots.list.items.map(i => i.version)).toEqual([2, 1]);
    const rows = (await db.query("SELECT version,schema FROM upload_forms ORDER BY version")).rows; expect(rows).toHaveLength(2); expect(rows[0].schema).toEqual(original);
    expect((await db.query("SELECT count(*)::int n FROM outbox_events WHERE type='form.published'")).rows[0].n).toBe(1);
  });
  await check("old_material_readable_after_publish", async () => {
    const old = await a.page.evaluate(async id => (await fetch(`/api/bff/materials/${id}`)).json(), material.id);
    expect(old.form_version).toBe(1); expect(old.dynamic_fields.headline).toBe("old-record-value");
    await a.page.getByRole("combobox", { name: a.t.version, exact: true }).selectOption("1"); await expect(a.page.getByRole("region", { name: a.t.preview, exact: true }).getByLabel("العنوان القديم", { exact: false })).toBeVisible();
  });
  const e = await session("system_admin", "en");
  await check("english_clone_old_version", async () => {
    await expect(e.page.locator("html")).toHaveAttribute("dir", "ltr"); await e.page.getByRole("combobox", { name: e.t.version, exact: true }).selectOption("1");
    await e.page.getByRole("button", { name: e.t.clone, exact: true }).click(); await expect(e.page.getByRole("heading", { name: `${e.t.draft} 3`, exact: true })).toBeVisible();
    await publish(e.page, en); await expect(e.page.getByRole("combobox", { name: e.t.version, exact: true })).toHaveValue("3");
    expect((await db.query("SELECT schema FROM upload_forms WHERE version=2")).rows[0].schema.fields[0].label.en).toBe("New headline");
  });
  await check("live_concurrent_publish_preserves_stale_draft", async () => {
    await e.page.getByRole("button", { name: e.t.clone, exact: true }).click(); const label = e.page.getByTestId("field-editor").first().getByRole("group", { name: e.t.label, exact: true }).getByLabel(e.t.english);
    await label.fill("Preserved stale draft");
    const status = await e.page.evaluate(async () => { const f = await (await fetch("/api/bff/forms/current")).json(); f.version++; delete f.published_at; delete f.published_by;
      return (await fetch("/api/bff/forms", { method: "POST", headers: { "content-type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID(), "If-Match": '"3"' }, body: JSON.stringify(f) })).status; });
    expect(status).toBe(201); await publish(e.page, en); await expect(e.page.getByText(en.review.changed, { exact: true })).toBeVisible(); await expect(label).toHaveValue("Preserved stale draft");
    expect((await db.query("SELECT count(*)::int n FROM upload_forms")).rows[0].n).toBe(4);
  });
  const chief = await session("editor_in_chief", "en");
  await check("chief_read_only_and_bff_denies_publish", async () => {
    await expect(chief.page.getByRole("combobox", { name: chief.t.version, exact: true })).toHaveValue("4"); await expect(chief.page.getByRole("button", { name: chief.t.clone, exact: true })).toHaveCount(0);
    expect(await chief.page.evaluate(async () => (await fetch("/api/bff/forms", { method: "POST", headers: { "content-type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID(), "If-Match": '"4"' }, body: JSON.stringify({ version: 5, fields: [] }) })).status)).toBe(403);
  });
  const reporter = await session("reporter", "ar");
  await check("reporter_cannot_read_admin_history", async () => {
    expect(await reporter.page.evaluate(async () => (await fetch("/api/bff/forms")).status)).toBe(403); await expect(reporter.page.getByTestId("field-editor")).toHaveCount(0);
  });
  await check("http_only_session_and_no_external_requests", async () => {
    expect((await a.context.cookies()).find(c => c.name === "ph-session")?.httpOnly).toBe(true); expect(await a.page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(external).toBe(0); expect(pageErrors).toBe(0);
  });
  metrics.external_requests = external; metrics.page_errors = pageErrors;
} catch (error) { failure = true; console.error(error.message.startsWith("Live check failed:") ? error.message : "Live environment setup failed"); }
finally {
  await browser?.close();
  for (const p of children.reverse()) if (p.pid && p.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { p.kill("SIGKILL"); }, 5000); p.once("exit", () => { clearTimeout(timer); resolve(); }); p.kill("SIGTERM"); });
  await db.end();
  try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); metrics.database_cleanup = true; } catch { failure = true; metrics.database_cleanup = false; }
  await admin.end();
}
const result = { schema_version: 1, tool: "web", role: "web", test_name: "web-forms-live", started_at: started.toISOString(), ended_at: new Date().toISOString(), result: failure ? "fail" : "partial",
  device: { platform: "browser", model: "Playwright Chromium, synthetic disposable database", os_version: `${platform()} ${release()}` }, network: { profile: "loopback" }, upload_path: "n/a", metrics,
  notes: "رحلة ar/en من متصفح إلى بناء Next.js الإنتاجي وBFF ثم API الحقيقي وPostgreSQL وRedis؛ قاعدة جديدة حُذفت بعد التشغيل، دون API mocks. النشر والتاريخ والمادة القديمة وIf-Match والصلاحيات. partial لمعيار الحقول المتغيرة الكامل لأن مسودات iOS/Android لم تُختبر. لا قياس Safari أو أداء ميداني. نسخة PostgreSQL والمتصفح موثقة في metrics؛ لا ادعاء مطابقة صورة الإنتاج أو اعتماد مالك الجودة." };
await writeFile(resolve(output, "measurement.json"), JSON.stringify(result, null, 2) + "\n");
process.exitCode = failure ? 1 : 0;
