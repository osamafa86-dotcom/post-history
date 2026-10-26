#!/usr/bin/env node
// مقارنة مسارات OpenAPI بمزخرفات NestJS. الافتراضي تحذير وخروج 0 حتى عند وجود فروق؛ --strict يجعل الفروق خروجًا 1.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const DECORATOR = /@(Controller|Get|Post|Put|Patch|Delete)\s*\(\s*(?:'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)")?\s*\)/g;

function unquote(value = "") {
  return value.replace(/\\(['"])/g, "$1");
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

/** يقرأ مستويي paths والعمليات فقط، ولا يحاول تفسير بقية YAML. */
export function contractRoutes(yaml) {
  const routes = [];
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  let inPaths = false;
  let pathsIndent = -1;
  let currentPath = null;
  let pathIndent = -1;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    const match = line.match(/^\s*([^:#][^:]*):(?:\s|$)/);
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
      continue;
    }
    if (currentPath && indent === pathIndent + 2 && METHODS.has(key.toLowerCase())) {
      routes.push({ method: key.toLowerCase(), path: currentPath });
    }
  }
  return routes;
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
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return routes;
}

export function routeKey(route) {
  return `${route.method.toUpperCase()} ${normalizePath(route.path)}`;
}

export function compareRoutes(contract, controllers) {
  const contractMap = new Map(contract.map((route) => [routeKey(route), route]));
  const controllerMap = new Map(controllers.map((route) => [routeKey(route), route]));
  const contractOnly = [...contractMap.entries()].filter(([key]) => !controllerMap.has(key)).map(([, route]) => route);
  const controllerOnly = [...controllerMap.entries()].filter(([key]) => !contractMap.has(key)).map(([, route]) => route);
  const byKey = (a, b) => routeKey(a).localeCompare(routeKey(b));
  return { contractOnly: contractOnly.sort(byKey), controllerOnly: controllerOnly.sort(byKey) };
}

function controllerFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".controller.ts")) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

export function inspect({ openapiFile, controllersDir }) {
  const contract = contractRoutes(readFileSync(openapiFile, "utf8"));
  const controllers = controllerFiles(controllersDir).flatMap((file) =>
    controllerRoutes(readFileSync(file, "utf8"), relative(process.cwd(), file)));
  return { contract, controllers, ...compareRoutes(contract, controllers) };
}

export function formatReport(result) {
  const lines = [
    `العقد: ${result.contract.length} عملية؛ وحدات التحكم: ${result.controllers.length} عملية.`,
    `موجود في العقد فقط: ${result.contractOnly.length}؛ موجود في وحدات التحكم فقط: ${result.controllerOnly.length}.`,
  ];
  for (const route of result.contractOnly) lines.push(`CONTRACT_ONLY ${routeKey(route)}`);
  for (const route of result.controllerOnly) lines.push(`CONTROLLER_ONLY ${routeKey(route)} (${route.file}:${route.line})`);
  return lines.join("\n");
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(toolsDir, "..");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const openapiFile = resolve(env.CONTRACT_DRIFT_OPENAPI ?? positional[0] ?? join(root, "contracts/openapi.yaml"));
  const controllersDir = resolve(env.CONTRACT_DRIFT_CONTROLLERS ?? positional[1] ?? join(root, "apps/api/src"));
  const result = inspect({ openapiFile, controllersDir });
  console.log(formatReport(result));
  const drift = result.contractOnly.length + result.controllerOnly.length;
  if (drift && env.GITHUB_ACTIONS === "true") {
    console.log(`::warning::Contract drift: ${result.contractOnly.length} contract-only and ${result.controllerOnly.length} controller-only routes`);
  }
  return { code: drift && argv.includes("--strict") ? 1 : 0, result };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { code } = await run();
  process.exitCode = code;
}
