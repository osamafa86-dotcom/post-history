#!/usr/bin/env node
// تغطية العملاء لانحراف العقد: لكل عملية — هل هي في العقد، وهل هي في الخادم، ومن يستهلكها من العملاء
// (ويب apps/web/src/server، وiOS بعميله المولَّد من العقد، وأندرويد بعميله المولَّد وقت البناء).
// مكمّلة لأداة contract-drift.mjs (#346) ومستقلة عنها حتى تُدمج، فلا تشاركها الملف ولا تستوردها.
// الافتراضي تقرير وخروج 0؛ --strict يجعل الفروق خروجًا 1؛ --json يطبع التقرير كاملًا بصيغة JSON ليستهلكه وكيل آلي.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const DECORATOR = /@(Controller|Get|Post|Put|Patch|Delete)\s*\(\s*(?:'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)")?\s*\)/g;
const CONTROLLER_ANY = /@Controller\s*\(/g;
// الصيغة المدعومة من @Controller: بلا وسيط أو بنص حرفي واحد؛ ما عداها يُنبَّه عنه ولا يُحلَّل بصمت.
const CONTROLLER_LITERAL = /^@Controller\s*\(\s*(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*")?\s*\)/;
// نداءات واجهة الويب: عميل openapi-fetch مولَّد الأنواع، فالمسار نص حرفي يطابق مفاتيح العقد.
const WEB_CALL = /\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(\s*"(\/[^"]*)"/g;
// عميل iOS المولَّد (openapi-generator): لكل عملية دالة *WithRequestBuilder فيها مسار حرفي واحد ومنشئ واحد باسم الطريقة.
const IOS_GEN_PATH = /localVariablePath = "(\/[^"]*)"/g;
const IOS_GEN_METHOD = /\.init\(method: "([A-Z]+)"/g;
// استهلاك iOS: استدعاء ثابت على صنف مولَّد اسمه ينتهي بـ API (مثل AuthAPI.login أو AuthAPI.logoutWithRequestBuilder).
const IOS_CALL = /\b[A-Za-z_][A-Za-z0-9_]*API\.([A-Za-z_][A-Za-z0-9_]*?)(WithRequestBuilder)?\s*\(/g;
// استهلاك أندرويد: العميل يُولَّد وقت البناء فلا يُقرأ من المستودع؛ النداءات على نسخ يسمّيها المستودع بأسماء تنتهي بـ Api
// (مثل container.authApi.getMe أو uploadsApi.createUploadSession)، وأسماء الدوال هي operationId كما في العقد.
const ANDROID_CALL = /\b[A-Za-z_][A-Za-z0-9_]*Api\.([a-z][A-Za-z0-9_]*)\s*\(/g;

function unquote(value = "") {
  return value.replace(/\\(['"])/g, "$1");
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** يوحّد أسماء المعاملات والشرطات الأخيرة؛ /v1 بادئة تشغيل وليست جزءًا من مفاتيح paths في العقد. */
export function normalizePath(path) {
  const parts = String(path).trim().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return "/" + parts.map((part) => (/^:[^/]+|^\{[^/]+\}$/.test(part) ? "{}" : part)).join("/");
}

function yamlKey(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

/** يقرأ مستويات paths والعمليات وoperationId فقط، ولا يحاول تفسير بقية YAML. */
export function contractOperations(yaml) {
  const operations = [];
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  let inPaths = false;
  let pathsIndent = -1;
  let currentPath = null;
  let pathIndent = -1;
  let current = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    const match = line.match(/^\s*([^:#][^:]*):(?:\s+(.*))?$/);
    if (!match) continue;
    const key = yamlKey(match[1]);
    if (!inPaths) {
      if (indent === 0 && key === "paths") { inPaths = true; pathsIndent = indent; }
      continue;
    }
    if (indent <= pathsIndent) break;
    if (indent === pathsIndent + 2 && key.startsWith("/")) {
      currentPath = normalizePath(key);
      pathIndent = indent;
      current = null;
      continue;
    }
    if (currentPath && indent === pathIndent + 2 && METHODS.has(key.toLowerCase())) {
      current = { method: key.toLowerCase(), path: currentPath, operationId: null };
      operations.push(current);
      continue;
    }
    if (current && indent >= pathIndent + 4 && key === "operationId") {
      current.operationId = (match[2] ?? "").trim() || null;
      continue;
    }
    if (indent === pathIndent + 2) current = null;
  }
  return operations;
}

/** يدعم أكثر من Controller في الملف، وأسماء معاملات مختلفة عن العقد. */
export function controllerRoutes(source, file = "<memory>") {
  const routes = [];
  let prefix = "";
  DECORATOR.lastIndex = 0;
  for (let match; (match = DECORATOR.exec(source));) {
    const [, decorator, single, double] = match;
    const path = unquote(single ?? double ?? "");
    if (decorator === "Controller") { prefix = path; continue; }
    routes.push({
      method: decorator.toLowerCase(),
      path: normalizePath(`${prefix}/${path}`),
      file,
      line: lineOf(source, match.index),
    });
  }
  return routes;
}

/** كل @Controller وسيطه ليس نصًا حرفيًا يُدرج تحذيرًا بدل أن يغيب عن المقارنة بصمت. */
export function unparsedControllers(source, file = "<memory>") {
  const unparsed = [];
  CONTROLLER_ANY.lastIndex = 0;
  for (let match; (match = CONTROLLER_ANY.exec(source));) {
    if (!CONTROLLER_LITERAL.test(source.slice(match.index))) {
      unparsed.push({ file, line: lineOf(source, match.index) });
    }
  }
  return unparsed;
}

export function routeKey(route) {
  return `${route.method.toUpperCase()} ${normalizePath(route.path)}`;
}

/** نداءات واجهة الويب في ملف واحد: api.GET("/orders", …) وأخواتها، والمسار حرفي يُطبَّع كمفاتيح العقد. */
export function webCalls(source, file = "<memory>") {
  const calls = [];
  WEB_CALL.lastIndex = 0;
  for (let match; (match = WEB_CALL.exec(source));) {
    calls.push({ method: match[1].toLowerCase(), path: normalizePath(match[2]), file, line: lineOf(source, match.index) });
  }
  return calls;
}

/**
 * سطح عميل iOS المولَّد: يزاوج كل localVariablePath حرفيًا مع أقرب init(method:) يليه في الملف.
 * اختلاف العددين في ملف يُسجَّل تحذيرًا، فتوليدًا ناقص التحديث قد يخفي عمليات.
 */
export function iosGeneratedOperations(source, file = "<memory>") {
  const paths = [];
  const methods = [];
  IOS_GEN_PATH.lastIndex = 0;
  IOS_GEN_METHOD.lastIndex = 0;
  for (let match; (match = IOS_GEN_PATH.exec(source));) paths.push({ path: match[1], index: match.index });
  for (let match; (match = IOS_GEN_METHOD.exec(source));) methods.push({ method: match[1], index: match.index });
  const operations = [];
  const count = Math.min(paths.length, methods.length);
  for (let i = 0; i < count; i += 1) {
    operations.push({
      method: methods[i].method.toLowerCase(),
      path: normalizePath(paths[i].path),
      file,
      line: lineOf(source, paths[i].index),
    });
  }
  const warnings = [];
  if (paths.length !== methods.length) warnings.push({ file, paths: paths.length, methods: methods.length });
  return { operations, warnings };
}

/** نداءات المستهلكين بأسماء operationId: ios يقرأ XxxAPI.<opId>( و android يقرأ xxxApi.<opId>(. */
export function consumerCalls(source, file, platform, operationIds) {
  const pattern = platform === "ios" ? IOS_CALL : ANDROID_CALL;
  pattern.lastIndex = 0;
  const calls = [];
  const unknown = [];
  for (let match; (match = pattern.exec(source));) {
    const name = match[1];
    const site = { file, line: lineOf(source, match.index) };
    if (operationIds.has(name)) calls.push({ operationId: name, ...site });
    else if (platform === "ios") unknown.push({ name, ...site });
  }
  return { calls, unknown };
}

function walkFiles(root, extension, skipSegments) {
  const files = [];
  if (!existsSync(root)) return files;
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipSegments.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

/** يفحص كل ملفات .ts في الخادم، ويستثني generated/ وملفات *.spec.ts كما تفعل أداة contract-drift. */
function controllerFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
        if (readFileSync(path, "utf8").includes("@Controller(")) files.push(path);
      }
    }
  }
  visit(root);
  return files.sort();
}

/** ملفات خادم واجهة الويب مباشرة (لا تكرار للمجلدات الفرعية)، بلا ملفات اختبار. */
function webServerFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts"))
    .map((entry) => join(root, entry.name))
    .sort();
}

/**
 * يجمع العقد والخادم والعملاء في سجل واحد لكل عملية:
 * inContract وinServer وiosGenerated رايات، وconsumers قوائم مواقع النداءات لكل منصة.
 * المجلدات الغائبة تُفحص فارغة وتُذكر في missingDirs بدل أن تسقط الأداة.
 */
export function inspect({ openapiFile, apiDir, webDir, iosDir, androidDir }) {
  const missingDirs = [];
  for (const [label, dir] of [["api", apiDir], ["web", webDir], ["ios", iosDir], ["android", androidDir]]) {
    if (!existsSync(dir)) missingDirs.push({ label, dir });
  }

  const contract = contractOperations(readFileSync(openapiFile, "utf8"));
  const operationIds = new Map(contract.filter((op) => op.operationId).map((op) => [op.operationId, op]));

  const controllers = [];
  const unparsed = [];
  for (const file of controllerFiles(apiDir)) {
    const source = readFileSync(file, "utf8");
    const name = relative(process.cwd(), file);
    controllers.push(...controllerRoutes(source, name));
    unparsed.push(...unparsedControllers(source, name));
  }

  const web = [];
  for (const file of webServerFiles(webDir)) {
    web.push(...webCalls(readFileSync(file, "utf8"), relative(process.cwd(), file)));
  }

  const iosSwift = walkFiles(iosDir, ".swift", new Set(["Pods", ".build", "Tests"]));
  const iosGenerated = [];
  const iosGeneratedWarnings = [];
  const iosConsumers = [];
  const iosUnknownCalls = [];
  for (const file of iosSwift) {
    const source = readFileSync(file, "utf8");
    const name = relative(process.cwd(), file);
    if (name.includes("PostHistoryAPI/APIs/")) {
      const parsed = iosGeneratedOperations(source, name);
      iosGenerated.push(...parsed.operations);
      iosGeneratedWarnings.push(...parsed.warnings);
    } else if (!name.includes("PostHistoryAPI/")) {
      const parsed = consumerCalls(source, name, "ios", operationIds);
      iosConsumers.push(...parsed.calls);
      iosUnknownCalls.push(...parsed.unknown);
    }
  }

  const androidConsumers = [];
  for (const file of walkFiles(androidDir, ".kt", new Set(["build", "test", "androidTest"]))) {
    androidConsumers.push(...consumerCalls(readFileSync(file, "utf8"), relative(process.cwd(), file), "android", operationIds).calls);
  }

  const byKey = new Map();
  const entry = (key) => {
    if (!byKey.has(key)) {
      byKey.set(key, {
        key, method: key.split(" ")[0], path: key.slice(key.indexOf(" ") + 1),
        operationId: null, inContract: false, inServer: false, iosGenerated: false,
        consumers: { web: [], ios: [], android: [] },
      });
    }
    return byKey.get(key);
  };
  for (const op of contract) {
    const item = entry(routeKey(op));
    item.inContract = true;
    item.operationId = item.operationId ?? op.operationId;
  }
  for (const route of controllers) entry(routeKey(route)).inServer = true;
  for (const call of web) entry(routeKey(call)).consumers.web.push({ file: call.file, line: call.line });
  for (const op of iosGenerated) entry(routeKey(op)).iosGenerated = true;
  for (const call of iosConsumers) {
    const op = operationIds.get(call.operationId);
    if (op) entry(routeKey(op)).consumers.ios.push({ file: call.file, line: call.line });
  }
  for (const call of androidConsumers) {
    const op = operationIds.get(call.operationId);
    if (op) entry(routeKey(op)).consumers.android.push({ file: call.file, line: call.line });
  }

  const operations = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const contractOnly = contract.filter((op) => !controllers.some((route) => routeKey(route) === routeKey(op)));
  const serverOnly = controllers.filter((route) => !contract.some((op) => routeKey(op) === routeKey(route)));
  const webOnly = web.filter((call) => !contract.some((op) => routeKey(op) === routeKey(call)));
  const iosGeneratedOnly = iosGenerated.filter((op) => !contract.some((item) => routeKey(item) === routeKey(op)));
  return {
    operations, contract, controllers, web, iosGenerated, iosConsumers, androidConsumers,
    contractOnly, serverOnly, webOnly, iosGeneratedOnly,
    unparsed, iosGeneratedWarnings, iosUnknownCalls, missingDirs,
  };
}

export function formatReport(result) {
  const yes = (flag) => (flag ? "نعم" : "لا");
  const lines = [
    `العقد: ${result.contract.length} عملية؛ الخادم: ${result.controllers.length}؛ نداءات ويب: ${result.web.length}؛ iOS مولَّد: ${result.iosGenerated.length} ومستهلك: ${result.iosConsumers.length}؛ أندرويد مستهلك: ${result.androidConsumers.length}.`,
    `في العقد بلا خادم: ${result.contractOnly.length}؛ في الخادم بلا عقد: ${result.serverOnly.length}؛ نداءات ويب خارج العقد: ${result.webOnly.length}؛ iOS مولَّد خارج العقد: ${result.iosGeneratedOnly.length}؛ @Controller غير محلَّلة: ${result.unparsed.length}.`,
    "لكل عملية: العقد | الخادم | ويب | iOS | أندرويد (عدد مواقع النداء):",
  ];
  for (const op of result.operations) {
    lines.push(`${op.key} — العقد: ${yes(op.inContract)} | الخادم: ${yes(op.inServer)} | web: ${op.consumers.web.length} | ios: ${op.consumers.ios.length} | android: ${op.consumers.android.length}`);
  }
  for (const call of result.webOnly) lines.push(`WEB_ONLY ${routeKey(call)} (${call.file}:${call.line})`);
  for (const op of result.iosGeneratedOnly) lines.push(`IOS_GENERATED_ONLY ${routeKey(op)} (${op.file}:${op.line})`);
  for (const call of result.iosUnknownCalls) lines.push(`IOS_UNKNOWN_CALL ${call.name} (${call.file}:${call.line})`);
  for (const warning of result.iosGeneratedWarnings) lines.push(`IOS_GENERATED_MISMATCH ${warning.file}: ${warning.paths} مسارات مقابل ${warning.methods} طرق`);
  for (const item of result.unparsed) lines.push(`UNPARSED_CONTROLLER ${item.file}:${item.line}`);
  for (const item of result.missingDirs) lines.push(`MISSING_DIR ${item.label}: ${item.dir}`);
  return lines.join("\n");
}

function toJson(result) {
  return {
    summary: {
      contract: result.contract.length,
      server: result.controllers.length,
      webCalls: result.web.length,
      iosGenerated: result.iosGenerated.length,
      iosConsumers: result.iosConsumers.length,
      androidConsumers: result.androidConsumers.length,
      contractOnly: result.contractOnly.length,
      serverOnly: result.serverOnly.length,
      webOnly: result.webOnly.length,
      iosGeneratedOnly: result.iosGeneratedOnly.length,
      unparsedControllers: result.unparsed.length,
    },
    operations: result.operations,
    webOnly: result.webOnly,
    iosGeneratedOnly: result.iosGeneratedOnly,
    iosUnknownCalls: result.iosUnknownCalls,
    iosGeneratedWarnings: result.iosGeneratedWarnings,
    unparsed: result.unparsed,
    missingDirs: result.missingDirs,
  };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(toolsDir, "..");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const openapiFile = resolve(env.CONTRACT_CLIENTS_OPENAPI ?? positional[0] ?? join(root, "contracts/openapi.yaml"));
  const apiDir = resolve(env.CONTRACT_CLIENTS_API ?? positional[1] ?? join(root, "apps/api/src"));
  const webDir = resolve(env.CONTRACT_CLIENTS_WEB ?? positional[2] ?? join(root, "apps/web/src/server"));
  const iosDir = resolve(env.CONTRACT_CLIENTS_IOS ?? positional[3] ?? join(root, "apps/ios"));
  const androidDir = resolve(env.CONTRACT_CLIENTS_ANDROID ?? positional[4] ?? join(root, "apps/android"));
  const result = inspect({ openapiFile, apiDir, webDir, iosDir, androidDir });
  if (argv.includes("--json")) console.log(JSON.stringify(toJson(result), null, 2));
  else console.log(formatReport(result));
  const drift = result.contractOnly.length + result.serverOnly.length + result.webOnly.length + result.iosGeneratedOnly.length;
  if ((drift || result.unparsed.length) && env.GITHUB_ACTIONS === "true") {
    console.log(`::warning::Contract clients: ${result.contractOnly.length} contract-only, ${result.serverOnly.length} server-only, ${result.webOnly.length} web-only, ${result.iosGeneratedOnly.length} ios-generated-only, ${result.unparsed.length} unparsed @Controller`);
  }
  const failed = argv.includes("--strict") && (drift > 0 || result.unparsed.length > 0);
  return { code: failed ? 1 : 0, result };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { code } = await run();
  process.exitCode = code;
}
