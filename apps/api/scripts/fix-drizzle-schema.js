// تصحيحات حتمية على ناتج drizzle-kit pull (scripts/db-pull.sh). كل تصحيح يفشل بصوت عالٍ إن تغيّر الناتج.
const { readFileSync, writeFileSync } = require('node:fs');

const [, , file] = process.argv;
let src = readFileSync(file, 'utf8');

function fix(name, pattern, replacement) {
  if (!pattern.test(src)) throw new Error(`drizzle fixup "${name}" did not match; update scripts/fix-drizzle-schema.js`);
  src = src.replace(pattern, replacement);
}

// 1) bytea غير مدعوم: يُستبدل بالنوع المخصص src/database/bytea.ts
fix('bytea', /\t\/\/ TODO: failed to parse database type 'bytea'\n/g, '');
fix('bytea-columns', /: unknown\("/g, ': bytea("');
src = `import { bytea } from "../bytea"\n${src}`;
// 2) القيمة الافتراضية النصية الفارغة تُكتب '( بلا إغلاق
fix('empty-default', /\.default\('\)/g, ".default('')");
// 3) المفتاح الأجنبي الدائري material_files → upload_sessions يجعل نوعي الجدولين any؛
//    يُحذف من وصف Drizzle فقط (القيد في SQL باقٍ، وDrizzle لا يولّد ترحيلات هنا)
fix(
  'circular-fk',
  /\tforeignKey\(\{\n\t+columns: \[table\.uploadSessionId\],\n\t+foreignColumns: \[uploadSessions\.id\],\n\t+name: "material_files_upload_session_fk"\n\t+\}\),\n/,
  '',
);

writeFileSync(file, src);
