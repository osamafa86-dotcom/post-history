import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ApiError } from './errors';

// العقد هو الحقيقة: أجسام الطلبات تُتحقق مقابل مخططات contracts/openapi.yaml نفسها لا نسخة يدوية منها.
const CONTRACT_PATH = resolve(__dirname, '../../../../contracts/openapi.yaml');
const CONTRACT_ID = 'openapi.json';

let ajv: Ajv2020 | undefined;
const cache = new Map<string, ValidateFunction>();

function instance(): Ajv2020 {
  if (!ajv) {
    const doc = parse(readFileSync(CONTRACT_PATH, 'utf8')) as Record<string, unknown>;
    ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ ...doc, $id: CONTRACT_ID });
  }
  return ajv;
}

const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

export function requestBodyValidator(path: string, method: string): ValidateFunction {
  const pointer = `#/paths/${escape(path)}/${method}/requestBody/content/${escape('application/json')}/schema`;
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
