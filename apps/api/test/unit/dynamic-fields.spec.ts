import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schemaValidator } from '../../src/common/contract';
import { type UploadForm, validateDynamicFields } from '../../src/forms/dynamic-fields';

// الحَكَم هو cases.json المشترك بين الواجهات الثلاث والخادم (اختبار القبول «الحقول المتغيرة»).
const dir = resolve(__dirname, '../../../../tools/acceptance/form-conformance');
const suite = JSON.parse(readFileSync(resolve(dir, 'cases.json'), 'utf8')) as {
  forms: Record<string, string>;
  cases: Array<{ id: string; form: string; material_type: string; values: Record<string, unknown>; expect: unknown }>;
};
const forms = Object.fromEntries(
  Object.entries(suite.forms).map(([name, file]) => [name, JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as UploadForm]),
);

describe('dynamic fields — shared form-conformance cases', () => {
  it('the conformance forms are valid UploadForm contracts', () => {
    for (const form of Object.values(forms)) expect(schemaValidator('UploadForm')(form)).toBe(true);
  });

  it.each(suite.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const { valid, errors } = validateDynamicFields(forms[c.form]!, [c.material_type], c.values);
    expect({ valid, errors }).toEqual(c.expect);
  });
});
