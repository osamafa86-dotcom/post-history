#!/usr/bin/env node
// يولّد رموز الهوية v2 «إشارة» لتطبيق أندرويد من docs/design/tokens.v2.json (المصدر الوحيد؛ لا قيم تُكتب يدويًا، ADR 0085 و0088):
// app/src/main/kotlin/net/palpost/library/ui/theme/tokens/DesignTokens.kt — الألوان الدلالية بوضعين (فاتح وداكن) ونغمات
// الحالات الثلاث، والمسافات والزوايا والمقاسات والحدود، وأدوار الخط، والحركة.
// الألوان الأولية (neutral وbrand وblue وaccent وred وgreen وamber) لا تخرج إلى الكود (design-system-v2.md «الرموز»).
// يُشغَّل بعد كل تغيير في tokens.v2.json؛ CI يعيد التوليد ويفشل إن اختلف الناتج (النمط نفسه في iOS).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const tokens = JSON.parse(readFileSync(join(repo, "docs/design/tokens.v2.json"), "utf8"));
const out = join(here, "..", "app/src/main/kotlin/net/palpost/library/ui/theme/tokens/DesignTokens.kt");

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

function argb(hex) {
  const h = String(hex).replace("#", "").toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(h)) throw new Error(`unsupported color ${hex}`);
  const alpha = h.length === 8 ? h.slice(6, 8) : "FF";
  return `0x${alpha}${h.slice(0, 6)}`;
}

const camel = (name) => name.replace(/[/.-](.)/g, (_, ch) => ch.toUpperCase());
const px = (v) => {
  const m = String(v).match(/^(-?\d+(?:\.\d+)?)px$/);
  if (!m) throw new Error(`expected px dimension, got ${v}`);
  return Number(m[1]);
};
const num = (n) => (Number.isInteger(n) ? String(n) : `${n}f`);

const colors = [];
for (const group of SEMANTIC) {
  for (const [name, token] of Object.entries(tokens.color[group])) {
    if (token.$type !== "color") throw new Error(`color.${group}.${name} is not a color`);
    colors.push({
      kotlin: camel(`${group}-${name}`),
      name: `${group}/${name}`,
      light: argb(resolve(token.$value, "light")),
      dark: argb(resolve(token.$value, "dark")),
    });
  }
}

// نغمات الحالات الثلاث: إشارات إلى state/* (لا ألوان جديدة)، كلٌّ باسمه في المسار.
const aliases = [];
for (const [track, states] of Object.entries(tokens.color["material-state"])) {
  for (const [state, token] of Object.entries(states)) {
    const m = String(token.$value).match(/^\{color\.(state)\.([a-z-]+)\}$/);
    if (!m) throw new Error(`material-state.${track}.${state} must reference color.state.*`);
    aliases.push({ kotlin: camel(`material-${track}-${state}`), target: camel(`${m[1]}-${m[2]}`), name: `material-state/${track}/${state}` });
  }
}

// المفاتيح الرقمية تأخذ بادئة المجموعة: space.5 → VlSpace.s5.
const ident = (k, prefix) => (/^\d/.test(k) ? prefix + k : camel(k));
const dims = (group, prefix) => Object.entries(tokens[group]).map(([k, t]) => ({ kotlin: ident(k, prefix), value: px(t.$value), name: `${group}.${k}` }));

const familyOf = (ref) => {
  const m = String(ref).match(/^\{font\.family\.([a-z]+)\}$/);
  if (!m || !tokens.font.family[m[1]]) throw new Error(`unknown font family ${ref}`);
  return m[1].toUpperCase();
};
const roles = Object.entries(tokens.font.role).map(([name, t]) => {
  const v = t.$value;
  return { kotlin: camel(name), name, family: familyOf(v.fontFamily), size: px(v.fontSize), lineHeight: px(v.lineHeight), weight: v.fontWeight };
});
const families = Object.keys(tokens.font.family).map((k) => k.toUpperCase());

const durations = Object.entries(tokens.motion).map(([k, t]) => {
  const m = String(t.$value).match(/^(\d+)ms$/);
  if (!m) throw new Error(`expected ms duration, got ${t.$value}`);
  return { kotlin: `${camel(k)}Ms`, ms: Number(m[1]), name: `motion.${k}` };
});

const L = [];
L.push("// Generated from docs/design/tokens.v2.json by apps/android/scripts/generate-design-tokens.mjs. Do not edit.");
L.push("package net.palpost.library.ui.theme.tokens", "");
L.push("import androidx.compose.ui.graphics.Color");
L.push("import androidx.compose.ui.text.font.FontWeight");
L.push("import androidx.compose.ui.unit.TextUnit");
L.push("import androidx.compose.ui.unit.dp");
L.push("import androidx.compose.ui.unit.sp", "");
L.push("/** The semantic colours of identity v2 (`color.{bg,text,border,action,priority,sensitivity,state}.*`); one instance per mode. */");
L.push("data class VlColors(");
for (const c of colors) L.push(`    /** \`${c.name}\` */`, `    val ${c.kotlin}: Color,`);
L.push(") {");
L.push("    // The three tracks' tones (technical, editorial, rights): each points at a state/* colour.");
for (const a of aliases) L.push(`    /** \`${a.name}\` → \`${a.target}\` */`, `    val ${a.kotlin}: Color get() = ${a.target}`);
L.push("}", "");
for (const mode of ["light", "dark"]) {
  L.push(`val Vl${mode[0].toUpperCase()}${mode.slice(1)}Colors = VlColors(`);
  for (const c of colors) L.push(`    ${c.kotlin} = Color(${c[mode]}),`);
  L.push(")", "");
}
const block = (title, items, doc) => {
  L.push(`/** ${doc} */`, `object ${title} {`);
  for (const i of items) L.push(`    /** \`${i.name}\` */`, `    val ${i.kotlin} = ${num(i.value)}.dp`);
  L.push("}", "");
};
block("VlSpace", dims("space", "s"), "`space.*` in dp (from px).");
block("VlRadius", dims("radius", "r"), "`radius.*` in dp (from px).");
block("VlSize", dims("size", "z"), "`size.*` in dp (from px).");
block("VlBorder", dims("border", "b"), "`border.*` in dp (from px).");
L.push("/** `motion.*`; every animation stops with the system's \"remove animations\", the meaning stays (number and word). */");
L.push("object VlMotion {");
for (const d of durations) L.push(`    /** \`${d.name}\` */`, `    const val ${d.kotlin} = ${d.ms}`);
L.push("}", "");
L.push("/** `font.family.*`: DISPLAY (Rubik), TEXT (Readex Pro), NUM (Rubik with tabular figures). */");
L.push(`enum class VlFontKind { ${families.join(", ")} }`, "");
L.push("data class VlTypeRole(val size: TextUnit, val lineHeight: TextUnit, val weight: FontWeight, val kind: VlFontKind)", "");
L.push("/** `font.role.*` */");
L.push("object VlType {");
for (const r of roles) L.push(`    /** \`font.role.${r.name}\` */`, `    val ${r.kotlin} = VlTypeRole(${num(r.size)}.sp, ${num(r.lineHeight)}.sp, FontWeight(${r.weight}), VlFontKind.${r.family})`);
L.push("}", "");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, L.join("\n"));
console.log(`design tokens v2: ${colors.length} colors, ${aliases.length} state tones, ${roles.length} text roles → ${out}`);
