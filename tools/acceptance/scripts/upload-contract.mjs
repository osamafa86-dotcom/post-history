// اختبار القبول 01 (استئناف الرفع): مطابقة إنشاء جلسة الرفع للعقد، ومنع المورد الثاني عند تكرار المفتاح.
// يعمل ضد API محلي ولا يفتح رفعًا حقيقيًا؛ يتحقق من مخططات الاستجابة ومن client_sha256 والاستئناف المنطقي للجلسة.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody, sha256Hex } from "../lib/live.mjs";

export function responseValidator(api) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const cache = new Map();
  return (path, method, status, body) => {
    const operation = api.paths?.[path]?.[method];
    const schema = operation?.responses?.[String(status)]?.content?.["application/json"]?.schema;
    if (!schema) return [`${method.toUpperCase()} ${path}: no JSON schema for ${status}`];
    const cacheKey = `${method} ${path} ${status}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema", components: api.components, ...schema }));
    const validate = cache.get(cacheKey);
    return validate(body) ? [] : validate.errors.map((e) => `${method.toUpperCase()} ${path} ${status}${e.instancePath || "/"}: ${e.message}`);
  };
}

export async function checkUploadContract({ http, token, api }) {
  const fails = [];
  const validate = responseValidator(api);
  const check = (name, ok, detail = "") => {
    if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ""}`);
  };
  const validateBody = (path, method, status, body) => {
    const errors = validate(path, method, status, body);
    errors.forEach((e) => check("response contract", false, e));
    return errors.length === 0;
  };

  const form = await http.get(token, "/forms/current");
  check("current form", form.status === 200, `status ${form.status}`);
  if (form.status !== 200) return { fails, metrics: { operations_validated: 0 } };
  const material = await http.call(token, "POST", "/materials", {
    body: materialBody(form.body.version, `upload-contract-${randomUUID()}`), key: randomUUID(),
  });
  check("create parent material", material.status === 201, `status ${material.status}`);
  if (material.status !== 201) return { fails, metrics: { operations_validated: 1 } };
  validateBody("/materials", "post", 201, material.body);

  const bytes = Buffer.alloc(4096, 7);
  const base = { material_id: material.body.id, kind: "original", size_bytes: bytes.length, filename: "synthetic.bin" };
  const missingHash = await http.call(token, "POST", "/uploads", { body: base, key: randomUUID() });
  check("missing client_sha256 rejected", missingHash.status === 422, `status ${missingHash.status}`);

  const key = randomUUID();
  const body = { ...base, client_sha256: sha256Hex(bytes) };
  const first = await http.call(token, "POST", "/uploads", { body, key });
  const replay = await http.call(token, "POST", "/uploads", { body, key });
  check("upload session created", first.status === 201, `status ${first.status}`);
  check("replay returns first status", replay.status === first.status, `${first.status}/${replay.status}`);
  check("replay returns same resource", first.body?.id && replay.body?.id === first.body.id);
  if (first.status === 201) validateBody("/uploads", "post", 201, first.body);

  let sessionCount = null;
  if (first.body?.id) {
    const list = await http.get(token, `/uploads?material_id=${encodeURIComponent(material.body.id)}&limit=100`);
    check("list upload sessions", list.status === 200, `status ${list.status}`);
    if (list.status === 200) {
      validateBody("/uploads", "get", 200, list.body);
      sessionCount = (list.body.items ?? []).filter((s) => s.id === first.body.id).length;
      check("replay creates no second session", sessionCount === 1, `count ${sessionCount}`);
    }
    const read = await http.get(token, `/uploads/${first.body.id}`);
    check("read upload session", read.status === 200, `status ${read.status}`);
    if (read.status === 200) {
      validateBody("/uploads/{id}", "get", 200, read.body);
      check("read exposes no upload token", !("upload_token" in read.body));
    }
  }
  return {
    fails,
    metrics: {
      operations_validated: 5,
      missing_hash_status: missingHash.status,
      replay_same_resource: Boolean(first.body?.id && replay.body?.id === first.body.id),
      duplicate_session_count: sessionCount ?? -1,
      failures: fails.length,
    },
  };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("upload-contract"));
  if (!env.UPLOAD_CONTRACT_API_URL || !env.UPLOAD_CONTRACT_TOKENS) {
    console.error("ENVIRONMENT: UPLOAD_CONTRACT_API_URL and UPLOAD_CONTRACT_TOKENS are required; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.UPLOAD_CONTRACT_TOKENS);
  if (!tokens.reporter) throw new Error("UPLOAD_CONTRACT_TOKENS needs the reporter token");
  const api = YAML.parse(readFileSync(join(ROOT, "contracts/openapi.yaml"), "utf8"));
  const outcome = await checkUploadContract({ http: client(env.UPLOAD_CONTRACT_API_URL), token: tokens.reporter, api });
  const failed = outcome.fails.length > 0;
  outcome.fails.forEach((f) => console.log(`FAIL ${f}`));
  const doc = newResult("upload-contract", { device: { platform: "server" }, upload_path: "n/a" });
  finish(doc, failed ? "fail" : "pass", outcome.metrics,
    "يتحقق من إنشاء مادة وجلسة رفع وفق مخططات العقد، ورفض غياب بصمة العميل، وتطابق معرّف الجلسة وعدم تكرارها عند إعادة المفتاح نفسه؛ لا يقيس نقل الملف نفسه.");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: failed ? 1 : 0, doc };
}
