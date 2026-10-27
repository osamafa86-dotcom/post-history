#!/usr/bin/env node
// فاحص التسريب في المخرجات النصية: يمسح docs/ وtools/acceptance/ وapps/<التطبيق>/store/ (نصوصًا لا صورًا)
// بحثًا عن نطاقات ومضيفين وعناوين IP وبريدات حقيقية وبصمات تجزئة وأسرار (رموز TOTP ومفاتيح وJWT).
// الخروج 1 عند أي تطابق غير مسموح في tools/leak-check.allow.json. sanitize() تُصدَّر لتنقيح مخرجات أدوات أخرى.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// نصوص نفحصها؛ ما عداها (png وغيرها) يُتخطى، ومع ذلك يُشم النصف الثنائي بالبايت الصفري.
const TEXT_EXT = new Set([".md", ".txt", ".json", ".mjs", ".ts", ".yml", ".yaml", ".sh", ".csv"]);
const CODE_EXT = new Set([".mjs", ".ts", ".sh", ".json"]);

// نطاقات عامة شائعة + أي لاحقة من حرفين تُحسب رمز بلد؛ في ملفات الكود لا يُحسب النطاق إلا داخل نص مقتبس أو URL.
const GENERIC_TLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "biz", "info", "pro", "name", "app", "dev", "io", "ai",
  "cloud", "store", "online", "site", "tech", "xyz", "news", "media", "email", "tools", "systems", "agency",
  "video", "live", "press", "blog", "shop", "art", "design", "digital", "network", "solutions", "services",
  "world", "today", "company", "guru", "expert", "zone", "center", "city", "support", "chat", "community",
  "foundation", "international", "technology", "software", "studio", "group", "academy", "wiki",
]);

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

const DOMAIN_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /(?<![0-9A-Za-z_.:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?:(?::[0-9A-Fa-f]{1,4}){1,6})|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:))(?![0-9A-Fa-f:])/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const SECRET_RE = /whsec_[A-Za-z0-9_]+|sk_live_[A-Za-z0-9_]+|sk_test_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const TOTP_RE = /(?:totp|otpauth|base32)[^\n]{0,40}?\b[A-Z2-7]{16,}\b/gi;
const HASH_CTX_RE = /(?:sha\d*-?\d*|hash|fingerprint|بصمة|تجزئة)/i;
const HEX_RE = /\b[0-9a-f]{16,64}\b/g;

// نطاقات خاصة وموثقة لا تُعد تسريبًا (ثوابت معايير RFC لا عناوين بنية).
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
  // اللواحق العامة بلا حساسية لحالة الحروف، ورموز البلدان صغيرة حصرًا فلا يُحسب «ID» الخاص بالحقول نطاقًا.
  return GENERIC_TLDS.has(tld) || CCTLD.has(label);
}

/** في ملفات الكود لا يُحسب المضيف إلا داخل اقتباس أو بعد شرطة مائلة (مسار URL)، لتفادي وصول الخصائص مثل r.video. */
function isStringContext(text, index) {
  const prev = text[index - 1] ?? "";
  return prev === "'" || prev === "\"" || prev === "`" || prev === "/";
}

/** يقصر المطابقة على ست عشرية فيها حرف واحد على الأقل لاستبعاد الأعداد العشرية الطويلة. */
function hasHexLetter(s) {
  return /[a-f]/.test(s);
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

function loadAllow(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  return {
    domains: data.domains ?? [],
    ips: new Set(data.ips ?? []),
    emails: new Set(data.emails ?? []),
    hashes: new Set((data.hashes ?? []).map((h) => h.toLowerCase())),
    secrets: new Set(data.secrets ?? []),
    hashPaths: data.hashPaths ?? [],
  };
}

function domainAllowed(token, allow) {
  const t = token.toLowerCase();
  return allow.domains.some((d) => t === d || t.endsWith(`.${d}`));
}

function emailAllowed(email, allow) {
  if (allow.emails.has(email.toLowerCase())) return true;
  return domainAllowed(email.split("@")[1], allow);
}

function hashAllowed(hex, relPath, allow) {
  if (allow.hashes.has(hex.toLowerCase())) return true;
  return allow.hashPaths.some((p) => globMatch(p, relPath));
}

function secretAllowed(value, allow) {
  return allow.secrets.has(value);
}

function isTextFile(path) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (path.includes(".")) return false;
  const head = readFileSync(path).subarray(0, 8192);
  return !head.includes(0);
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const item of readdirSync(dir)) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (isTextFile(path)) out.push(path);
  }
  return out;
}

/** يمسح ملفًا واحدًا ويعيد التطابقات غير المسموحة: { file, line, type, match }. */
export function scanFile(path, relPath, allow) {
  const text = readFileSync(path, "utf8");
  const isCode = CODE_EXT.has(path.slice(path.lastIndexOf(".")).toLowerCase());
  const findings = [];
  const lines = text.split("\n");
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const add = (index, type, match) => findings.push({ file: relPath, line: lineOf(index), type, match });

  for (const m of text.matchAll(DOMAIN_RE)) {
    const token = m[0];
    if (!isDomainToken(token)) continue;
    if (text[m.index + token.length] === "(") continue; // استدعاء دالة لا نطاق
    if (isCode && !isStringContext(text, m.index)) continue;
    if (text[m.index - 1] === "@") continue; // الجزء الأيمن من بريد؛ يعالجه فحص البريد
    if (!domainAllowed(token, allow)) add(m.index, "domain", token);
  }
  for (const m of text.matchAll(IP_RE)) {
    if (isPrivateIp(m[0]) || allow.ips.has(m[0])) continue;
    add(m.index, "ip", m[0]);
  }
  for (const m of text.matchAll(IPV6_RE)) {
    const v = m[0];
    if (!/[a-fA-F]/.test(v)) continue; // «4:2:2» وأشباهها من نسب الصورة ليست عناوين
    if (v === "::1" || v.toLowerCase().startsWith("2001:db8:")) continue; // loopback وموثق
    add(m.index, "ip", v);
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!emailAllowed(m[0], allow)) add(m.index, "email", m[0]);
  }
  for (const m of text.matchAll(SECRET_RE)) {
    if (!secretAllowed(m[0], allow)) add(m.index, "secret", mask(m[0]));
  }
  for (const m of text.matchAll(TOTP_RE)) {
    const value = m[0].match(/[A-Z2-7]{16,}/i)[0].toUpperCase();
    if (!secretAllowed(value, allow)) add(m.index, "secret", mask(value));
  }
  // بصمة: ست عشرية طويلة بجوار كلمة سياق في السطر نفسه.
  lines.forEach((line, i) => {
    if (!HASH_CTX_RE.test(line)) return;
    for (const m of line.matchAll(HEX_RE)) {
      if (!hasHexLetter(m[0])) continue;
      if (!hashAllowed(m[0], relPath, allow)) {
        findings.push({ file: relPath, line: i + 1, type: "hash", match: mask(m[0]) });
      }
    }
  });
  return findings;
}

function mask(value) {
  return value.length <= 8 ? "****" : `${value.slice(0, 6)}…`;
}

export function scan(roots, allow) {
  const findings = [];
  for (const root of roots) {
    for (const file of walk(root.path)) {
      findings.push(...scanFile(file, relative(root.base, file).split(sep).join("/"), allow));
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.type.localeCompare(b.type));
}

export function formatFindings(findings) {
  return findings.map((f) => `${f.file}:${f.line}: ${f.type}: ${f.match}`).join("\n");
}

/**
 * تنقيح نص للمخرجات: المضيفون والنطاقات والعناوين ← <base>، والبصمات الطويلة ← <hash>، والأسرار ← <secret>.
 * لا يعتمد قائمة السماح: الغرض إخراج آمن حتى من القيم المسموح عرضها في المستودع.
 */
export function sanitize(text) {
  return String(text)
    .replace(SECRET_RE, "<secret>")
    .replace(new RegExp(TOTP_RE.source, "gi"), (m) => m.replace(/[A-Z2-7]{16,}/i, "<secret>"))
    .replace(EMAIL_RE, (m) => (isDomainToken(m.split("@")[1]) ? `<base>` : m))
    .replace(/https?:\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g, (m) => (isDomainToken(m.slice(m.indexOf("://") + 3)) ? "<base>" : m))
    .replace(DOMAIN_RE, (m) => (isDomainToken(m) ? "<base>" : m))
    .replace(IP_RE, (m) => (m.split(".").every((p) => Number(p) <= 255) ? "<base>" : m))
    .replace(IPV6_RE, (m) => (/[a-fA-F]/.test(m) ? "<base>" : m))
    .replace(/\b[0-9a-f]{16,64}\b/g, (m) => (hasHexLetter(m) ? "<hash>" : m));
}

export function run(argv = process.argv.slice(2), env = process.env) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(toolsDir, "..");
  const allowFile = resolve(env.LEAK_CHECK_ALLOW ?? join(toolsDir, "leak-check.allow.json"));
  let allow;
  try {
    allow = loadAllow(allowFile);
  } catch (error) {
    console.error(`تعذر تحميل قائمة السماح: ${error.message}`);
    return { code: 2 };
  }

  const rootSpecs = env.LEAK_CHECK_ROOTS
    ? env.LEAK_CHECK_ROOTS.split(":").filter(Boolean).map((p) => resolve(root, p))
    : [
      join(root, "docs"),
      join(root, "tools/acceptance"),
      ...readdirSync(join(root, "apps")).map((a) => join(root, "apps", a, "store")).filter(existsSync),
    ];
  const roots = rootSpecs.map((p) => ({ base: root, path: p }));

  let findings;
  try {
    findings = scan(roots, allow);
  } catch (error) {
    console.error(`تعذر الفحص: ${error.message}`);
    return { code: 2 };
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(findings, null, 1));
  } else if (findings.length) {
    console.log(formatFindings(findings));
  } else {
    console.log("لا تسريب غير مسموح في النطاقات المفحوصة.");
  }
  return { code: findings.length ? 1 : 0, findings };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { code } = await run();
  process.exitCode = code;
}
