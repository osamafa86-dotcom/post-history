import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokensCss } from "../scripts/design-tokens.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = JSON.parse(read("../../../docs/design/tokens.json"));
const generated = read("../src/generated/tokens.css");
const styles = ["../src/app/globals.css", "../src/components/material-player.css"].map(read).join("\n");

/** قيمة الرمز الدلالي بعد حل الإحالة في الوضع المطلوب. */
function color(key: string, mode: "light" | "dark") {
  const at = (ref: string) => ref.split(".").reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, tokens);
  let value = (tokens.color.semantic[key].$value as Record<string, string>)[mode];
  while (/^\{.+\}$/.test(value)) value = at(value.slice(1, -1)).$value as string;
  return value;
}
function contrast(a: string, b: string) {
  const lum = (hex: string) => { const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("design tokens are the web's single source (#385)", () => {
  it("keeps the generated CSS identical to docs/design/tokens.json", () => {
    expect(generated).toBe(tokensCss(tokens));
  });
  it("writes no colour by hand in the app's stylesheets", () => {
    const literals = styles.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:white|black)(?![\w-])/gi) ?? [];
    expect(literals).toEqual([]);
  });
  it("only refers to variables the tokens define", () => {
    const defined = new Set(generated.match(/--vl-[a-z0-9-]+(?=:)/g));
    const used = new Set(styles.match(/var\(--vl-[a-z0-9-]+/g)?.map(v => v.slice(4)));
    expect([...used].filter(v => !defined.has(v))).toEqual([]);
  });
  it("keeps the track line segments (Figma 166:89) at 3:1 or more against the page and cards in both modes", () => {
    const hex = (key: string, mode: "light" | "dark") => color(key, mode), mix = (a: string, b: string) => `#${[1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * 0.65 + parseInt(b.slice(i, i + 2), 16) * 0.35).toString(16).padStart(2, "0")).join("")}`; // = color-mix 65% / 35% في globals.css
    for (const mode of ["light", "dark"] as const) {
      const segments: Record<string, string> = { empty: hex("text/muted", mode), done: hex("bg/brand", mode), blocked: hex("bg/danger", mode), attention: mix(hex("tone/attention/fg", mode), hex("tone/attention/border", mode)) };
      for (const [name, value] of Object.entries(segments)) for (const bg of ["bg/surface", "bg/canvas"]) expect(contrast(value, color(bg, mode)), `${mode} ${name} on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(color("text/on-brand", mode), hex("bg/danger", mode)), `${mode} hatch on blocked`).toBeGreaterThanOrEqual(3);
    }
  });
  it("draws the top bar and the board's card strip from the slate tokens, with an active underline at 3:1 or more in both modes", () => {
    const rule = (selector: RegExp) => styles.split("\n").filter(line => selector.test(line));
    const accent = (lines: string[]) => lines.flatMap(line => [...line.matchAll(/--bar-accent: var\(--vl-color-([a-z-]+)\)/g)].map(m => m[1].replace(/^(bg|text|border|icon|track-state|track|tone)-/, "$1/")));
    const [base] = rule(/^\.topbar \{/), strip = rule(/^\.wall-slate \{/).join("\n");
    for (const token of ["bg-slate", "text-on-slate", "border-on-slate"]) { expect(base, token).toContain(`var(--vl-color-${token})`); expect(strip, token).toContain(`var(--vl-color-${token})`); }
    expect(strip).not.toMatch(/var\(--vl-color-(bg-media|text-on-media)\)/);
    // الخط الفاتح يُعرَّف في القاعدة الأساسية والداكن في قاعدتي الوضع الداكن (تفضيل النظام وتبديل الصفحة).
    const light = accent([base]), dark = accent(rule(/^(@media \(prefers-color-scheme: dark\) \{ )?:root(:not\(\[data-theme="light"\]\)|\[data-theme="dark"\]) \.topbar \{/));
    expect(light).toEqual(["bg/brand-subtle"]); expect(dark).toEqual(["bg/brand", "bg/brand"]);
    for (const [mode, keys] of [["light", light], ["dark", dark]] as const) for (const key of keys) expect(contrast(color(key, mode), color("bg/slate", mode)), `${mode} underline ${key} on bg/slate`).toBeGreaterThanOrEqual(3);
    // نص الشريط على الشريحة، ونصوص البنود غير النشطة (72٪ تعتيم) تبقى فوق 4.5.
    const blend = (fg: string, bg: string, alpha: number) => `#${[1, 3, 5].map(i => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
    for (const mode of ["light", "dark"] as const) {
      expect(contrast(color("text/on-slate", mode), color("bg/slate", mode)), `${mode} text/on-slate`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(blend(color("text/on-slate", mode), color("bg/slate", mode), 0.72), color("bg/slate", mode)), `${mode} inactive item`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("takes fonts from the Figma file and hosts every face it names, with its OFL licence beside it (ADR 0079)", () => {
    const family = (key: string) => tokens.font.family[key].$value;
    expect([family("arabic"), family("latin"), family("display"), family("mono")]).toEqual(["Vazirmatn", "Vazirmatn", "Reem Kufi", "IBM Plex Mono"]);
    expect(tokens.font.role["display/xl"].$value.fontFamily).toBe("{font.family.display}");
    expect(tokens.font.role["body/md"].$value.fontFamily).not.toContain("display");
    const files = [...generated.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map(m => m[1]);
    expect(files.sort()).toEqual(["ReemKufi-Bold.ttf", "Vazirmatn-Bold.ttf", "Vazirmatn-Medium.ttf", "Vazirmatn-Regular.ttf", "Vazirmatn-SemiBold.ttf"]);
    for (const file of files) {
      const bytes = readFileSync(new URL(`../public/fonts/${file}`, import.meta.url));
      expect(bytes.readUInt32BE(0), `${file} is a static TrueType font`).toBe(0x00010000);
    }
    for (const licence of ["OFL-Vazirmatn.txt", "OFL-ReemKufi.txt"]) expect(existsSync(new URL(`../public/fonts/${licence}`, import.meta.url)), licence).toBe(true);
  });
  it("meets WCAG 2.1 AA for text in both modes", () => {
    const pairs: [string, string][] = [["text/primary", "bg/surface"], ["text/primary", "bg/canvas"], ["text/secondary", "bg/surface"], ["text/secondary", "bg/canvas"], ["text/muted", "bg/surface"], ["text/brand", "bg/surface"], ["text/danger", "bg/surface"],
      ["text/on-brand", "bg/brand"], ["text/on-media", "bg/media"], ["tone/urgent/fg", "tone/urgent/bg"], ...["neutral", "progress", "good", "attention", "bad"].map(t => [`tone/${t}/fg`, `tone/${t}/bg`] as [string, string])];
    for (const mode of ["light", "dark"] as const) for (const [fg, bg] of pairs) expect(contrast(color(fg, mode), color(bg, mode)), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});
