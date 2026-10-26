import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globMatch, scanFile, scan, sanitize, formatFindings, run } from "./leak-check.mjs";

// عينات موجبة وسلبية صغيرة: كل قاعدة تُصيب مرة وتُسكَت بقيمة مسموحة مرة.
const ALLOW = {
  domains: ["localhost", "test", "invalid", "example.com", "github.com"],
  ips: new Set(["1.1.1.1"]),
  emails: new Set(["team@realmail.net"]),
  hashes: new Set(["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]),
  secrets: new Set(["whsec_test_secret", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"]),
  hashPaths: ["docs/measurements/**"],
};

function scanText(text, relPath = "docs/x.md") {
  const dir = mkdtempSync(join(tmpdir(), "leak-check-"));
  const file = join(dir, relPath.split("/").pop());
  writeFileSync(file, text);
  try {
    return scanFile(file, relPath, ALLOW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("globMatch: ** يعبر المقاطع و* داخل المقطع", () => {
  assert.ok(globMatch("docs/measurements/**", "docs/measurements/a/b.json"));
  assert.ok(globMatch("docs/measurements/**", "docs/measurements"));
  assert.ok(globMatch("apps/*/store", "apps/ios/store"));
  assert.ok(!globMatch("apps/*/store", "apps/ios/store/deep"));
  assert.ok(!globMatch("docs/**", "tools/x"));
});

test("النطاقات: الحقيقي يُبلَّغ والمسموح يُسكَت، وملفات الكود لا تُحسب وصولَ خصائص نطاقًا", () => {
  const f = scanText("راجع https://api.internal-corp.ps/feed و https://github.com/docs و localhost.");
  assert.deepEqual(f.map((x) => [x.type, x.match]), [["domain", "api.internal-corp.ps"]]);
  // في ملف برمجي: وصول خاصية خارج نص مقتبس لا يُحسب، والمقتبس يُحسب.
  const code = scanText('const a = thing.video;\nconst b = "feed.evil-corp.io";\n', "tools/acceptance/x.mjs");
  assert.deepEqual(code.map((x) => [x.type, x.match]), [["domain", "feed.evil-corp.io"]]);
  // لاحقة ملف ليست نطاقًا.
  assert.equal(scanText("افتح reporter.md و Theme.kt.").length, 0);
});

test("العناوين: العام يُبلَّغ والخاص والموثق والمسموح يُسكَت", () => {
  const f = scanText("إلى 8.8.8.8 ثم 10.0.0.5 و 172.30.251.3 و 203.0.113.9 و 127.0.0.1 و 1.1.1.1.");
  assert.deepEqual(f.map((x) => [x.type, x.match]), [["ip", "8.8.8.8"]]);
  // نسبة صورة 4:2:2 ليست IPv6، و::1 موثق.
  assert.equal(scanText("chroma 4:2:2 و ::1 فقط").length, 0);
  const v6 = scanText("الوجهة 2001:470::dead:beef هنا.");
  assert.deepEqual(v6.map((x) => [x.type, x.match]), [["ip", "2001:470::dead:beef"]]);
});

test("البريد: غير المسموح يُبلَّغ، والمسموح بنطاقه أو نصه يُسكَت", () => {
  const f = scanText("اكتب إلى a@x.test و user@example.com و team@realmail.net و boss@evil-corp.io.");
  assert.deepEqual(f.map((x) => [x.type, x.match]), [["email", "boss@evil-corp.io"]]);
});

test("الأسرار: whsec ومفاتيح sk وJWT وTOTP تُبلَّغ مقنَّعة، وقيم الاختبار المسموحة تُسكَت", () => {
  const f = scanText([
    `const a = "${"whsec_"}9fK2liveSecretValue";`, // تُبنى رمزيًا كي لا يلتقطها ماسح الأسرار في المنصة
    `const b = "${"sk_live_"}AbCdEfGh0123456789abcd";`,
    `const c = "${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".")}";`, // JWT يُجمَع وقت التشغيل فلا يظهر النمط الكامل في المستودع
    "totp seed JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    'const ok = "whsec_test_secret";',
  ].join("\n"), "tools/acceptance/t.mjs");
  assert.equal(f.length, 4);
  assert.ok(f.every((x) => x.type === "secret"));
  assert.ok(f.every((x) => x.match.endsWith("…")));
  assert.equal(scanText("totp GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").length, 0);
});

test("البصمات: ست عشرية بجوار كلمة سياق، باستثناء الأعداد العشرية والمسموح نصًا أو مسارًا", () => {
  const hit = scanText('sha256 المتطابق "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"');
  assert.deepEqual(hit.map((x) => [x.type]), [["hash"]]);
  // أعداد عشرية طويلة بجوار sha256 ليست بصمات.
  assert.equal(scanText('file_sha256: "a".repeat(64) مع file_size_bytes: 1073741824').length, 0);
  // قيمة مسموحة نصًا (بصمة المدخل الفارغ).
  assert.equal(scanText('sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855').length, 0);
  // مسار قياسات مسموح: بصمة أوزان نموذج عامة.
  const ok = scanText('"weights_sha256": "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da"',
    "docs/measurements/asr-bench/x.json");
  assert.equal(ok.length, 0);
});

test("scanFile: أرقام الأسطر والأنواع والتنسيق file:line:type", () => {
  const f = scanText("سطر سليم\nsee https://evil-corp.io/x\nأيضًا 8.8.8.8 هنا\n", "t.md");
  assert.deepEqual(f.map((x) => [x.line, x.type]), [[2, "domain"], [3, "ip"]]);
  assert.equal(formatFindings(f), "t.md:2: domain: evil-corp.io\nt.md:3: ip: 8.8.8.8");
});

test("sanitize: مضيف وعنوان وبريد إلى <base> وبصمة إلى <hash> وسر إلى <secret>", () => {
  const out = sanitize("اتصل https://api.internal-corp.ps:8443 أو 8.8.8.8 أو a@b.io؛ sha256 0123456789abcdef0123 و whsec_abcDEF123");
  assert.equal(out, "اتصل <base>:8443 أو <base> أو <base>؛ sha256 <hash> و <secret>");
  // ما ليس نطاقًا يبقى.
  assert.equal(sanitize("افتح reporter.md"), "افتح reporter.md");
});

test("run: خروج 1 مع قائمة بالتطابقات و0 للنظيف و--json يطبع المصفوفة", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-run-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs/bad.md"), "المصدر https://evil-corp.io/feed\n");
  try {
    const allow = join(dir, "allow.json");
    writeFileSync(allow, JSON.stringify({
      domains: ["localhost"], ips: [], emails: [], hashes: [], secrets: [], hashPaths: [],
    }));
    const env = { LEAK_CHECK_ROOTS: "docs", LEAK_CHECK_ALLOW: allow };
      // run تستعمل جذر المستودع؛ لذلك نختبر scan مباشرة على الجذر المؤقت.
    const findings = scan([{ base: dir, path: join(dir, "docs") }], {
      domains: ["localhost"], ips: new Set(), emails: new Set(), hashes: new Set(), secrets: new Set(), hashPaths: [],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, "docs/bad.md");
    assert.equal(findings[0].line, 1);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: قائمة سماح مفقودة تعني خروج 2", () => {
  const r = run([], { LEAK_CHECK_ALLOW: "/nonexistent/allow.json", LEAK_CHECK_ROOTS: "docs" });
  assert.equal(r.code, 2);
});
