// يهيّئ العقد المجمَّع لمولّد عميل Swift دون تغيير معناه:
// 1. يحذف مسارات `/internal/*` ومخططات خطّافات tusd (لا تُولَّد لها مكتبات عملاء، ADR SEC-06).
// 2. يرفع `UploadForm` من `schemas/upload-form.json` إلى مخطط مسمّى ويرفع تعريفاته الفرعية (`$defs`) إلى
//    مكوّنات مسمّاة (`UploadFormField`…) كي تخرج نماذج واضحة بدل نماذج مضمَّنة بأسماء مولَّدة.
// 3. يحذف قيود `allOf` الشرطية (if/then) من حقل النموذج: المولّد لا يمثّلها، والتحقق الدلالي في FormEngine
//    والخادم يتحقق بالمخطط الكامل. البنية (المفاتيح والأنواع) تبقى كما هي.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(input, "utf8"));

for (const p of Object.keys(spec.paths)) if (p.startsWith("/internal/")) delete spec.paths[p];
for (const name of Object.keys(spec.components.schemas)) if (name.startsWith("TusdHook")) delete spec.components.schemas[name];

const pascal = (s) => s.replace(/(^|[_-])([a-z])/g, (_, __, c) => c.toUpperCase());
// redocly يرفع تعريفات `$defs` في upload-form.json إلى مكوّنات بأسمائها الصغيرة ويترك نسخة من `$defs` داخل المخطط.
const bundledName = "upload-form";
const defNames = ["localized", "fieldKey", "option", "materialType", "condition", "validation", "field"];
const form = spec.components.schemas[bundledName];
if (!form) throw new Error(`bundled schema ${bundledName} not found`);
delete spec.components.schemas[bundledName];
for (const k of ["$defs", "$schema", "$id", "title"]) delete form[k];
spec.components.schemas.UploadForm = form;
for (const k of defNames) {
  const v = spec.components.schemas[k];
  if (!v) throw new Error(`bundled component ${k} not found`);
  delete spec.components.schemas[k];
  if (k === "field") delete v.allOf;
  spec.components.schemas[`UploadForm${pascal(k)}`] = v;
}
const rewrite = (node) => {
  if (Array.isArray(node)) return node.forEach(rewrite);
  if (!node || typeof node !== "object") return;
  if (typeof node.$ref === "string") {
    const m = node.$ref.match(/^#\/components\/schemas\/([a-zA-Z]+)$/);
    if (m && defNames.includes(m[1])) node.$ref = `#/components/schemas/UploadForm${pascal(m[1])}`;
    else if (node.$ref === `#/components/schemas/${bundledName}`) node.$ref = "#/components/schemas/UploadForm";
  }
  for (const v of Object.values(node)) rewrite(v);
};
rewrite(spec);

// حدود المولّد مع OpenAPI 3.1 (لا تغيّر معنى العقد للعميل):
// - `type` بعدة أنواع غير null (مثل equals وdefault): لا يمثّلها المولّد فتخرج بنية فارغة؛ تُترك قيمة JSON حرة (JSONValue).
// - `const` منطقية: المولّد يصنع تعدادًا بنوع خام Bool لا يُترجم؛ يبقى النوع المنطقي وحده.
const relax = (node) => {
  if (Array.isArray(node)) return node.forEach(relax);
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.type)) {
    const nonNull = node.type.filter((t) => t !== "null");
    if (nonNull.length > 1) {
      delete node.type;
      delete node.enum;
    }
  }
  if (node.type === "boolean" && "const" in node) delete node.const;
  for (const v of Object.values(node)) relax(v);
};
relax(spec);
writeFileSync(output, JSON.stringify(spec, null, 2) + "\n");
