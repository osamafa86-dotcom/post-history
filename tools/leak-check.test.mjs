import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globMatch, loadAllow, parseAllow, scanFile, scan, sanitize, formatFindings, run } from "./leak-check.mjs";

// عينات موجبة وسلبية صغيرة: كل قاعدة تُصيب مرة وتُسكَت بقيمة مسموحة مرة.
// كل عينة سرّ أو إحداثي أو بصمة تُبنى وقت التشغيل من أجزاء: الماسح الآلي في المنصة يفحص التاريخ ولا يفرّق بين العيّنة والسر،
// وقاعدة المشروع ألا يظهر نمط كامل حرفي ولا إحداثي يبدو حقيقيًا في المستودع.
const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const TOTP_SAMPLE = ["GEZDGNBV", "GY3TQOJQ"].join("").repeat(2);
const WHSEC_OK = ["whsec_", "test_secret"].join("");
const LAT = ["-1", "2345"].join(".");
const LON = ["-2", "3456"].join(".");
const PAIR = `${LAT}, ${LON}`;
const ISO_DEC = ["+01.2345", "-002.3456"].join("");
const ISO_DM = ["+0114", "-00221"].join("") + "/";
const HEX64 = "0123456789abcdef".repeat(4);
const HEX128 = "fedcba9876543210".repeat(8);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const R = "سبب اختباري واضح";

const ALLOW = parseAllow({
  domains: [
    { value: "localhost", reason: R }, { value: "test", reason: R }, { value: "invalid", reason: R },
    { value: "example.com", reason: R }, { value: "github.com", reason: R },
  ],
  ips: [{ value: "1.1.1.1", reason: R }],
  emails: [{ value: "team@realmail.net", reason: R }],
  hashes: [{ value: EMPTY_SHA256, reason: R }],
  secrets: [{ sha256: sha(WHSEC_OK), reason: R }, { sha256: sha(TOTP_SAMPLE), reason: R }],
});

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "leak-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scanText(text, relPath = "docs/x.md", allow = ALLOW) {
  return withTmp((dir) => {
    const file = join(dir, relPath.split("/").pop());
    writeFileSync(file, text);
    return scanFile(file, relPath, allow);
  });
}

/** [سطر، نوع] لكل تطابق: السطور هي التي تحمل التمييز بين الموجب والسالب، لا قيمة المطابقة (لا قيمة في النتيجة). */
const lt = (findings) => findings.map((f) => [f.line, f.type]);
const lk = (findings) => findings.map((f) => [f.line, f.type, f.kind]);

/** يشغّل run في مستودع مؤقت ويجمع الخرج. */
function runIn(dir, argv = [], extraEnv = {}) {
  const out = [];
  const err = [];
  const allowFile = join(dir, "allow.json");
  const env = { LEAK_CHECK_BASE: dir, LEAK_CHECK_ALLOW: allowFile, ...extraEnv };
  const r = run(argv, env, { log: (m) => out.push(m), error: (m) => err.push(m) });
  return { ...r, out: out.join("\n"), err: err.join("\n") };
}

const EMPTY_ALLOW_JSON = JSON.stringify({ domains: [{ value: "localhost", reason: R }] });

function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
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
  const f = scanText("راجع https://api.internal-corp.ps/feed\nو https://github.com/docs\nو localhost.");
  assert.deepEqual(lk(f), [[1, "domain", "host"]]);
  // في ملف برمجي: وصول خاصية خارج نص مقتبس لا يُحسب، والمقتبس يُحسب.
  const code = scanText('const a = thing.video;\nconst b = "feed.evil-corp.io";\n', "tools/acceptance/x.mjs");
  assert.deepEqual(lt(code), [[2, "domain"]]);
  // لاحقة ملف ليست نطاقًا، ولا معرّف حالة حروفه مختلطة (Type.field)، ولا اسم ملف مخفي (.env.local)، ولا اسم مركّب بشرطة.
  assert.equal(scanText("افتح reporter.md و Theme.kt.\n`LoginRequest.email`\nانسخ .env.local\nAPP_ID: PREVIEW000.invalid.preview.no-device").length, 0);
});

test("الشرط 4: المضيفون تحت لواحق الشبكات الداخلية وكل سلطة URL غير مسموحة تُعلَّم أيًّا كانت لاحقتها", () => {
  const f = scanText([
    "db.corp.internal", // 1
    "nas.local مضيف", // 2
    "printer.lan", // 3
    "curl http://stagingbox/health", // 4: اسم بلا لاحقة
    "عبر https://other.weird/x", // 5: لاحقة غير مدرجة
    "http://localhost:3000/ و https://github.com/x", // 6: مسموحان
    "http://user:pw@intranet-db:5432/app", // 7: userinfo لا يخفي المضيف
  ].join("\n"));
  assert.deepEqual(lk(f), [
    [1, "domain", "internal"], [2, "domain", "internal"], [3, "domain", "internal"],
    [4, "domain", "host"], [5, "domain", "host"], [7, "domain", "host"],
  ]);
  // قوالب المتغيرات ليست مضيفين.
  assert.equal(scanText("url: http://${HOST}:80/ و https://<host>/ و http://$H/").length, 0);
  // الاسم الداخلي المدرج بسبب لا يُبلَّغ، وعلى المسار المقصور عليه وحده.
  const scoped = parseAllow({ domains: [{ value: "svc-a", reason: R, paths: ["infra/**"] }] });
  assert.equal(scanText("http://svc-a:80/", "infra/x.yml", scoped).length, 0);
  assert.equal(scanText("http://svc-a:80/", "docs/x.md", scoped).length, 1);
});

test("العناوين: العام يُبلَّغ والخاص والموثق والمسموح يُسكَت", () => {
  const f = scanText("إلى 8.8.8.8\nثم 10.0.0.5\nو 172.30.251.3\nو 203.0.113.9\nو 127.0.0.1\nو 1.1.1.1.");
  assert.deepEqual(lk(f), [[1, "ip", "v4"]]);
  // نسبة صورة 4:2:2 ليست IPv6، و::1 موثق، وبادئة ::ffff: المُعيَّنة (في تعبير نمطي) ليست عنوانًا.
  assert.equal(scanText("chroma 4:2:2 و ::1 فقط").length, 0);
  assert.equal(scanText("grep -vE '^(127\\.|\\[::1\\]|\\[::ffff:127\\.)'").length, 0);
  const v6 = scanText("الوجهة 2001:470::dead:beef هنا.");
  assert.deepEqual(lk(v6), [[1, "ip", "v6"]]);
});

test("البريد: غير المسموح يُبلَّغ، والمسموح بنطاقه أو نصه يُسكَت", () => {
  const f = scanText("a@x.test\nuser@example.com\nteam@realmail.net\nboss@evil-corp.io");
  assert.deepEqual(lk(f), [[4, "email", "address"]]);
});

test("الأسرار: الأنماط القديمة والجديدة (PGP وAKIA وghp_ وgithub_pat_ وAIza وBearer) تُبلَّغ بنوعها، والمسموح يُسكَت", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".");
  const f = scanText([
    `const a = "${"whsec_"}9fK2liveSecretValue";`, // 1
    `const b = "${"sk_live_"}AbCdEfGh0123456789abcd";`, // 2
    `const c = "${jwt}";`, // 3
    "totp seed " + ["JBSWY3DP", "EHPK3PXP"].join("").repeat(2), // 4
    `const ok = "${WHSEC_OK}";`, // 5: مسموح
    "-----BEGIN PGP PRIVATE " + "KEY BLOCK-----", // 6
    "-----BEGIN RSA PRIVATE " + "KEY-----", // 7
    `aws=${["AKI", "AIOSFODNN7EXAMPLE"].join("")}`, // 8
    `gh=${["gh", "p_"].join("")}${"Ab1".repeat(12)}`, // 9
    `pat=${["github", "_pat_"].join("")}${"A1b2C3".repeat(4)}`, // 10
    `key=${["AI", "za"].join("")}${"A1b".repeat(11)}Zz`, // 11
    `Authorization: Bearer ${"abc123".repeat(4)}`, // 12
    "Bearer token و Bearer ${TOKEN} و Bearer <token>", // 13: لا شيء
  ].join("\n"), "tools/acceptance/t.mjs");
  assert.deepEqual(lk(f), [
    [1, "secret", "whsec"], [2, "secret", "sk"], [3, "secret", "jwt"], [4, "secret", "totp"],
    [6, "secret", "pem"], [7, "secret", "pem"], [8, "secret", "aws"], [9, "secret", "github"],
    [10, "secret", "github"], [11, "secret", "google"], [12, "secret", "bearer"],
  ]);
  assert.equal(scanText("totp " + TOTP_SAMPLE).length, 0);
});

test("الشرط 1: لا يُطبع أي جزء من القيمة المطابقة لا في النتيجة ولا في النص ولا في JSON", () => {
  const values = [
    ["whsec_", "9fK2liveSecretValue"].join(""), HEX64, HEX128, "boss@evil-corp.io", "evil-corp.io", "8.8.8.8", LAT, LON,
    "JBSWY3DP".concat("EHPK3PXP").repeat(2),
  ];
  const text = [
    `s ${values[0]}`, `h ${HEX64}`, `h2 ${HEX128}`, `m ${values[3]}`, `d https://${values[4]}/x`, `i ${values[5]}`,
    `g ${PAIR}`, `t totp ${values[8]}`,
  ].join("\n");
  const findings = scanText(text);
  assert.ok(findings.length >= 8);
  for (const f of findings) assert.deepEqual(Object.keys(f).sort(), ["file", "kind", "line", "type"]);
  const shown = formatFindings(findings) + JSON.stringify(findings);
  for (const v of values) {
    assert.ok(!shown.includes(v), "القيمة الكاملة ظهرت");
    assert.ok(!shown.includes(v.slice(0, 6)), `بادئة القيمة ظهرت: ${v.slice(0, 2)}…`);
  }
  // وعلى مسار run الكامل.
  withTmp((dir) => {
    writeTree(dir, { "docs/leak.md": text, "allow.json": EMPTY_ALLOW_JSON });
    for (const argv of [[], ["--json"]]) {
      const r = runIn(dir, argv);
      assert.equal(r.code, 1);
      for (const v of values) assert.ok(!(r.out + r.err).includes(v.slice(0, 6)), "بادئة القيمة في خرج run");
    }
  });
});

test("الشرط 2 و3: SHA-256 وSHA-512 بلا كلمة سياق، وما عداهما بكلمة سياق، والمسموح بقيمته", () => {
  const f = scanText([
    `"checksum": "${HEX64}"`, // 1: حقل باسم مختلف
    `value=${HEX128.toUpperCase()}`, // 2: SHA-512 بحروف كبيرة
    `sha1 ${"ab12".repeat(10)}`, // 3: 40 خانة بسياق
    `id ${"ab12".repeat(10)}`, // 4: 40 خانة بلا سياق: لا
    `sha256 ${EMPTY_SHA256}`, // 5: مسموح بقيمته
    `file_sha256: "a".repeat(64) مع file_size_bytes: 1073741824`, // 6: أعداد لا بصمات
    `digits ${"1234567890".repeat(7).slice(0, 64)}`, // 7: 64 خانة عشرية بلا حرف a-f
    `hash_${HEX64}_end`, // 8: الشرطة السفلية حد لا حرف
    `x${HEX64}`, // 9: ملتصق بحرف: ليس بصمة منفصلة
  ].join("\n"));
  assert.deepEqual(lk(f), [[1, "hash", "sha256"], [2, "hash", "sha512"], [3, "hash", "sha1"], [8, "hash", "sha256"]]);
});

test("الشرط 2 (hashPaths): لا إعفاء مسار شامل لـdocs/measurements؛ البصمة المعروفة تُسكَت بقيمتها وفي ملفها وحده", () => {
  const known = "76ff69fcdfe78b5d0bcfc877f95035535191f073fead3cc47553dc3c68fc5b1";
  const allow = parseAllow({ hashes: [{ value: known, reason: R, paths: ["docs/measurements/asr-bench/a.json"] }] });
  const line = `"weights_sha256": "${known}"`;
  assert.equal(scanText(line, "docs/measurements/asr-bench/a.json", allow).length, 0);
  // الملف المجاور في المجلد نفسه ليس معفى: بصمة الأصل الكاشفة تُلتقط هناك (#277).
  assert.equal(scanText(line, "docs/measurements/asr-bench/b.json", allow).length, 1);
  assert.equal(scanText(`"asset_sha256": "${HEX64}"`, "docs/measurements/x/y.json", allow).length, 1);
  // والمفتاح القديم مرفوض صراحة.
  assert.throws(() => parseAllow({ hashPaths: ["docs/measurements/**"] }), /hashPaths/);
});

test("بصمة صورة الحاوية (name:tag@sha256:…) تُستثنى في infra/ و.github/ وحدهما", () => {
  const image = `image: quay.io/org/app:1.2.3@sha256:${HEX64}`;
  const allow = parseAllow({ domains: [{ value: "quay.io", reason: R }] });
  assert.equal(scanText(image, "infra/compose/x.yml", allow).length, 0);
  assert.equal(scanText(`FROM app:1@sha256:${HEX64}`, ".github/workflows/w.yml", allow).length, 0);
  assert.deepEqual(lt(scanText(image, "docs/x.md", allow)), [[1, "hash"]]);
  assert.deepEqual(lt(scanText(`sha256:${HEX64}`, "infra/compose/x.yml", allow)), [[1, "hash"]]);
});

test("الإحداثيات: أزواج عشرية بأربع خانات فأكثر وISO 6709 وlat/lon بقيمة تُبلَّغ، وما دون ذلك أو خارج المدى أو قوائم الأعداد لا", () => {
  const f = scanText([
    `at ${PAIR} here`, // 1
    `(${LON};${LAT})`, // 2: ترتيب GeoJSON
    "approx -1.23, -2.34", // 3: خانتان: لا
    "range 123.4567, 234.5678", // 4: خارج المدى
    "samples 0.1234, 0.5678, 0.9012", // 5: قائمة أعداد
    `"lat": ${LAT}, "lon": "${LON}"`, // 6: مسميات
    "latitude: 1.23", // 7: دقة منخفضة
    `loc ${ISO_DEC}/`, // 8: ISO 6709 عشري
    `loc ${ISO_DM}`, // 9: ISO 6709 درجات ودقائق
    "version +12345-12345 و 2026-10-27T10:00:00+0200", // 10: ليس إحداثيًا
  ].join("\n"));
  assert.deepEqual(lk(f), [
    [1, "gps", "decimal"], [2, "gps", "decimal"], [6, "gps", "named"], [8, "gps", "iso6709"], [9, "gps", "iso6709"],
  ]);
});

test("الإحداثيات الاصطناعية المعروفة تُسكَت بـsha256 قيمتها وبسبب، وعلى مساراتها وحدها", () => {
  const allow = parseAllow({ gps: [
    { sha256: sha(`${LAT},${LON}`), reason: R, paths: ["tools/acceptance/**"] },
    { sha256: sha(ISO_DM), reason: R },
  ] });
  assert.equal(scanText(`at ${PAIR}`, "tools/acceptance/t.mjs", allow).length, 0);
  assert.equal(scanText(`at ${PAIR}`, "docs/x.md", allow).length, 1);
  assert.equal(scanText(`loc ${ISO_DM}`, "docs/x.md", allow).length, 0);
  // المدخل بلا sha256 مرفوض: لا إحداثي حرفي في قائمة السماح.
  assert.throws(() => parseAllow({ gps: [{ value: PAIR, reason: R }] }), /sha256/);
});

test("الشرط 7: قائمة السماح تشترط سببًا لكل مدخل ولا تذكر القيمة في رسالة الخطأ", () => {
  assert.throws(() => parseAllow({ domains: ["example.com"] }), /domains\[0\]/);
  assert.throws(() => parseAllow({ domains: [{ value: "evil-secret-host.io" }] }), (e) => /السبب إلزامي/.test(e.message) && !e.message.includes("evil-secret-host"));
  assert.throws(() => parseAllow({ secrets: [{ sha256: "abc", reason: R }] }), /sha256/);
  assert.throws(() => parseAllow({ ips: [{ value: "1.1.1.1", reason: "قصير" }] }), /السبب/);
  // القائمة المرفقة بالأداة سليمة: لكل مدخل سبب، ولا إعفاء شامل لقياسات، ولا مدخل بلا مسار حيث لا يصح (غير النطاقات العامة الموثقة).
  const real = JSON.parse(readFileSync(join(HERE, "leak-check.allow.json"), "utf8"));
  const parsed = loadAllow(join(HERE, "leak-check.allow.json"));
  for (const key of Object.keys(parsed)) {
    for (const e of parsed[key]) assert.ok(e.reason.length >= 8, `${key}: سبب ناقص`);
  }
  assert.equal(real.hashPaths, undefined);
  for (const e of parsed.hashes) assert.ok(e.paths.length > 0 && !e.paths.some((p) => /\*\*$/.test(p)), "بصمة بإعفاء مسار شامل");
  for (const e of [...parsed.ips, ...parsed.gps, ...parsed.secrets]) assert.ok(e.paths.length > 0, "مدخل حساس بلا مسار");
});

test("scanFile: أرقام الأسطر والأنواع والتنسيق file:line:type:kind بلا قيمة", () => {
  const f = scanText("سطر سليم\nsee https://evil-corp.io/x\nأيضًا 8.8.8.8 هنا\n", "t.md");
  assert.deepEqual(lt(f), [[2, "domain"], [3, "ip"]]);
  assert.equal(formatFindings(f), "t.md:2: domain: host\nt.md:3: ip: v4");
});

test("sanitize: مضيف وعنوان وبريد إلى <base> وبصمة إلى <hash> وسر إلى <secret> وإحداثي إلى <gps>", () => {
  const out = sanitize("اتصل https://api.internal-corp.ps:8443 أو 8.8.8.8 أو a@b.io؛ sha256 0123456789abcdef0123 و whsec_abcDEF123");
  assert.equal(out, "اتصل <base>:8443 أو <base> أو <base>؛ sha256 <hash> و <secret>");
  // ما ليس نطاقًا يبقى.
  assert.equal(sanitize("افتح reporter.md"), "افتح reporter.md");
  // الشروط الجديدة: داخلي، URL بلا لاحقة، SHA-512، إحداثيات، أسرار جديدة.
  assert.equal(sanitize("db.corp.internal و http://stagingbox:9000/x و http://localhost:3000"), "<base> و <base>:9000/x و http://localhost:3000");
  assert.equal(sanitize(`h ${HEX128} و ${PAIR} و ${ISO_DEC}/ و lat: ${LAT}`), "h <hash> و <gps> و <gps> و lat: <gps>");
  assert.equal(sanitize(`${["AKI", "AIOSFODNN7EXAMPLE"].join("")} و Bearer ${"abc123".repeat(4)}`), "<secret> و <secret>");
});

test("الشرط 6: النطاق يشمل infra/ و.github/ وملفات .env.example وapps/<تطبيق>/store", () => {
  withTmp((dir) => {
    const bad = "x https://evil-corp.io/y\n";
    writeTree(dir, {
      "allow.json": EMPTY_ALLOW_JSON,
      "docs/ok.md": "سليم\n",
      "infra/compose/c.yml": bad,
      ".github/workflows/w.yml": bad,
      "apps/web/.env.example": "URL=https://evil-corp.io/z\n",
      "apps/ios/store/s.md": bad,
      "services/deep/.env.example": "URL=https://evil-corp.io/z\n",
      "apps/web/src/skip.md": bad, // خارج النطاق
    });
    const r = runIn(dir, ["--json"]);
    assert.equal(r.code, 1);
    assert.deepEqual(JSON.parse(r.out).map((f) => f.file), [
      ".github/workflows/w.yml", "apps/ios/store/s.md", "apps/web/.env.example", "infra/compose/c.yml", "services/deep/.env.example",
    ]);
  });
});

test("run (الشرط 7 و8): مجلد apps/ غائب لا يُسقط الأداة، والخروج 0 للنظيف و1 للتسريب و--json يطبع المصفوفة", () => {
  withTmp((dir) => {
    writeTree(dir, { "allow.json": EMPTY_ALLOW_JSON, "docs/ok.md": "نص سليم عن localhost\n" });
    const clean = runIn(dir);
    assert.equal(clean.code, 0);
    assert.match(clean.out, /لا تسريب غير مسموح/);
    assert.equal(runIn(dir, ["--json"]).out, "[]");

    writeTree(dir, { "docs/bad.md": `المصدر https://evil-corp.io/feed\nsha256 ${HEX64}\nat ${PAIR}\n` });
    const text = runIn(dir);
    assert.equal(text.code, 1);
    assert.deepEqual(text.out.split("\n").slice(0, 4), [
      "docs/bad.md:1: domain: host", "docs/bad.md:2: hash: sha256", "docs/bad.md:3: gps: decimal",
      "فُحص 2 ملفًا.",
    ]);
    const json = runIn(dir, ["--json"]);
    assert.equal(json.code, 1);
    assert.deepEqual(JSON.parse(json.out), [
      { file: "docs/bad.md", line: 1, type: "domain", kind: "host" },
      { file: "docs/bad.md", line: 2, type: "hash", kind: "sha256" },
      { file: "docs/bad.md", line: 3, type: "gps", kind: "decimal" },
    ]);
    // LEAK_CHECK_ROOTS يقصر الجذور (نسبةً إلى القاعدة).
    assert.equal(runIn(dir, [], { LEAK_CHECK_ROOTS: "docs/ok.md" }).code, 0);
  });
});

test("run: رمز الخروج الفعلي للعملية (0 و1 و2) عبر تشغيل الأداة كما تُشغَّل", () => {
  withTmp((dir) => {
    writeTree(dir, { "allow.json": EMPTY_ALLOW_JSON, "docs/ok.md": "سليم\n" });
    const exec = (extra = {}) => spawnSync(process.execPath, [join(HERE, "leak-check.mjs")], {
      encoding: "utf8", env: { PATH: process.env.PATH, LEAK_CHECK_BASE: dir, LEAK_CHECK_ALLOW: join(dir, "allow.json"), ...extra },
    });
    assert.equal(exec().status, 0);
    writeTree(dir, { "docs/bad.md": `at ${PAIR}\n` });
    const bad = exec();
    assert.equal(bad.status, 1);
    assert.ok(!bad.stdout.includes(LAT.slice(0, 4)), "جزء من الإحداثي في خرج العملية");
    assert.equal(exec({ LEAK_CHECK_ALLOW: join(dir, "missing.json") }).status, 2);
  });
});

test("run: قائمة سماح مفقودة أو بلا أسباب أو بلا ملفات للفحص تعني خروج 2 برسالة بلا قيم", () => {
  const r = run([], { LEAK_CHECK_ALLOW: "/nonexistent/allow.json", LEAK_CHECK_ROOTS: "docs" }, { log() {}, error() {} });
  assert.equal(r.code, 2);
  withTmp((dir) => {
    writeTree(dir, { "docs/ok.md": "سليم\n", "allow.json": JSON.stringify({ domains: [{ value: "keep-this-private.io" }] }) });
    const bad = runIn(dir);
    assert.equal(bad.code, 2);
    assert.ok(!bad.err.includes("keep-this-private"));
    writeTree(dir, { "allow.json": EMPTY_ALLOW_JSON });
    const empty = runIn(dir, [], { LEAK_CHECK_ROOTS: "nowhere" });
    assert.equal(empty.code, 2);
  });
});

test("scan: الجذور المتداخلة لا تكرر الملف، وتُملأ إحصاءات الفحص", () => {
  withTmp((dir) => {
    writeTree(dir, { "infra/.env.example": "A=1\n", "infra/img.png": "x" });
    const stats = {};
    const findings = scan([{ base: dir, path: join(dir, "infra") }, { base: dir, path: join(dir, "infra/.env.example") }], ALLOW, stats);
    assert.equal(findings.length, 0);
    assert.equal(stats.scanned, 1);
    assert.deepEqual(stats.skipped, { ".png": 1 });
  });
});
