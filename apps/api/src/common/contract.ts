import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ApiError } from './errors';

// العقد هو الحقيقة: أجسام الطلبات تُتحقق مقابل مخططات contracts/openapi.yaml نفسها لا نسخة يدوية منها.
const CONTRACTS_DIR = resolve(__dirname, '../../../../contracts');
// بهذا المعرّف تُحل الإحالات النسبية في العقد (./schemas/x.json) إلى معرّفات ملفات المخططات نفسها ($id)
const CONTRACT_ID = 'https://post-history/contracts/openapi.yaml';
const SCHEMA_FILES = ['upload-form.json', 'outbox-event.json', 'notification-channel-payload.json'];

let doc: Record<string, any> | undefined;
let ajv: Ajv2020 | undefined;
// معاملات الاستعلام نصوص في HTTP: مدقق ثانٍ يحوّل الأنواع (limit=10 → 10، unread_only=true → true)
let coercing: Ajv2020 | undefined;
const cache = new Map<string, ValidateFunction>();

function contract(): Record<string, any> {
  doc ??= parse(readFileSync(resolve(CONTRACTS_DIR, 'openapi.yaml'), 'utf8')) as Record<string, any>;
  return doc;
}

function build(coerceTypes: boolean): Ajv2020 {
  // multipleOfPrecision: 33.33 مضاعف لـ 0.01 رغم خطأ الفاصلة العائمة (حصص المساهمين)
  const a = new Ajv2020({ strict: false, allErrors: true, coerceTypes, multipleOfPrecision: 9 });
  addFormats(a);
  for (const f of SCHEMA_FILES) a.addSchema(JSON.parse(readFileSync(resolve(CONTRACTS_DIR, 'schemas', f), 'utf8')));
  a.addSchema({ ...contract(), $id: CONTRACT_ID });
  return a;
}

function instance(): Ajv2020 {
  return (ajv ??= build(false));
}

const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

export function requestBodyValidator(path: string, method: string): ValidateFunction {
  return compile(`#/paths/${escape(path)}/${method}/requestBody/content/${escape('application/json')}/schema`);
}

/** مدقق لمكوّن مسمّى في العقد، مثل schemaValidator('UploadForm'). */
export function schemaValidator(name: string): ValidateFunction {
  return compile(`#/components/schemas/${escape(name)}`);
}

/** مدقق لملف مخطط مستقل في contracts/schemas بمعرّفه ($id)، مثل schemaFileValidator('notification-channel-payload.json'). */
export function schemaFileValidator(file: string): ValidateFunction {
  const id = `https://post-history/contracts/schemas/${file}`;
  let fn = cache.get(id);
  if (!fn) {
    fn = instance().getSchema(id)!;
    cache.set(id, fn);
  }
  return fn;
}

function compile(pointer: string): ValidateFunction {
  let fn = cache.get(pointer);
  if (!fn) {
    fn = instance().compile({ $ref: `${CONTRACT_ID}${pointer}` });
    cache.set(pointer, fn);
  }
  return fn;
}

/** يتحقق من الجسم مقابل العقد؛ الفشل 422 بمسارات الحقول فقط (لا قيم). */
export function validateBody<T>(path: string, method: string, body: unknown): T {
  const validate = requestBodyValidator(path, method);
  if (!validate(body)) {
    const fields = [...new Set((validate.errors ?? []).map((e) => e.instancePath || '/'))];
    throw ApiError.validation({ fields });
  }
  return body as T;
}

/**
 * يتحقق من معاملات الاستعلام بمعاملات العملية في العقد (مع تحويل الأنواع) ويعيدها محوّلة؛
 * معامل غير معروف أو قيمة خارج المخطط = 400 bad_request بأسماء المعاملات فقط.
 */
export function validateQuery<T>(path: string, method: string, query: Record<string, unknown>): T {
  const key = `query:${method}:${path}`;
  let fn = cache.get(key);
  if (!fn) {
    const params = (contract().paths[path][method].parameters ?? []) as Array<Record<string, any>>;
    const properties: Record<string, unknown> = {};
    for (const p of params) {
      const param = p.$ref ? resolvePointer(p.$ref) : p;
      if (param.in === 'query') properties[param.name] = { $ref: `${CONTRACT_ID}${pointerOf(param, p)}/schema` };
    }
    coercing ??= build(true);
    fn = coercing.compile({ type: 'object', properties, additionalProperties: false });
    cache.set(key, fn);
  }
  const copy = { ...query };
  if (!fn(copy)) {
    const names = [...new Set((fn.errors ?? []).map((e) => e.instancePath.split('/')[1] || e.params?.additionalProperty || '/'))];
    throw new ApiError(400, 'bad_request', 'Invalid query parameters.', { params: names });
  }
  return copy as T;

  function pointerOf(param: Record<string, any>, raw: Record<string, any>): string {
    if (raw.$ref) return raw.$ref as string;
    const params = contract().paths[path][method].parameters as unknown[];
    return `#/paths/${escape(path)}/${method}/parameters/${params.indexOf(param)}`;
  }
}

function resolvePointer(ref: string): Record<string, any> {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node: any, part) => node[part.replace(/~1/g, '/').replace(/~0/g, '~')], contract());
}
