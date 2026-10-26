import { readFileSync } from "node:fs";
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
  it("meets WCAG 2.1 AA for text in both modes", () => {
    const pairs: [string, string][] = [["text/primary", "bg/surface"], ["text/primary", "bg/canvas"], ["text/secondary", "bg/surface"], ["text/secondary", "bg/canvas"], ["text/muted", "bg/surface"], ["text/brand", "bg/surface"], ["text/danger", "bg/surface"],
      ["text/on-brand", "bg/brand"], ["text/on-media", "bg/media"], ["tone/urgent/fg", "tone/urgent/bg"], ...["neutral", "progress", "good", "attention", "bad"].map(t => [`tone/${t}/fg`, `tone/${t}/bg`] as [string, string])];
    for (const mode of ["light", "dark"] as const) for (const [fg, bg] of pairs) expect(contrast(color(fg, mode), color(bg, mode)), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});
