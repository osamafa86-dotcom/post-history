#!/usr/bin/env node
// يولّد رموز نظام التصميم لتطبيق iOS من docs/design/tokens.json (المصدر الوحيد؛ لا قيم تُكتب يدويًا):
// - App/Resources/DesignTokens.xcassets: لون لكل رمز دلالي بوضعين (فاتح وداكن)، باسم vl/<الاسم>.
// - App/Sources/Design/DesignTokens.generated.swift: Color.vl.*، والمسافات والزوايا والمقاسات والحدود، وأدوار الخط، والحركة.
// الرموز الدلالية وحدها تخرج إلى الكود (docs/design/design-system.md §7). يُشغَّل بعد كل تغيير في tokens.json؛ CI يفشل إن اختلف الناتج.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const tokens = JSON.parse(readFileSync(join(repo, "docs/design/tokens.json"), "utf8"));
const catalog = join(here, "..", "App/Resources/DesignTokens.xcassets");
const swiftOut = join(here, "..", "App/Sources/Design/DesignTokens.generated.swift");

const lookup = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), tokens);
function resolve(value) {
  const m = typeof value === "string" && value.match(/^\{(.+)\}$/);
  if (!m) return value;
  const target = lookup(m[1]);
  if (!target || target.$value === undefined) throw new Error(`unresolved token reference ${value}`);
  return resolve(target.$value);
}

function rgba(hex) {
  const h = hex.replace("#", "");
  if (![6, 8].includes(h.length)) throw new Error(`unsupported color ${hex}`);
  const c = (i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3);
  return { red: c(0), green: c(2), blue: c(4), alpha: h.length === 8 ? c(6) : "1.000" };
}

const camel = (name) =>
  name.replace(/[/-](.)/g, (_, ch) => ch.toUpperCase()).replace(/^(\d)/, "_$1");
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
for (const [name, token] of Object.entries(tokens.color.semantic)) {
  const value = token.$value;
  const light = rgba(resolve(typeof value === "object" ? value.light : value));
  const dark = rgba(resolve(typeof value === "object" ? value.dark : value));
  const entry = (components, appearance) => ({
    ...(appearance ? { appearances: [{ appearance: "luminosity", value: "dark" }] } : {}),
    color: { "color-space": "srgb", components },
    idiom: "universal",
  });
  const asset = name.replace(/\//g, "-");
  mkdirSync(join(catalog, "vl", `${asset}.colorset`), { recursive: true });
  writeFileSync(
    join(catalog, "vl", `${asset}.colorset`, "Contents.json"),
    JSON.stringify({ colors: [entry(light), entry(dark, true)], ...info }, null, 2) + "\n",
  );
  colors.push({ swift: camel(name), asset: `vl/${asset}`, name });
}

// المفاتيح الرقمية تأخذ بادئة المجموعة: space.5 → VL.Space.s5، radius.2xl → VL.Radius.r2xl.
const ident = (k, prefix) => (/^\d/.test(k) ? prefix + camel(k).replace(/^_/, "") : camel(k));
const dims = (group, prefix) => Object.entries(tokens[group]).map(([k, t]) => ({ swift: ident(k, prefix), value: px(t.$value), name: `${group}.${k}` }));
const space = dims("space", "s");
const radius = dims("radius", "r");
const size = Object.entries(tokens.size)
  .filter(([, t]) => t.$type === "dimension")
  .map(([k, t]) => ({ swift: camel(k), value: px(t.$value), name: `size.${k}` }));
const border = dims("border", "b");

const roles = Object.entries(tokens.font.role).map(([name, t]) => {
  const v = t.$value;
  const family = v.fontFamily.includes("font.family.mono") ? "mono" : v.fontFamily.includes("font.family.display") ? "display" : "text";
  return { swift: camel(name), name, family, size: px(v.fontSize), lineHeight: px(v.lineHeight), weight: v.fontWeight };
});
const families = Object.fromEntries(Object.entries(tokens.font.family).map(([k, t]) => [k, t.$value]));

const durations = Object.entries(tokens.motion.duration).map(([k, t]) => {
  const m = String(t.$value).match(/^(\d+)ms$/);
  if (!m) throw new Error(`expected ms duration, got ${t.$value}`);
  return { swift: camel(k), seconds: Number(m[1]) / 1000, name: `motion.duration.${k}` };
});
const easings = Object.entries(tokens.motion.easing).map(([k, t]) => {
  const m = String(t.$value).match(/^cubic-bezier\(([^)]+)\)$/);
  return { swift: camel(k), points: m ? m[1].split(",").map((s) => Number(s.trim())) : null, name: `motion.easing.${k}` };
});

const num = (n) => (Number.isInteger(n) ? `${n}` : `${n}`);
const lines = [];
lines.push("// مولَّد من docs/design/tokens.json بـ apps/ios/scripts/generate-design-tokens.mjs — لا يُعدَّل يدويًا.");
lines.push("import SwiftUI", "");
lines.push("extension Color {", "    /// الألوان الدلالية بوضعين (فاتح وداكن) من `DesignTokens.xcassets`.", "    enum vl {");
for (const c of colors) lines.push(`        /// \`${c.name}\``, `        static let ${c.swift} = Color("${c.asset}")`);
lines.push("    }", "}", "");
lines.push("/// المسافات والزوايا والمقاسات والحدود ونقاط الشاشة كما في الرموز.", "enum VL {");
const block = (title, items) => {
  lines.push(`    enum ${title} {`);
  for (const i of items) lines.push(`        /// \`${i.name}\``, `        static let ${i.swift}: CGFloat = ${num(i.value)}`);
  lines.push("    }");
};
block("Space", space);
block("Radius", radius);
block("Size", size);
block("Border", border);
lines.push("    enum Duration {");
for (const d of durations) lines.push(`        /// \`${d.name}\``, `        static let ${d.swift}: Double = ${d.seconds}`);
lines.push("    }");
lines.push("    enum Easing {");
for (const e of easings) {
  lines.push(`        /// \`${e.name}\``);
  if (e.points) lines.push(`        static func ${e.swift}(_ duration: Double) -> Animation { .timingCurve(${e.points.join(", ")}, duration: duration) }`);
  else lines.push(`        static func ${e.swift}(_ duration: Double) -> Animation { .linear(duration: duration) }`);
}
lines.push("    }");
lines.push("    enum FontFamily {");
for (const [k, v] of Object.entries(families)) lines.push(`        static let ${camel(k)} = "${v}"`);
lines.push("    }");
lines.push("}", "");
lines.push("/// أدوار الخط: العائلة (نص، أو عرض للعناوين الكبيرة، أو أحادي)، والحجم والسطر والوزن بالنقاط.", "struct VLTextRole: Sendable {");
lines.push("    enum Family: Sendable { case text, display, mono }", "    let family: Family", "    let size: CGFloat", "    let lineHeight: CGFloat", "    let weight: Int", "");
for (const r of roles) lines.push(`    /// \`font.role.${r.name}\``, `    static let ${r.swift} = VLTextRole(family: .${r.family}, size: ${r.size}, lineHeight: ${r.lineHeight}, weight: ${r.weight})`);
lines.push("}", "");
mkdirSync(dirname(swiftOut), { recursive: true });
writeFileSync(swiftOut, lines.join("\n"));
console.log(`design tokens: ${colors.length} colors, ${roles.length} text roles → ${catalog}, ${swiftOut}`);
