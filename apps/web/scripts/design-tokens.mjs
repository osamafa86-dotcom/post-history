// متغيرات CSS من docs/design/tokens.v2.json (الهوية v2 «إشارة»، ADR 0085): المصدر الوحيد لألوان الويب ومسافاته وخطوطه، بوضعين فاتح وداكن.
// الناتج src/generated/tokens.css متتبَّع؛ اختبار design-tokens يفشل إن اختلف عن المولَّد من الملف.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../docs/design/tokens.v2.json", import.meta.url), target = new URL("../src/generated/tokens.css", import.meta.url);
const name = path => path.join("-").replaceAll("/", "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
const own = node => Object.entries(node).filter(([key]) => !key.startsWith("$"));

/** المجموعات الدلالية بوضعين (`v2 Color` في Figma)؛ الأولية لا تخرج إلى الكود. */
const semanticGroups = ["bg", "text", "border", "action", "priority", "sensitivity", "state"];

/**
 * ملفات الخطوط (WOFF2 ساكنة بترخيص OFL في public/fonts بجانب نصوص تراخيصها)؛ الاسم هو قيمة font.family في الرموز.
 * Rubik للعرض والأرقام وReadex Pro للنص بالأوزان التي تستعملها الأدوار والمكوّنات وحدها، وIBM Plex Mono لرقم الإيصال والترخيص والبصمة
 * (خط أحادي لا يلتبس فيه حرف برقم، كما في iOS: ADR 0088 بند 2)؛ الرموز v2 لا تحمل عائلة أحادية فهي هنا وحدها.
 */
export const fontFiles = {
  "Rubik": [[600, "SemiBold"], [700, "Bold"], [800, "ExtraBold"]],
  "Readex Pro": [[400, "Regular"], [500, "Medium"], [600, "SemiBold"], [700, "Bold"]],
  "IBM Plex Mono": [[500, "Medium"]],
};
const monoFamily = ["IBM Plex Mono", "ui-monospace", "monospace"];

/** يحل الإحالات {a.b.c} إلى قيمها النهائية في الوضع المطلوب. */
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
  return { at, resolve };
}

const generic = /^(sans-serif|serif|monospace|ui-monospace|system-ui)$/;
const stack = names => names.map(n => (generic.test(n) ? n : `"${n}"`)).join(", ");

export function tokensCss(tokens) {
  const { at, resolve } = resolver(tokens), light = [], dark = [], fixed = [];
  const color = tokens.color, cssName = node => node.$extensions?.["v2.css"];
  for (const group of semanticGroups) for (const [key, node] of own(color[group])) {
    const variable = cssName(node) ?? `--v2-c-${name([group, key])}`;
    light.push(`${variable}: ${resolve(node.$value, "light")};`);
    dark.push(`${variable}: ${resolve(node.$value, "dark")};`);
  }
  // نغمات الحالات الثلاث (فنية، تحريرية، حقوق) إحالات إلى state/*، فتتبع الوضع دون تكرار.
  for (const [track, states] of own(color["material-state"])) for (const [key, node] of own(states)) {
    const ref = node.$value.slice(1, -1), target = at(ref);
    if (!target) throw new Error(`Unresolved token reference ${node.$value}`);
    fixed.push(`--v2-c-material-state-${name([track, key])}: var(${cssName(target) ?? `--v2-c-${name(ref.split(".").slice(1))}`});`);
  }
  for (const group of ["space", "radius", "border", "size", "motion"]) for (const [key, node] of own(tokens[group])) fixed.push(`--v2-${group}-${name([key])}: ${node.$value};`);
  const families = Object.fromEntries(own(tokens.font.family).map(([key, node]) => [key, node.$value]));
  for (const [key, value] of Object.entries(families)) fixed.push(`--v2-font-family-${name([key])}: ${stack(value)};`);
  fixed.push(`--v2-font-family-mono: ${stack(monoFamily)};`);
  for (const [key, node] of own(tokens.font.role)) {
    const role = node.$value, id = name([key]), family = role.fontFamily?.match(/^\{font\.family\.([a-z-]+)\}$/)?.[1];
    if (family) fixed.push(`--v2-font-${id}-family: var(--v2-font-family-${family});`);
    if (role.fontSize) fixed.push(`--v2-font-${id}-size: ${role.fontSize};`);
    if (role.lineHeight) fixed.push(`--v2-font-${id}-line: ${role.lineHeight};`);
    if (role.fontWeight) fixed.push(`--v2-font-${id}-weight: ${role.fontWeight};`);
  }
  const used = new Set([...Object.values(families).flat(), monoFamily[0]]);
  const faces = Object.entries(fontFiles).filter(([family]) => used.has(family)).flatMap(([family, weights]) => weights.map(([weight, style]) =>
    `@font-face {\n  font-family: "${family}";\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url("/fonts/${family.replaceAll(" ", "")}-${style}.woff2") format("woff2");\n}\n`));
  const block = (selector, lines) => `${selector} {\n${lines.map(l => `  ${l}`).join("\n")}\n}\n`;
  // [data-mode] يضبط الوضع صراحةً على جزء من الصفحة كما يضبطه Figma على الإطار (الجدار والمتجر داكنان، والفاتورة فاتحة).
  return "/* مولَّد من docs/design/tokens.v2.json بـ npm run generate:tokens؛ لا يُعدَّل يدويًا. */\n"
    + faces.join("")
    + block(":root", [...light, ...fixed, "color-scheme: light;"])
    + `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', [...dark, "color-scheme: dark;"]).replace(/^/gm, "  ").trimEnd()}\n}\n`
    + block(':root[data-theme="dark"], [data-mode="dark"]', [...dark, "color-scheme: dark;"])
    + block('[data-mode="light"]', [...light, "color-scheme: light;"]);
}

export async function generate() { return tokensCss(JSON.parse(await readFile(source, "utf8"))); }

if (process.argv[1] === fileURLToPath(import.meta.url)) await writeFile(target, await generate());
