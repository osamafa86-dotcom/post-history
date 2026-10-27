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
