// اختبارات فاحص جاهزية الدمج — تعمل على ملفات JSON ثابتة بلا شبكة.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOwners, packageOf, ownerReviewRequired, verdictOf,
  lastNonMergeCommitDate, gate, formatReport, run,
} from "./pr-gate.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "test", "pr-gate");
const PR = 42; // كل الحالات الثابتة تدور حول PR رقم 42.

// جلب وهمي: الحالة الثابتة خريطة «مسار API ← استجابة».
function stubFetcher(fixture) {
  return async (path) => {
    if (!(path in fixture)) throw new Error("مسار غير مغطّى في الحالة: " + path);
    const v = fixture[path];
    // README يُخزَّن نصًا في الحالة (أسهل للمراجعة) ويُحوَّل هنا إلى شكل API (base64).
    if (path === "contents/README.md" && typeof v.text === "string") {
      return { content: Buffer.from(v.text, "utf8").toString("base64"), encoding: "base64" };
    }
    return v;
  };
}

const load = (name) => JSON.parse(readFileSync(join(FIX_DIR, name), "utf8"));
const statusMap = (checks) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

test("جاهز كليًا: كل الشروط الثمانية ناجحة", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("ready.json")) });
  assert.equal(r.ready, true);
  const s = statusMap(r.checks);
  for (const id of ["base", "ci", "quality", "security", "owner", "stacking", "contracts", "naming"]) {
    assert.equal(s[id], "pass", id);
  }
});

test("حكم أقدم من آخر التزام غير دمجي ⇒ معلّق", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("stale-verdict.json")) });
  const s = statusMap(r.checks);
  assert.equal(s.quality, "pending");
  assert.equal(s.security, "pass");
  assert.equal(r.ready, false);
});

test("مانع أمني ⇒ فاشل", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("blocker.json")) });
  assert.equal(statusMap(r.checks).security, "fail");
  assert.equal(r.ready, false);
});

test("لا مانع بشرط ⇒ معلّق مع نص الشرط", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("conditional.json")) });
  const q = r.checks.find((c) => c.id === "quality");
  assert.equal(q.status, "pending");
  assert.match(q.evidence, /إضافة اختبار حدّي/);
});

test("حزمة يملكها غير المؤلف بلا سطر مالك ⇒ فاشل", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("owner-missing.json")) });
  const o = r.checks.find((c) => c.id === "owner");
  assert.equal(o.status, "fail");
  assert.match(o.evidence, /مراجعة المالك/);
});

test("تكديس فوق PR آخر ⇒ معلّق مع رقمه", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("stacked.json")) });
  const s = r.checks.find((c) => c.id === "stacking");
  assert.equal(s.status, "pending");
  assert.match(s.evidence, /#43/);
});

test("عقود بلا موافقة منسّق ⇒ فاشل؛ وبالموافقة ⇒ ناجح", async () => {
  const no = await gate(PR, { fetcher: stubFetcher(load("contracts-no-approval.json")) });
  assert.equal(statusMap(no.checks).contracts, "fail");
  const yes = await gate(PR, { fetcher: stubFetcher(load("contracts-approved.json")) });
  assert.equal(statusMap(yes.checks).contracts, "pass");
});

test("اسم نموذج في رسالة التزام ⇒ فاشل مع ذكره", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("ai-name.json")) });
  const n = r.checks.find((c) => c.id === "naming");
  assert.equal(n.status, "fail");
  assert.match(n.evidence, /أسماء نماذج/);
});

test("فحص CI فاشل ⇒ فاشل مع اسمه", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("ci-failing.json")) });
  const c = r.checks.find((x) => x.id === "ci");
  assert.equal(c.status, "fail");
  assert.match(c.evidence, /test/);
});

test("مسودة أو قاعدة غير main أو تعارض ⇒ فاشل", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("bad-base.json")) });
  const b = r.checks.find((c) => c.id === "base");
  assert.equal(b.status, "fail");
  assert.match(b.evidence, /مسودة: نعم/);
  assert.match(b.evidence, /القاعدة dev/);
  assert.match(b.evidence, /تعارض: نعم/);
});

test("سطر «لا مانع» لا يُقرأ كمانع", () => {
  assert.equal(verdictOf("مراجعة الجودة: لا مانع").status, "pass");
  assert.equal(verdictOf("مراجعة الجودة: مانع — خطر").status, "fail");
  const c = verdictOf("مراجعة الأمن: لا مانع بشرط: توثيق القرار");
  assert.equal(c.status, "pending");
  assert.equal(c.condition, "توثيق القرار");
});

test("جدول الملكية من README بأطول بادئة أولًا", () => {
  const md = "## الهيكل\n\n| المسار | المحتوى | المالك |\n| --- | --- | --- |\n| `contracts/` | العقود | وكيل العقود |\n| `apps/` | التطبيقات | وكيل عام |\n| `apps/api/` | الخادم | وكيل الخادم |\n";
  const owners = parseOwners(md);
  assert.equal(owners.length, 3);
  assert.equal(packageOf("contracts/x.json", owners).owner, "وكيل العقود");
  assert.equal(packageOf("apps/api/src/x.ts", owners).owner, "وكيل الخادم"); // الأطول يغلب
  assert.equal(packageOf("apps/web/y.ts", owners).owner, "وكيل عام");
  assert.equal(packageOf("README.md", owners), null);
});

test("إلزامية مراجعة المالك: الإعفاءات والمطابقة بالمرادفات", () => {
  const owners = parseOwners("| المسار | م | المالك |\n| --- | --- | --- |\n| `tools/` | أ | وكلاء الجودة والبنية |\n| `contracts/` | ب | وكيل العقود |\n");
  const need = ownerReviewRequired("kimi", ["tools/x.mjs", "docs/plan/y.md"], owners);
  assert.equal(need.required, true); // docs/plan معفاة (docs/**) وtools/ لمالك آخر
  assert.deepEqual(need.packages, ["tools/ ← وكلاء الجودة والبنية"]);
  assert.equal(ownerReviewRequired("جودة", ["tools/x.mjs"], owners).required, false); // وكلاء الجودة مستثنون
  assert.equal(ownerReviewRequired("kimi", ["docs/guide.md"], owners).required, false);
});

test("تاريخ آخر التزام غير دمجي يتجاهل التزامات الدمج", () => {
  const d = lastNonMergeCommitDate([
    { commit: { committer: { date: "2026-10-26T10:00:00Z" } }, parents: [{}] },
    { commit: { committer: { date: "2026-10-26T13:00:00Z" } }, parents: [{}, {}] },
    { commit: { committer: { date: "2026-10-26T11:00:00Z" } }, parents: [{}] },
  ]);
  assert.equal(d, "2026-10-26T11:00:00Z");
});

test("التقرير النصي عربي ويذكر الحالة", async () => {
  const r = await gate(PR, { fetcher: stubFetcher(load("conditional.json")) });
  const txt = formatReport(r);
  assert.match(txt, /PR #42/);
  assert.match(txt, /غير جاهز/);
  assert.match(txt, /معلّق/);
});

test("run: رموز الخروج 0 جاهز، 1 غير جاهز، 2 خطأ استعمال", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    const ok = await run(["pr-gate.mjs", "42", "--repo", "o/r"], {}, { fetcher: stubFetcher(load("ready.json")) });
    assert.equal(ok.code, 0);
    const notReady = await run(["pr-gate.mjs", "42", "--json"], { PR_GATE_REPO: "o/r" }, { fetcher: stubFetcher(load("blocker.json")) });
    assert.equal(notReady.code, 1);
    const parsed = JSON.parse(lines[lines.length - 1]);
    assert.equal(parsed.pr, 42);
    assert.equal(parsed.ready, false);
    assert.ok(Array.isArray(parsed.checks));
    const badUse = await run(["pr-gate.mjs"], {}, {});
    assert.equal(badUse.code, 2);
  } finally {
    console.log = orig;
  }
});

test("كل الحالات الثابتة تُحمَّل وتُفحص بلا استثناء", async () => {
  for (const f of readdirSync(FIX_DIR).filter((x) => x.endsWith(".json"))) {
    const r = await gate(PR, { fetcher: stubFetcher(load(f)) });
    assert.ok(r.checks.length >= 8, f);
  }
});
