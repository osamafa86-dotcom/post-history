import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

const [root, target] = process.argv.slice(2);
const schema = JSON.parse(await readFile(join(root, "schemas/upload-form.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true } });
addFormats(ajv);
// الترجمة وقت التوليد فقط؛ المتصفح لا يستعمل eval أو new Function مع CSP.
await writeFile(join(target, "form-validator.cjs"), standaloneCode(ajv, ajv.compile(schema)) + "\n");
await writeFile(join(target, "form-validator.d.cts"), 'import type { ValidateFunction } from "ajv";\ndeclare const validate: ValidateFunction;\nexport = validate;\n');
await writeFile(join(target, "form-field-types.ts"), `// مولّد من upload-form.json؛ لا يُعدّل يدويًا.\nexport const fieldTypes = ${JSON.stringify(schema.$defs.field.properties.type.enum)} as const;\n`);
