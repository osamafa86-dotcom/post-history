// متغيرات CSS من docs/design/tokens.json (#385): المصدر الوحيد لألوان الويب ومسافاته وخطوطه، بوضعين فاتح وداكن.
// الناتج src/generated/tokens.css متتبَّع؛ اختبار design-tokens يفشل إن اختلف عن المولَّد من الملف.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../docs/design/tokens.json", import.meta.url), target = new URL("../src/generated/tokens.css", import.meta.url);
const name = path => path.join("-").replaceAll("/", "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase();

/** يحل الإحالات {a.b.c} إلى قيمها النهائية. */
function resolver(tokens) {
  const at = ref => ref.split(".").reduce((node, key) => node?.[key], tokens);
  const resolve = (value, mode) => {
    if (typeof value === "string" && /^\{[^}]+\}$/.test(value)) {
      const node = at(value.slice(1, -1));
      if (!node || !("$value" in node)) throw new Error(`Unresolved token reference ${value}`);
      return resolve(node.$value, mode);
    }
    if (value && typeof value === "object" && mode && mode in value) return resolve(value[mode], mode);
    return value;
  };
  return resolve;
}

/** ملفات الخطوط الساكنة (TTF بترخيص OFL) في public/fonts بجانب نصوص تراخيصها؛ الاسم هو قيمة font.family في الرموز. */
const fontFiles = { "Vazirmatn": [[400, "Regular"], [500, "Medium"], [600, "SemiBold"], [700, "Bold"]], "Reem Kufi": [[700, "Bold"]] };

export function tokensCss(tokens) {
  const resolve = resolver(tokens), light = [], dark = [];
  for (const [key, node] of Object.entries(tokens.color.semantic)) {
    if (key.startsWith("$")) continue;
    // اسم المتغير كما يسمّيه نظام التصميم في $extensions.vl.css.
    const variable = node.$extensions?.["vl.css"] ?? `--vl-color-${name([key])}`;
    light.push(`${variable}: ${resolve(node.$value, "light")};`);
    dark.push(`${variable}: ${resolve(node.$value, "dark")};`);
  }
  const fixed = [];
  for (const group of ["space", "radius", "size", "border"]) for (const [key, node] of Object.entries(tokens[group])) if (!key.startsWith("$")) fixed.push(`--vl-${group}-${name([key])}: ${node.$value};`);
  const families = Object.fromEntries(Object.entries(tokens.font.family).filter(([k]) => !k.startsWith("$")).map(([k, n]) => [k, n.$value]));
  // الخطوط مستضافة محليًا في public/fonts (CSP font-src 'self')؛ البدائل من النظام إن تأخر التحميل. المرجع ملف Figma (ADR 0079).
  const stack = (...names) => [...new Set(names)].map(n => (/^(sans-serif|monospace|ui-monospace|Tahoma|Arial)$/.test(n) ? n : `"${n}"`)).join(", ");
  fixed.push(`--vl-font-family-sans: ${stack(families.arabic, families.latin, "Tahoma", "Arial", "sans-serif")};`, `--vl-font-family-display: ${stack(families.display, families.arabic, "Tahoma", "Arial", "sans-serif")};`, `--vl-font-family-latin: ${stack(families.latin, "Arial", "sans-serif")};`, `--vl-font-family-mono: ${stack(families.mono, "ui-monospace", "monospace")};`);
  for (const [key, node] of Object.entries(tokens.font.role)) {
    if (key.startsWith("$")) continue;
    const role = resolve(node.$value), id = name([key]);
    if (role.fontSize) fixed.push(`--vl-font-${id}-size: ${role.fontSize};`);
    if (role.lineHeight) fixed.push(`--vl-font-${id}-line: ${role.lineHeight};`);
    if (role.fontWeight) fixed.push(`--vl-font-${id}-weight: ${role.fontWeight};`);
  }
  for (const [group, entries] of Object.entries(tokens.motion)) if (!group.startsWith("$")) for (const [key, node] of Object.entries(entries)) if (!key.startsWith("$")) fixed.push(`--vl-motion-${group}-${name([key])}: ${node.$value};`);
  const used = new Set(Object.values(families));
  const faces = Object.entries(fontFiles).filter(([family]) => used.has(family)).flatMap(([family, weights]) => weights.map(([weight, style]) =>
    `@font-face {\n  font-family: "${family}";\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url("/fonts/${family.replaceAll(" ", "")}-${style}.ttf") format("truetype");\n}\n`));
  const block = (selector, lines) => `${selector} {\n${lines.map(l => `  ${l}`).join("\n")}\n}\n`;
  return "/* مولَّد من docs/design/tokens.json بـ npm run generate:tokens؛ لا يُعدَّل يدويًا. */\n"
    + faces.join("")
    + block(":root", [...light, ...fixed, "color-scheme: light;"])
    + `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', [...dark, "color-scheme: dark;"]).replace(/^/gm, "  ").trimEnd()}\n}\n`
    + block(':root[data-theme="dark"]', [...dark, "color-scheme: dark;"]);
}

export async function generate() { return tokensCss(JSON.parse(await readFile(source, "utf8"))); }

if (process.argv[1] === fileURLToPath(import.meta.url)) await writeFile(target, await generate());
