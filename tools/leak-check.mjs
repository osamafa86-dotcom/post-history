#!/usr/bin/env node
// فاحص التسريب في المخرجات النصية: يمسح docs/ وtools/acceptance/ وapps/<التطبيق>/store/ وinfra/ و.github/
// وملفات .env.example (نصوصًا لا صورًا) بحثًا عن نطاقات ومضيفين وعناوين IP وبريدات وبصمات تجزئة
// وإحداثيات GPS وأسرار (رموز TOTP ومفاتيح وJWT).
// القاعدة الحاكمة: لا يُطبع أي جزء من القيمة المطابقة، لا في النص ولا في JSON؛ نوع التطابق وملف:سطر فقط.
// الخروج 1 عند أي تطابق غير مسموح في tools/leak-check.allow.json. sanitize() تُصدَّر لتنقيح مخرجات أدوات أخرى.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// نصوص نعرفها بامتدادها؛ والامتدادات الثنائية المعروفة تُتخطى وتُعدّ في الملخص؛ وما عداهما يُشم بالبايت الصفري
// (Caddyfile.main وmodels.lock وDockerfile وغيرها فلا يفلت ملف بنية لأن امتداده غريب).
const TEXT_EXT = new Set([
  ".md", ".txt", ".json", ".mjs", ".cjs", ".js", ".ts", ".yml", ".yaml", ".sh", ".csv", ".html", ".xml", ".plist",
  ".strings", ".toml", ".kt", ".kts", ".swift", ".py", ".conf", ".ini", ".properties", ".sql", ".tf", ".env", ".example",
  ".svg", ".css", ".gradle", ".lock",
]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".heic", ".tiff", ".mp4", ".mov", ".webm", ".wav", ".mp3",
  ".flac", ".m4a", ".pdf", ".woff", ".woff2", ".otf", ".ttf", ".zip", ".gz", ".tgz", ".tar", ".apk", ".aab", ".ipa",
  ".jar", ".wasm", ".p12", ".bin", ".keystore", ".jks",
]);
const CODE_EXT = new Set([".mjs", ".cjs", ".js", ".ts", ".sh", ".json", ".py", ".kt", ".kts", ".swift"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
// ملفات البيئة النموذجية (.env.example وx.env.example وx.env.prod.example) في أي مكان من المستودع.
const ENV_EXAMPLE_RE = /(?:^|\.)env(?:\.[\w-]+)*\.example$/;

// نطاقات عامة شائعة + أي لاحقة من حرفين تُحسب رمز بلد؛ في ملفات الكود لا يُحسب النطاق إلا داخل نص مقتبس أو URL.
const GENERIC_TLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "biz", "info", "pro", "name", "app", "dev", "io", "ai",
  "cloud", "store", "online", "site", "tech", "xyz", "news", "media", "email", "tools", "systems", "agency",
  "video", "live", "press", "blog", "shop", "art", "design", "digital", "network", "solutions", "services",
  "world", "today", "company", "guru", "expert", "zone", "center", "city", "support", "chat", "community",
  "foundation", "international", "technology", "software", "studio", "group", "academy", "wiki",
]);

// لواحق الشبكات الداخلية: مضيف تحتها يكشف بنية داخلية مهما كان اسمه (شرط الأمن 4).
const INTERNAL_TLDS = new Set(["internal", "local", "lan", "corp", "home", "intranet", "localdomain", "private"]);

// جذور تعابير GitHub Actions (steps.x.outputs.media) وليست أسماء مضيفين.
const EXPR_ROOTS = new Set(["steps", "needs", "github", "inputs", "matrix", "env", "secrets", "vars", "runner", "job", "jobs"]);

// لواحق ملفات شائعة تُستبعد من كشف النطاقات (file.md وscript.sh وما شابه ليست مضيفين).
const FILE_LABELS = new Set([
  "md", "sh", "py", "kt", "kts", "swift", "mjs", "cjs", "js", "jsx", "ts", "tsx", "css", "scss", "vue",
  "json", "yml", "yaml", "toml", "ini", "cfg", "conf", "xml", "html", "txt", "csv", "sql", "tf", "gradle",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "mp4", "mov", "webm", "wav", "mp3", "flac",
  "vtt", "srt", "pdf", "docx", "xlsx", "pem", "crt", "key", "pub", "p12", "plist", "wasm", "proto",
  "jar", "apk", "aab", "ipa", "gz", "tgz", "zip", "map", "snap", "lock", "rb", "go", "rs", "php", "pl",
  "lua", "h", "c", "cpp", "java", "otf", "ttf", "woff", "woff2", "heic", "tiff", "lg", "xl",
]);

// رموز البلدان الفعلية (ccTLD) — حرفان صغيران فقط، فـ«ID» و«vl» ليست نطاقات.
const CCTLD = new Set("ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw".split(" "));

// «(?!-[A-Za-z0-9])»: لا يُقتطع اسم مركّب بشرطة (preview.no-device) فتُحسب لاحقته رمز بلد.
const DOMAIN_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b(?!-[A-Za-z0-9])/g;
// سلطة URL: المضيف (دون userinfo والمنفذ) بأي لاحقة، حتى بلا نقطة (اسم خدمة داخلي)؛ يُتخطى القالب ${...} و<...>.
// بروتوكولات المفحوص مضيفها: الويب وقواعد البيانات والطوابير والتخزين وغيرها (متابعة H: لا تقتصر على http).
const URL_SCHEMES = "https?|wss?|redis|rediss|postgres(?:ql)?|amqps?|s3|mysql|mariadb|mongodb(?:\\+srv)?|nats";
const URL_HOST_RE = new RegExp(`\\b(?:${URL_SCHEMES})://(?:[^\\s/?#@"'\`<>]*@)?([A-Za-z0-9][A-Za-z0-9._-]*)(?![A-Za-z0-9._\${}<%*-])`, "g");
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /(?<![0-9A-Za-z_.:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?:(?::[0-9A-Fa-f]{1,4}){1,6})|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:))(?![0-9A-Fa-f:])/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;

// الأسرار: [النوع، النمط]. كل نمط يُستعمل في الفحص وفي sanitize.
const SECRET_DEFS = [
  ["whsec", /whsec_[A-Za-z0-9_]+/g],
  ["sk", /sk_(?:live|test)_[A-Za-z0-9_]+/g],
  ["jwt", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g], // يشمل PGP PRIVATE KEY BLOCK
  ["aws", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ["google", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["bearer", /\bBearer\s+(?=[A-Za-z0-9._~+/-]*\d)(?=[A-Za-z0-9._~+/-]*[A-Za-z])[A-Za-z0-9._~+/-]{16,}=*/g],
];
const TOTP_RE = /(?:totp|otpauth|base32)[^\n]{0,40}?\b[A-Z2-7]{16,}\b/gi;
const HASH_CTX_RE = /(?:sha\d*-?\d*|hash|fingerprint|بصمة|تجزئة)/i;
// ست عشرية 16–128 خانة؛ 64 (SHA-256) و128 (SHA-512) تُعلَّمان بلا شرط سياق، وما عداهما بكلمة سياق في السطر نفسه.
const HEX_RE = /(?<![0-9A-Za-z])(?:0[xX])?([0-9A-Fa-f]{16,128})(?![0-9A-Za-z])/g;
const HEX_KIND = { 32: "md5", 40: "sha1", 64: "sha256", 128: "sha512" };
const OCI_REF_RE = /[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:$/;
const OCI_SCOPE_RE = /^(?:infra|\.github)\//;

// إحداثيات: أزواج عشرية بأربع خانات كسرية فأكثر (~11 م)، وصيغة ISO 6709، وlat/lon بقيمة.
const GPS_PAIR_RE = /(?<![\w.])(-?\d{1,3}\.\d{4,})\s*[,;]\s*(-?\d{1,3}\.\d{4,})(?![\d]|\.\d)/g;
// مسماة: lat/lon بقيمة عشرية بنقطتين أو بمسافة، ولو حُذفت أصفارها الأخيرة (متابعة H)؛ يُتحقق من المدى باسم المحور.
const GPS_NAMED_RE = /\b(lat(?:itude)?|lon(?:g|gitude)?|lng)\b["']?\s*[:=]?\s*["']?(-?\d{1,3}\.\d+)/gi;
// حروف الاتجاه: 31.5N 34.4E؛ لا يُحسب الرمز وحده إحداثيًا (قد تكون «12.5W» قدرة) بل زوج N/S مع E/W في السطر نفسه.
const GPS_DIR_TOKEN_RE = /(?<![\w.])(-?\d{1,3}\.\d+)\s*°?\s*([NSEW])(?![A-Za-z0-9.])/g;
const ISO6709_RE = /(?<![\w.])[+-]\d{2}(?:\d{2}(?:\d{2})?)?(?:\.\d+)?[+-]\d{3}(?:\d{2}(?:\d{2})?)?(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?(?:CRS\w+)?\//g;
const ISO6709_DEC_RE = /(?<![\w.])[+-]\d{2}\.\d{4,}[+-]\d{3}\.\d{4,}(?:[+-]\d+(?:\.\d+)?)?(?:CRS\w+)?\/?(?![\d.])/g;

// نطاقات خاصة وموثقة لا تُعد تسريبًا (ثوابت معايير RFC لا عناوين بنية). قرار موثق في leak-check.md.
const DOC_OR_PRIVATE_V4 = [
  [0x0A000000, 0xFF000000], // 10.0.0.0/8
  [0x7F000000, 0xFF000000], // 127.0.0.0/8
  [0xA9FE0000, 0xFFFF0000], // 169.254.0.0/16
  [0xAC100000, 0xFFF00000], // 172.16.0.0/12
  [0xC0A80000, 0xFFFF0000], // 192.168.0.0/16
  [0xC0000200, 0xFFFFFF00], // 192.0.2.0/24 TEST-NET-1
  [0xC6336400, 0xFFFFFF00], // 198.51.100.0/24 TEST-NET-2
  [0xCB007100, 0xFFFFFF00], // 203.0.113.0/24 TEST-NET-3
];

function isPrivateIp(ip) {
  if (ip === "0.0.0.0" || ip === "255.255.255.255") return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => p > 255)) return true; // ليس IPv4 صالحًا فلا نبلغ عنه عنوانًا
  const v = (parts[0] * 256 ** 3) + (parts[1] * 256 ** 2) + (parts[2] * 256) + parts[3];
  return DOC_OR_PRIVATE_V4.some(([net, mask]) => ((v & mask) >>> 0) === net);
}

function isDomainToken(token) {
  const label = token.split(".").at(-1);
  const tld = label.toLowerCase();
  if (FILE_LABELS.has(tld)) return false;
  if (EXPR_ROOTS.has(token.split(".")[0].toLowerCase())) return false;
  // اللواحق العامة والداخلية بلا حساسية لحالة الحروف، ورموز البلدان صغيرة حصرًا فلا يُحسب «ID» الخاص بالحقول نطاقًا.
  return GENERIC_TLDS.has(tld) || INTERNAL_TLDS.has(tld) || CCTLD.has(label);
}

/** معرّف برمجي لا مضيف: حالة حروف مختلطة داخل الاسم (LoginRequest.email)؛ المضيفون صغيرة كلها أو كبيرة كلها. */
function looksLikeIdentifier(token) {
  return /[a-z][A-Z]/.test(token);
}

function hostKind(host) {
  return INTERNAL_TLDS.has(host.split(".").at(-1).toLowerCase()) ? "internal" : "host";
}

/** في ملفات الكود لا يُحسب المضيف إلا داخل اقتباس أو بعد شرطة مائلة (مسار URL)، لتفادي وصول الخصائص مثل r.video. */
function isStringContext(text, index) {
  const prev = text[index - 1] ?? "";
  return prev === "'" || prev === "\"" || prev === "`" || prev === "/";
}

/** يقصر المطابقة على ست عشرية فيها حرف واحد على الأقل لاستبعاد الأعداد العشرية الطويلة. */
function hasHexLetter(s) {
  return /[a-fA-F]/.test(s);
}

/** مطابقة غلوب دنيا: ** أي مقاطع، * داخل المقطع. */
export function globMatch(pattern, path) {
  const p = pattern.split("/");
  const s = path.split("/");
  const match = (pi, si) => {
    if (pi === p.length) return si === s.length;
    if (p[pi] === "**") return match(pi + 1, si) || (si < s.length && match(pi, si + 1));
    if (si >= s.length) return false;
    const seg = new RegExp(`^${p[pi].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return seg.test(s[si]) && match(pi + 1, si + 1);
  };
  return match(0, 0);
}

// ———— قائمة السماح: لكل مدخل سبب إلزامي، و«paths» اختيارية تقصر السماح على ملفات بعينها ————

const ALLOW_KEYS = ["domains", "ips", "emails", "hashes", "secrets", "gps"];
// الأسرار والإحداثيات تُدرج بـsha256 لقيمتها لا بنصها: لا سر ولا إحداثي حرفي في المستودع ولو اصطناعيًا.
const DIGEST_KEYS = new Set(["secrets", "gps"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function normalizeValue(key, value) {
  if (key === "gps") return value.replace(/\s+/g, "");
  return key === "emails" || key === "domains" || key === "hashes" ? value.toLowerCase() : value;
}

/** القيمة كما تُخزَّن للمقارنة: النص المُطبَّع، أو بصمته لمفاتيح DIGEST_KEYS. */
function comparable(key, value) {
  const v = normalizeValue(key, value);
  return DIGEST_KEYS.has(key) ? sha256(v) : v;
}

/**
 * يحوّل JSON قائمة السماح إلى بنية داخلية ويرفض ما ينقصه سبب. رسائل الخطأ تذكر المفتاح والفهرس لا القيمة.
 * مدخل عادي: { value, reason, paths? }؛ سرّ أو إحداثي: { sha256, reason, paths? } (بصمة القيمة المُطبَّعة لا نصها).
 * sha256 للإحداثي تُحسب على «lat,lon» بلا مسافات، وللسر على النص كما هو (TOTP بحروف كبيرة).
 */
export function parseAllow(data) {
  if (data.hashPaths !== undefined) {
    throw new Error("hashPaths أُلغي: لا إعفاء مسار شامل؛ أدرج كل بصمة معروفة بقيمتها في hashes مع سببها");
  }
  const allow = {};
  for (const key of ALLOW_KEYS) {
    allow[key] = (data[key] ?? []).map((entry, i) => {
      const where = `${key}[${i}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`${where}: المدخل كائن { ${DIGEST_KEYS.has(key) ? "sha256" : "value"}, reason }`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length < 8) {
        throw new Error(`${where}: السبب إلزامي (ثمانية محارف فأكثر)`);
      }
      const raw = DIGEST_KEYS.has(key) ? entry.sha256 : entry.value;
      if (typeof raw !== "string" || !raw) {
        throw new Error(DIGEST_KEYS.has(key) ? `${where}: الحقل sha256 إلزامي (بصمة القيمة لا نصها)` : `${where}: القيمة ناقصة`);
      }
      if (DIGEST_KEYS.has(key) && !/^[0-9a-f]{64}$/.test(raw)) throw new Error(`${where}: sha256 يلزمه 64 خانة ست عشرية صغيرة`);
      const paths = entry.paths ?? [];
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || !p)) throw new Error(`${where}: paths قائمة أنماط`);
      return { value: DIGEST_KEYS.has(key) ? raw : normalizeValue(key, raw), reason: entry.reason.trim(), paths };
    });
  }
  return allow;
}

export function loadAllow(file) {
  return parseAllow(JSON.parse(readFileSync(file, "utf8")));
}

function inPaths(entry, relPath) {
  return entry.paths.length === 0 || entry.paths.some((p) => globMatch(p, relPath));
}

function allowedValue(allow, key, value, relPath) {
  const v = comparable(key, value);
  return allow[key].some((e) => e.value === v && inPaths(e, relPath));
}

function domainAllowed(token, allow, relPath) {
  const t = token.toLowerCase();
  return allow.domains.some((e) => (t === e.value || t.endsWith(`.${e.value}`)) && inPaths(e, relPath));
}

function emailAllowed(email, allow, relPath) {
  return allowedValue(allow, "emails", email, relPath) || domainAllowed(email.split("@")[1], allow, relPath);
}

function secretAllowed(value, allow, relPath) {
  return allowedValue(allow, "secrets", value, relPath);
}

// ———— الإحداثيات ————

function validLatLon(a, b) {
  const x = Math.abs(Number(a));
  const y = Math.abs(Number(b));
  return (x <= 90 && y <= 180) || (x <= 180 && y <= 90);
}

/** ISO 6709: تحقق من درجات الإحداثي (±DD[MM[SS]] و±DDD[MM[SS]]) كي لا تُحسب أرقام عشوائية إحداثيًا. */
function validIso6709(text) {
  const m = text.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return false;
  const digits = (s) => s.replace(/^[+-]/, "").split(".")[0];
  const [latInt, lonInt] = [digits(m[1]), digits(m[2])];
  if (![2, 4, 6].includes(latInt.length) || ![3, 5, 7].includes(lonInt.length)) return false;
  const part = (s, from, len) => Number(s.slice(from, from + len));
  if (part(latInt, 0, 2) > 90 || part(lonInt, 0, 3) > 180) return false;
  if (latInt.length > 2 && part(latInt, 2, 2) >= 60) return false;
  if (lonInt.length > 3 && part(lonInt, 3, 2) >= 60) return false;
  return true;
}

// ———— الملفات ————

function isTextFile(path) {
  const base = basename(path);
  if (ENV_EXAMPLE_RE.test(base)) return true;
  const ext = extname(base).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (BINARY_EXT.has(ext)) return false;
  const head = readFileSync(path).subarray(0, 8192);
  return !head.includes(0);
}

/** يعيد { files, skipped }: الملفات النصية تحت المسار (أو المسار نفسه إن كان ملفًا) وعدّاد الامتدادات المتخطاة. */
function walk(path, out = { files: [], skipped: {} }) {
  if (!existsSync(path)) return out;
  if (statSync(path).isDirectory()) {
    for (const item of readdirSync(path).sort()) {
      if (!SKIP_DIRS.has(item)) walk(join(path, item), out);
    }
  } else if (isTextFile(path)) {
    out.files.push(path);
  } else {
    const ext = extname(path).toLowerCase() || "(بلا امتداد)";
    out.skipped[ext] = (out.skipped[ext] ?? 0) + 1;
  }
  return out;
}

/** ملفات .env.example في أي مكان من المستودع (دون .git وnode_modules). */
function findEnvExamples(base) {
  const found = [];
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) visit(join(dir, item.name));
      } else if (ENV_EXAMPLE_RE.test(item.name)) {
        found.push(join(dir, item.name));
      }
    }
  };
  visit(base);
  return found.sort();
}

/** يمسح ملفًا واحدًا ويعيد التطابقات غير المسموحة: { file, line, type, kind } — لا قيمة مطابقة فيها. */
export function scanFile(path, relPath, allow) {
  const text = readFileSync(path, "utf8");
  const isCode = CODE_EXT.has(extname(path).toLowerCase());
  const findings = [];
  const seen = new Set();
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const add = (index, type, kind) => {
    const line = lineOf(index);
    const key = `${line}:${type}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: relPath, line, type, kind });
  };

  for (const m of text.matchAll(DOMAIN_RE)) {
    const token = m[0];
    if (!isDomainToken(token)) continue;
    if (text[m.index + token.length] === "(") continue; // استدعاء دالة لا نطاق
    if (isCode && !isStringContext(text, m.index)) continue;
    const prev = text[m.index - 1];
    if (prev === "@") continue; // الجزء الأيمن من بريد؛ يعالجه فحص البريد
    if (prev === ".") continue; // اسم ملف مخفي مثل .env.local
    if (looksLikeIdentifier(token)) continue;
    if (!domainAllowed(token, allow, relPath)) add(m.index, "domain", hostKind(token));
  }
  // سلطة URL غير مسموحة تُعلَّم أيًّا كانت لاحقتها، حتى اسم الخدمة بلا نقطة (شرط الأمن 4).
  for (const m of text.matchAll(URL_HOST_RE)) {
    const host = m[1].replace(/[.]+$/, "");
    if (/^\d+(\.\d+){3}$/.test(host)) continue; // عنوان؛ تعالجه قواعد IP
    if (looksLikeIdentifier(host)) continue;
    if (!domainAllowed(host, allow, relPath)) add(m.index, "domain", hostKind(host));
  }
  for (const m of text.matchAll(IP_RE)) {
    if (isPrivateIp(m[0]) || allowedValue(allow, "ips", m[0], relPath)) continue;
    add(m.index, "ip", "v4");
  }
  for (const m of text.matchAll(IPV6_RE)) {
    const v = m[0];
    if (!/[a-fA-F]/.test(v)) continue; // «4:2:2» وأشباهها من نسب الصورة ليست عناوين
    if (/^::ffff:\d{1,3}$/i.test(v)) continue; // بادئة IPv4 المُعيَّنة (::ffff:127.)؛ الجزء الرباعي تعالجه قواعد IPv4
    if (v === "::1" || v.toLowerCase().startsWith("2001:db8:")) continue; // loopback وموثق
    if (!allowedValue(allow, "ips", v, relPath)) add(m.index, "ip", "v6");
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!emailAllowed(m[0], allow, relPath)) add(m.index, "email", "address");
  }
  for (const [kind, re] of SECRET_DEFS) {
    for (const m of text.matchAll(re)) {
      if (!secretAllowed(m[0], allow, relPath)) add(m.index, "secret", kind);
    }
  }
  for (const m of text.matchAll(TOTP_RE)) {
    const value = m[0].match(/[A-Z2-7]{16,}/i)[0].toUpperCase();
    if (!secretAllowed(value, allow, relPath)) add(m.index, "secret", "totp");
  }
  // بصمة: 64 أو 128 خانة ست عشرية بلا شرط، وغيرهما (16–128) بكلمة سياق في السطر نفسه.
  for (const m of text.matchAll(HEX_RE)) {
    const hex = m[1]; // المجموعة الأولى: الخانات دون بادئة 0x إن وُجدت
    if (!hasHexLetter(hex)) continue;
    const strong = hex.length === 64 || hex.length === 128;
    // مرجع صورة حاوية مثبّتة بالبصمة (name:tag@sha256:…) في infra/ و.github/ فقط: بصمة صورة عامة لا بصمة مادة.
    if (hex.length === 64 && OCI_SCOPE_RE.test(relPath) && OCI_REF_RE.test(text.slice(Math.max(0, m.index - 200), m.index))) continue;
    if (!strong) {
      const from = text.lastIndexOf("\n", m.index - 1) + 1;
      const to = text.indexOf("\n", m.index);
      if (!HASH_CTX_RE.test(text.slice(from, to === -1 ? text.length : to))) continue;
    }
    if (!allowedValue(allow, "hashes", hex, relPath)) add(m.index, "hash", HEX_KIND[hex.length] ?? "hex");
  }
  for (const m of text.matchAll(GPS_PAIR_RE)) {
    if (!validLatLon(m[1], m[2])) continue;
    // قائمة أعداد عشرية (a, b, c…) ليست إحداثيًا: جار بفاصلة قبل الزوج أو بعده.
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (/\d\.\d+\s*,\s*$/.test(before) || /^\s*,\s*-?\d+\.\d+/.test(after)) continue;
    if (!allowedValue(allow, "gps", `${m[1]},${m[2]}`, relPath)) add(m.index, "gps", "decimal");
  }
  for (const m of text.matchAll(GPS_NAMED_RE)) {
    const limit = m[1].toLowerCase().startsWith("lat") ? 90 : 180;
    if (Math.abs(Number(m[2])) > limit) continue; // خارج مدى المحور: ليس إحداثيًا
    if (!allowedValue(allow, "gps", m[2], relPath)) add(m.index, "gps", "named");
  }
  // زوج حروف الاتجاه في السطر: رمز N/S ورمز E/W معًا، وبمدى المحور؛ القيمة المسموحة «lat,lon» (S وW سالبتان).
  const dirByLine = new Map();
  for (const m of text.matchAll(GPS_DIR_TOKEN_RE)) {
    const line = lineOf(m.index);
    const value = Number(m[1]);
    const dir = m[2];
    const limit = dir === "N" || dir === "S" ? 90 : 180;
    if (Math.abs(value) > limit) continue;
    const signed = dir === "S" || dir === "W" ? -value : value;
    const entry = dirByLine.get(line) ?? { index: m.index };
    if (dir === "N" || dir === "S") entry.lat = signed; else entry.lon = signed;
    dirByLine.set(line, entry);
  }
  for (const [line, e] of [...dirByLine].sort((a, b) => a[0] - b[0])) {
    if (e.lat === undefined || e.lon === undefined) continue; // رمز وحيد ليس إحداثيًا
    if (!allowedValue(allow, "gps", `${e.lat},${e.lon}`, relPath)) add(e.index, "gps", "dir");
  }
  for (const re of [ISO6709_RE, ISO6709_DEC_RE]) {
    for (const m of text.matchAll(re)) {
      if (validIso6709(m[0]) && !allowedValue(allow, "gps", m[0], relPath)) add(m.index, "gps", "iso6709");
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.type.localeCompare(b.type) || a.kind.localeCompare(b.kind));
}

/** يمسح الجذور (مجلدات أو ملفات) ويعيد التطابقات مرتبة؛ إن مُرِّر stats مُلئ بعدد الملفات المفحوصة والامتدادات المتخطاة. */
export function scan(roots, allow, stats = {}) {
  const findings = [];
  const done = new Set();
  stats.scanned = 0;
  stats.skipped = {};
  for (const root of roots) {
    const { files, skipped } = walk(root.path);
    for (const [ext, n] of Object.entries(skipped)) stats.skipped[ext] = (stats.skipped[ext] ?? 0) + n;
    for (const file of files) {
      if (done.has(file)) continue; // الجذور قد تتداخل (infra/ و.env.example داخله)
      done.add(file);
      stats.scanned += 1;
      findings.push(...scanFile(file, relative(root.base, file).split(sep).join("/"), allow));
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.type.localeCompare(b.type) || a.kind.localeCompare(b.kind));
}

export function formatFindings(findings) {
  return findings.map((f) => `${f.file}:${f.line}: ${f.type}: ${f.kind}`).join("\n");
}

/**
 * تنقيح نص للمخرجات: المضيفون والنطاقات والعناوين ← <base>، والبصمات الطويلة ← <hash>، والإحداثيات ← <gps>،
 * والأسرار ← <secret>. لا يعتمد قائمة السماح: الغرض إخراج آمن حتى من القيم المسموح عرضها في المستودع.
 */
export function sanitize(text) {
  let out = String(text);
  for (const [, re] of SECRET_DEFS) out = out.replace(re, "<secret>");
  out = out
    .replace(new RegExp(TOTP_RE.source, "gi"), (m) => m.replace(/[A-Z2-7]{16,}/i, "<secret>"))
    .replace(EMAIL_RE, (m) => (isDomainToken(m.split("@")[1]) ? "<base>" : m))
    .replace(new RegExp(`\\b(?:${URL_SCHEMES})://(?:[^\\s/?#@"'\`<>]*@)?([A-Za-z0-9][A-Za-z0-9._-]*)`, "g"), (m, host) => (host.toLowerCase() === "localhost" ? m : "<base>"))
    .replace(DOMAIN_RE, (m, offset, whole) => (isDomainToken(m) && whole[offset - 1] !== "." && !looksLikeIdentifier(m) ? "<base>" : m))
    .replace(IP_RE, (m) => (m.split(".").every((p) => Number(p) <= 255) ? "<base>" : m))
    .replace(IPV6_RE, (m) => (/[a-fA-F]/.test(m) ? "<base>" : m))
    .replace(HEX_RE, (m, g) => (hasHexLetter(g) ? "<hash>" : m))
    .replace(GPS_PAIR_RE, (m, a, b) => (validLatLon(a, b) ? "<gps>" : m))
    .replace(GPS_NAMED_RE, (m, name, v) => m.replace(v, "<gps>"))
    .replace(ISO6709_DEC_RE, (m) => (validIso6709(m) ? "<gps>" : m))
    .replace(ISO6709_RE, (m) => (validIso6709(m) ? "<gps>" : m));
  // أزواج حروف الاتجاه: تُقنَّع القيمة حيث اجتمع محورا N/S وE/W ضمن المدى في السطر نفسه (منطق الفحص نفسه).
  const inRange = (v, d) => Math.abs(Number(v)) <= (d === "N" || d === "S" ? 90 : 180);
  return out.split("\n").map((line) => {
    const tokens = [...line.matchAll(GPS_DIR_TOKEN_RE)].filter((t) => inRange(t[1], t[2]));
    if (!tokens.some((t) => t[2] === "N" || t[2] === "S") || !tokens.some((t) => t[2] === "E" || t[2] === "W")) return line;
    return line.replace(GPS_DIR_TOKEN_RE, (m, v, d) => (inRange(v, d) ? m.replace(v, "<gps>") : m));
  }).join("\n");
}

function defaultRoots(base) {
  let apps = [];
  try {
    apps = readdirSync(join(base, "apps")).map((a) => join(base, "apps", a, "store"));
  } catch {
    // لا مجلد apps/ (مستودع جزئي أو نسخة مصغّرة): يُتخطى بلا استثناء.
  }
  return [
    join(base, "docs"),
    join(base, "tools/acceptance"),
    ...apps,
    join(base, "infra"),
    join(base, ".github"),
    ...findEnvExamples(base),
  ];
}

export function run(argv = process.argv.slice(2), env = process.env, io = { log: console.log, error: console.error }) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const base = resolve(env.LEAK_CHECK_BASE ?? join(toolsDir, ".."));
  const allowFile = resolve(env.LEAK_CHECK_ALLOW ?? join(toolsDir, "leak-check.allow.json"));
  let allow;
  try {
    allow = loadAllow(allowFile);
  } catch (error) {
    io.error(`تعذر تحميل قائمة السماح: ${error.message}`);
    return { code: 2 };
  }

  const rootSpecs = env.LEAK_CHECK_ROOTS
    ? env.LEAK_CHECK_ROOTS.split(":").filter(Boolean).map((p) => resolve(base, p))
    : defaultRoots(base);
  const roots = rootSpecs.map((p) => ({ base, path: p }));

  let findings;
  const stats = {};
  try {
    findings = scan(roots, allow, stats);
  } catch (error) {
    io.error(`تعذر الفحص: ${error.message}`);
    return { code: 2 };
  }
  if (stats.scanned === 0) {
    io.error("لم يُعثر على أي ملف نصي للفحص؛ تحقق من الجذور.");
    return { code: 2 };
  }

  if (argv.includes("--json")) {
    io.log(JSON.stringify(findings, null, 1));
  } else {
    if (findings.length) io.log(formatFindings(findings));
    else io.log("لا تسريب غير مسموح في النطاقات المفحوصة.");
    const skipped = Object.entries(stats.skipped).map(([ext, n]) => `${ext}×${n}`).join(" ");
    io.log(`فُحص ${stats.scanned} ملفًا${skipped ? `؛ تُخطي (غير نصي): ${skipped}` : ""}.`);
  }
  return { code: findings.length ? 1 : 0, findings };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { code } = await run();
  process.exitCode = code;
}
