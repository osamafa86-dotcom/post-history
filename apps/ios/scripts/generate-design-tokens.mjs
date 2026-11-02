#!/usr/bin/env node
// يولّد رموز الهوية v2 «إشارة» لتطبيق iOS من docs/design/tokens.v2.json (المصدر الوحيد؛ لا قيم تُكتب يدويًا، ADR 0085 و0088):
// - App/Resources/DesignTokens.xcassets: لون لكل رمز دلالي بوضعين (فاتح وداكن)، باسم vl/<المجموعة>-<الاسم>.
// - App/Sources/Design/DesignTokens.generated.swift: Color.vl.* ونغمات الحالات الثلاث، والمسافات والزوايا والمقاسات والحدود،
//   وأدوار الخط، والحركة.
// الألوان الأولية (neutral وbrand وblue وaccent وred وgreen وamber) لا تخرج إلى الكود (design-system-v2.md «الرموز»).
// يُشغَّل بعد كل تغيير في tokens.v2.json؛ CI يفشل إن اختلف الناتج.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const tokens = JSON.parse(readFileSync(join(repo, "docs/design/tokens.v2.json"), "utf8"));
const catalog = join(here, "..", "App/Resources/DesignTokens.xcassets");
const swiftOut = join(here, "..", "App/Sources/Design/DesignTokens.generated.swift");

// المجموعات الدلالية بوضعيها كما في مجموعة Figma «v2 Color».
const SEMANTIC = ["bg", "text", "border", "action", "priority", "sensitivity", "state"];

const lookup = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), tokens);
function resolve(value, mode) {
  if (value && typeof value === "object") return resolve(value[mode], mode);
  const m = typeof value === "string" && value.match(/^\{(.+)\}$/);
  if (!m) return value;
  const target = lookup(m[1]);
  if (!target || target.$value === undefined) throw new Error(`unresolved token reference ${value}`);
  return resolve(target.$value, mode);
}

function rgba(hex) {
  const h = String(hex).replace("#", "");
  if (![6, 8].includes(h.length)) throw new Error(`unsupported color ${hex}`);
  const c = (i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3);
  return { red: c(0), green: c(2), blue: c(4), alpha: h.length === 8 ? c(6) : "1.000" };
}

const camel = (name) => name.replace(/[/.-](.)/g, (_, ch) => ch.toUpperCase()).replace(/^(\d)/, "_$1");
const px = (v) => {
  const m = String(v).match(/^(-?\d+(?:\.\d+)?)px$/);
  if (!m) throw new Error(`expected px dimension, got ${v}`);
  return Number(m[1]);
};

// ألوان دلالية → asset catalog بوضعين.
rmSync(catalog, { recursive: true, force: true });
mkdirSync(join(catalog, "vl"), { recursive: true });
const info = { info: { author: "xcode", version: 1 } };
writeFileSync(join(catalog, "Contents.json"), JSON.stringify(info, null, 2) + "\n");
writeFileSync(join(catalog, "vl", "Contents.json"), JSON.stringify({ ...info, properties: { "provides-namespace": true } }, null, 2) + "\n");
const colors = [];
for (const group of SEMANTIC) {
  for (const [name, token] of Object.entries(tokens.color[group])) {
    if (token.$type !== "color") throw new Error(`color.${group}.${name} is not a color`);
    const light = rgba(resolve(token.$value, "light"));
    const dark = rgba(resolve(token.$value, "dark"));
    const entry = (components, appearance) => ({
      ...(appearance ? { appearances: [{ appearance: "luminosity", value: "dark" }] } : {}),
      color: { "color-space": "srgb", components },
      idiom: "universal",
    });
    const asset = `${group}-${name}`;
    mkdirSync(join(catalog, "vl", `${asset}.colorset`), { recursive: true });
    writeFileSync(
      join(catalog, "vl", `${asset}.colorset`, "Contents.json"),
      JSON.stringify({ colors: [entry(light), entry(dark, true)], ...info }, null, 2) + "\n",
    );
    colors.push({ swift: camel(`${group}-${name}`), asset: `vl/${asset}`, name: `${group}/${name}` });
  }
}

// نغمات الحالات الثلاث: إشارات إلى state/* (لا ألوان جديدة)، كلٌّ باسمه في المسار.
const aliases = [];
for (const [track, states] of Object.entries(tokens.color["material-state"])) {
  for (const [state, token] of Object.entries(states)) {
    const m = String(token.$value).match(/^\{color\.(state)\.([a-z-]+)\}$/);
    if (!m) throw new Error(`material-state.${track}.${state} must reference color.state.*`);
    aliases.push({
      swift: camel(`material-${track}-${state}`),
      target: camel(`${m[1]}-${m[2]}`),
      name: `material-state/${track}/${state}`,
      description: token.$description ?? "",
    });
  }
}

// المفاتيح الرقمية تأخذ بادئة المجموعة: space.5 → VL.Space.s5.
const ident = (k, prefix) => (/^\d/.test(k) ? prefix + k : camel(k));
const dims = (group, prefix) => Object.entries(tokens[group]).map(([k, t]) => ({ swift: ident(k, prefix), value: px(t.$value), name: `${group}.${k}` }));
const space = dims("space", "s");
const radius = dims("radius", "r");
const size = dims("size", "z");
const border = dims("border", "b");

const familyOf = (ref) => {
  const m = String(ref).match(/^\{font\.family\.([a-z]+)\}$/);
  if (!m || !tokens.font.family[m[1]]) throw new Error(`unknown font family ${ref}`);
  return m[1];
};
const roles = Object.entries(tokens.font.role).map(([name, t]) => {
  const v = t.$value;
  return { swift: camel(name), name, family: familyOf(v.fontFamily), size: px(v.fontSize), lineHeight: px(v.lineHeight), weight: v.fontWeight };
});
const families = Object.entries(tokens.font.family).map(([k, t]) => ({ swift: camel(k), name: t.$value[0], stack: t.$value.join(", ") }));

const durations = Object.entries(tokens.motion).map(([k, t]) => {
  const m = String(t.$value).match(/^(\d+)ms$/);
  if (!m) throw new Error(`expected ms duration, got ${t.$value}`);
  return { swift: camel(k), seconds: Number(m[1]) / 1000, name: `motion.${k}` };
});

const lines = [];
lines.push("// مولَّد من docs/design/tokens.v2.json بـ apps/ios/scripts/generate-design-tokens.mjs — لا يُعدَّل يدويًا.");
lines.push("import SwiftUI", "");
lines.push("extension Color {", "    /// الألوان الدلالية للهوية v2 بوضعين (فاتح وداكن) من `DesignTokens.xcassets`.", "    enum vl {");
for (const c of colors) lines.push(`        /// \`${c.name}\``, `        static let ${c.swift} = Color("${c.asset}")`);
lines.push("", "        // نغمات الحالات الثلاث للمادة (فنية، تحريرية، حقوق)، وكلٌّ يشير إلى state/*.");
for (const a of aliases) lines.push(`        /// \`${a.name}\` → \`${a.target}\`${a.description ? ` (${a.description})` : ""}`, `        static var ${a.swift}: Color { ${a.target} }`);
lines.push("    }", "}", "");
lines.push("/// المسافات والزوايا والمقاسات والحدود والحركة كما في الرموز (نقاط من px، وثوانٍ من ms).", "enum VL {");
const block = (title, items) => {
  lines.push(`    enum ${title} {`);
  for (const i of items) lines.push(`        /// \`${i.name}\``, `        static let ${i.swift}: CGFloat = ${i.value}`);
  lines.push("    }");
};
block("Space", space);
block("Radius", radius);
block("Size", size);
block("Border", border);
lines.push("    /// تتوقف كلها مع «تقليل الحركة»، والمعنى باقٍ (الرقم والكلمة).", "    enum Duration {");
for (const d of durations) lines.push(`        /// \`${d.name}\``, `        static let ${d.swift}: Double = ${d.seconds}`);
lines.push("    }");
lines.push("    /// الخط الأول في كل عائلة هو المضمَّن في التطبيق؛ البقية بدائل الويب.", "    enum FontFamily {");
for (const f of families) lines.push(`        /// ${f.stack}`, `        static let ${f.swift} = "${f.name}"`);
lines.push("    }");
lines.push("}", "");
lines.push("extension VLTextRole {");
for (const r of roles) {
  lines.push(`    /// \`font.role.${r.name}\``, `    static let ${r.swift} = VLTextRole(family: .${r.family}, size: ${r.size}, lineHeight: ${r.lineHeight}, weight: ${r.weight})`);
}
lines.push("}", "");
mkdirSync(dirname(swiftOut), { recursive: true });
writeFileSync(swiftOut, lines.join("\n"));
console.log(`design tokens v2: ${colors.length} colors, ${aliases.length} state tones, ${roles.length} text roles → ${catalog}, ${swiftOut}`);
