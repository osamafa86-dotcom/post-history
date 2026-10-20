// recovery (plan row): the restorable-backup half that a pipeline can measure. A seeded, migrated database is dumped with pg_dump
// and restored with pg_restore into a fresh database (pg_restore itself runs with an empty search_path, which is what broke every
// CHECK constraint that called an unqualified function, #71); every table must come back with the same row count, every
// constraint validated. Needs RESTORE_DATABASE_URL (a role that may create databases); without it the row stays pending.
//   RESTORE_DATABASE_URL   the seeded database to back up (CI: the `db` job after `smoke.sql` committed its rows)
//   RESTORE_ENV_LABEL      what the environment is, for the result
// Not measured, and said so in the result: the isolated copy at the second provider, the asset sample, the 15-minute / 4-hour
// targets at real size. The result is therefore always `partial`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runPending } from "../lib/pending.mjs";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";

const q = (s) => `"${s.replace(/"/g, '""')}"`;
const withDb = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

async function counts(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename);
    const out = {};
    for (const t of tables) out[t] = Number((await c.query(`SELECT count(*) AS n FROM public.${q(t)}`)).rows[0].n);
    const invalid = (await c.query("SELECT conname FROM pg_constraint WHERE NOT convalidated")).rows.map((r) => r.conname);
    return { out, invalid };
  } finally { await c.end(); }
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  if (!env.RESTORE_DATABASE_URL) return runPending("recovery");
  const args = parseArgs(argv);
  const test = { name: "recovery", criterion: "استعادة قاعدة البيانات من نسخة pg_dump إلى قاعدة جديدة بمسار بحث فارغ مع تطابق عدّ الصفوف لكل جدول (الشطر القابل للقياس في خط الإنتاج)" };
  banner(test);
  const source = env.RESTORE_DATABASE_URL;
  const target = `restore_check_${Date.now().toString(36)}`;
  const doc = newResult("recovery", { device: { platform: "server", model: env.RESTORE_ENV_LABEL ?? "postgres: pg_dump -Fc then pg_restore into a new database" }, upload_path: "n/a" });
  const fails = [];
  const dir = mkdtempSync(join(tmpdir(), "restore-"));
  const admin = new pg.Client({ connectionString: withDb(source, "postgres") });
  let dumpS = null, restoreS = null, bytes = 0, before = {}, after = {}, invalid = [];
  try {
    const src = await counts(source);
    before = src.out;
    const file = join(dir, "dump.pgdump");
    let t0 = Date.now();
    execFileSync("pg_dump", ["--format=custom", "--no-owner", `--file=${file}`, source], { stdio: ["ignore", "inherit", "inherit"] });
    dumpS = (Date.now() - t0) / 1000;
    bytes = statSync(file).size;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${q(target)}`);
    t0 = Date.now();
    try {
      execFileSync("pg_restore", ["--no-owner", `--dbname=${withDb(source, target)}`, file], { stdio: ["ignore", "inherit", "inherit"] });
    } catch (e) { fails.push(`pg_restore exited ${e.status} (rows may have been rejected)`); }
    restoreS = (Date.now() - t0) / 1000;
    const dst = await counts(withDb(source, target));
    after = dst.out;
    invalid = dst.invalid.filter((c) => !src.invalid.includes(c));
    const total = Object.values(before).reduce((a, b) => a + b, 0);
    if (total === 0) fails.push("the source database holds no rows: nothing was compared");
    for (const t of Object.keys(before)) if (after[t] !== before[t]) fails.push(`${t}: ${before[t]} rows before, ${after[t] ?? "missing"} after`);
    for (const t of Object.keys(after)) if (!(t in before)) fails.push(`${t}: appeared only after the restore`);
    if (invalid.length) fails.push(`constraints not validated after the restore: ${invalid.join(", ")}`);
  } catch (e) {
    fails.push(`${e.message}`.split("\n")[0]);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${q(target)}`).catch(() => {});
    await admin.end().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  const tables = Object.keys(before).length, rows = Object.values(before).reduce((a, b) => a + b, 0);
  for (const f of fails) console.log(`FAIL ${f}`);
  if (!fails.length) console.log(`ok   ${tables} tables, ${rows} rows restored with equal counts, all constraints validated`);
  const metrics = { tables_compared: tables, rows_compared: rows, tables_with_rows: Object.values(before).filter((n) => n > 0).length, tables_mismatched: Object.keys(before).filter((t) => after[t] !== before[t]).length, dump_bytes: bytes, dump_s: dumpS === null ? -1 : Number(dumpS.toFixed(2)), restore_s: restoreS === null ? -1 : Number(restoreS.toFixed(2)), failures: fails.length };
  const notes = [
    fails.length ? `فشل: ${fails.join("؛ ")}` : null,
    "الشطر المقيس: pg_dump ثم pg_restore إلى قاعدة جديدة (pg_restore يعمل بمسار بحث فارغ) وتطابق عدّ الصفوف لكل جدول وصلاحية كل القيود",
    "لم يُقَس: النسخة المعزولة لدى المزوّد الثاني، وعينة الأصول (الكائنات)، وهدفا فقد ≤ 15 دقيقة واستعادة ≤ 4 ساعات بحجم حقيقي (القاعدة هنا صغيرة وبذورها اصطناعية)",
  ].filter(Boolean).join("؛ ");
  finish(doc, fails.length ? "fail" : "partial", metrics, notes);
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else {
    const out = args["out-dir"] && args["out-dir"] !== true ? args["out-dir"] : undefined;
    console.log("wrote", writeResult(doc, { slug: "pg-dump-restore", ...(out ? { dir: out } : {}) }));
  }
  return { code: fails.length ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { code } = await run();
  process.exit(code);
}
