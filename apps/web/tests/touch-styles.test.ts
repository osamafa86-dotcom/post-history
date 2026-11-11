import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = ["globals", "store", "pages", "desk-tools"].map(name => read(`../src/app/${name}.css`)).join("\n");

/** قواعد الأنماط في الأوراق مع ما يحيط بكل قاعدة من `@media` وأخواتها. */
function rules(css: string) {
  const found: { selector: string; body: string; within: string[] }[] = [], within: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "}") { within.pop(); start = i + 1; continue; }
    if (css[i] !== "{") { if (css[i] === ";") start = i + 1; continue; }
    const prelude = css.slice(start, i).trim();
    if (prelude.startsWith("@")) { within.push(prelude); start = i + 1; continue; }
    const end = css.indexOf("}", i);
    found.push({ selector: prelude, body: css.slice(i + 1, end), within: [...within] });
    i = end; start = end + 1;
  }
  return found;
}
const all = rules(sheets);

describe("styles hold on a touch phone", () => {
  it("applies a hover style only where the device hovers: a tap would leave it stuck on the element", () => {
    const gate = /^@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)$/;
    const stuck = all.filter(rule => rule.selector.includes(":hover")).filter(rule => {
      const list = rule.selector.split(",").map(s => s.trim());
      // قاعدة تعيد نمط العنصر نفسه في حال التحويم (`button.quiet, button.quiet:hover`) لا تغيّر شيئًا عند اللمس
      const restatesBase = list.filter(s => s.includes(":hover")).every(s => list.includes(s.replace(/:hover/g, "")));
      return !restatesBase && !rule.within.some(at => gate.test(at));
    });
    expect(stuck.map(rule => rule.selector)).toEqual([]);
    expect(all.filter(rule => rule.selector.includes(":hover")).length).toBeGreaterThan(20);
  });
  it("sets no interface text below the caption role (12px), the smallest in the type scale", () => {
    // مصغّرة إطار القالب في نافذة النسخة رسمٌ مصغَّر لما سيُحرق على الفيديو، لا نص واجهة
    const miniature = /^\.preview-(tag|line|location|pill)\b/;
    const small = all.filter(rule => !miniature.test(rule.selector)).flatMap(rule => [...rule.body.matchAll(/font-size:\s*([\d.]+)px/g)].filter(m => Number(m[1]) < 12).map(m => `${rule.selector} ${m[1]}px`));
    expect(small).toEqual([]);
  });
  it("answers a press with one shared rule, and no control waits for a double tap", () => {
    const pressed = all.filter(rule => rule.selector.includes(":active"));
    expect(pressed.map(rule => rule.selector)).toEqual(["button:not(:disabled):active, a.button:active"]);
    const instant = all.filter(rule => /touch-action:\s*manipulation/.test(rule.body)).flatMap(rule => rule.selector.split(",").map(s => s.trim()));
    for (const control of ["button", "a", "input", "select", "textarea", "summary", "label"]) expect(instant).toContain(control);
  });
  it("takes the browser bar colour from the design tokens, for the light and the dark mode", async () => {
    const { themeColor } = await import("../src/lib/theme-color");
    const tokens = readFileSync(new URL("../src/generated/tokens.css", import.meta.url), "utf8"), dark = tokens.indexOf("@media (prefers-color-scheme: dark)");
    const raised = (css: string) => /--v2-c-bg-raised:\s*(#[0-9A-Fa-f]{6})/.exec(css)?.[1];
    expect(dark).toBeGreaterThan(0);
    expect(themeColor.light).toBe(raised(tokens.slice(0, dark))); expect(themeColor.dark).toBe(raised(tokens.slice(dark)));
    const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toContain("themeColor.light"); expect(layout).toContain("themeColor.dark"); expect(layout).not.toContain("viewportFit");
  });
});
