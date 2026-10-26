// audit-gate: the CI gate on runtime dependency advisories (`npm audit --omit=dev --audit-level=high`) with a documented exception list.
// Same rule as the raw command (any advisory of severity high or above fails) except for an advisory listed in audit-allowlist.json, and only while:
//   - its entry has not expired (a reviewed date, not forever);
//   - its guard passes: the code proves the vulnerable path is not used (e.g. multer-unused scans apps/api/src);
//   - it is still reported: an entry that no longer matches fails too, so a fixed advisory is removed from the list, not forgotten.
// Pure node (no dependencies): it runs in a job that only did `npm ci` for the package it audits.
//   node tools/acceptance/scripts/audit-gate.mjs <dir>        <dir> is the package directory relative to the repository root (e.g. apps/api)
//   --audit-json <file>   judge a saved `npm audit --json` instead of running it   --allowlist <file>   --now <ISO date>
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const FAIL_AT = LEVELS.high;

/** Advisories (id, package, severity) at or above the failing level in an `npm audit --json` document. */
export function advisoriesOf(audit) {
  const found = new Map();
  for (const v of Object.values(audit?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || !via.url) continue;
      const id = String(via.url).split("/").pop();
      if ((LEVELS[via.severity] ?? 0) >= FAIL_AT && !found.has(id)) found.set(id, { id, package: via.name, severity: via.severity, title: via.title });
    }
  }
  return [...found.values()];
}

const SCANNED = /\.(ts|tsx|js|mjs|cjs)$/;
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out); else if (SCANNED.test(name)) out.push(p);
  }
  return out;
}

/** multer is reached only through its Nest wrappers or a direct import; none of these may appear in the package's own source. */
const MULTER_USE = /from\s+['"]multer['"]|require\(\s*['"]multer['"]|\b(File|Files|FileFields|AnyFiles|NoFiles)Interceptor\b|@UploadedFiles?\b|\bMulterModule\b|\bMulterOptions\b|multipart\/form-data/;
export function multerUnused(srcDir) {
  const hits = [];
  for (const f of sourceFiles(srcDir)) if (MULTER_USE.test(readFileSync(f, "utf8"))) hits.push(f.slice(srcDir.length + 1));
  return hits.length ? { ok: false, why: `multer path in use: ${hits.join(", ")}` } : { ok: true };
}

/** guard name -> function(packageDir) => {ok, why?} */
export const GUARDS = { "multer-unused": (pkgDir) => multerUnused(join(ROOT, pkgDir, "src")) };

/** The verdict: problems (empty = pass) and the advisories let through, for one package directory. */
export function gate({ audit, allowlist, dir, now = new Date(), guards = GUARDS }) {
  const problems = [], allowed = [];
  const entries = (allowlist?.entries ?? []).filter((e) => e.dir === dir);
  const reported = advisoriesOf(audit);
  for (const adv of reported) {
    const e = entries.find((x) => x.id === adv.id);
    if (!e) { problems.push(`${adv.id} (${adv.package}, ${adv.severity}) is not allowlisted: ${adv.title ?? ""}`.trim()); continue; }
    if (!(new Date(e.expires) > now)) { problems.push(`${adv.id}: the exception expired on ${e.expires}; renew it with a new review or fix the dependency (${e.removeWhen})`); continue; }
    const guard = guards[e.guard];
    if (!guard) { problems.push(`${adv.id}: unknown guard ${e.guard}`); continue; }
    const g = guard(dir);
    if (!g.ok) { problems.push(`${adv.id}: its guard ${e.guard} fails (${g.why})`); continue; }
    allowed.push({ ...adv, adr: e.adr, expires: e.expires });
  }
  for (const e of entries) if (!reported.some((a) => a.id === e.id)) problems.push(`${e.id}: no longer reported; remove it from audit-allowlist.json (${e.removeWhen})`);
  return { problems, allowed };
}

export function run(argv = process.argv.slice(2), env = process.env) {
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
  const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const dir = (positional[0] ?? ".").replace(/^\.\//, "").replace(/\/$/, "");
  const allowlistPath = flag("--allowlist") ?? join(ROOT, "tools/acceptance/audit-allowlist.json");
  const allowlist = existsSync(allowlistPath) ? JSON.parse(readFileSync(allowlistPath, "utf8")) : { entries: [] };
  let text;
  if (flag("--audit-json")) text = readFileSync(flag("--audit-json"), "utf8");
  else {
    const r = spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: join(ROOT, dir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
    text = r.stdout;
  }
  let audit;
  try { audit = JSON.parse(text); } catch { console.error("audit-gate: npm audit did not answer with JSON; nothing judged"); return 2; }
  if (audit.error) { console.error(`audit-gate: npm audit failed: ${audit.error.summary ?? audit.error.code ?? "error"}`); return 2; }
  const { problems, allowed } = gate({ audit, allowlist, dir, now: flag("--now") ? new Date(flag("--now")) : new Date() });
  for (const a of allowed) console.log(`allowed ${a.id} (${a.package}, ${a.severity}) by ADR ${a.adr} until ${a.expires}`);
  for (const p of problems) console.error(`FAIL ${p}`);
  if (!problems.length) console.log(`audit-gate ${dir}: no unlisted advisory at ${Object.keys(LEVELS)[FAIL_AT]} or above`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run());
