import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fontFiles, tokensCss } from "../scripts/design-tokens.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = JSON.parse(read("../../../docs/design/tokens.v2.json"));
const generated = read("../src/generated/tokens.css");
const styles = ["../src/app/globals.css", "../src/components/material-player.css"].map(read).join("\n");
type Mode = "light" | "dark";

/** قيمة الرمز الدلالي (`bg/base`…) بعد حل الإحالة في الوضع المطلوب. */
function color(path: string, mode: Mode) {
  const at = (ref: string) => ref.split(".").reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, tokens);
  let value = (at(`color.${path.replace("/", ".")}`).$value as Record<Mode, string>)[mode];
  while (/^\{.+\}$/.test(value)) value = at(value.slice(1, -1)).$value as string;
  return value;
}
function contrast(a: string, b: string) {
  const lum = (hex: string) => { const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("design tokens v2 «Signal» are the web's single source (ADR 0085)", () => {
  it("keeps the generated CSS identical to docs/design/tokens.v2.json", () => {
    expect(generated).toBe(tokensCss(tokens));
  });
  it("writes no colour by hand in the app's stylesheets", () => {
    const literals = styles.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:white|black)(?![\w-])/gi) ?? [];
    expect(literals).toEqual([]);
  });
  it("only refers to variables the v2 tokens define, and no v1 variable is left", () => {
    const defined = new Set(generated.match(/--v2-[a-z0-9-]+(?=:)/g));
    const used = new Set(styles.match(/var\(--v2-[a-z0-9-]+/g)?.map(v => v.slice(4)));
    expect([...used].filter(v => !defined.has(v))).toEqual([]);
    expect(styles.match(/--vl-[a-z0-9-]+/g) ?? []).toEqual([]);
    expect(generated).not.toMatch(/--vl-/);
  });
  it("emits every semantic colour in both modes, and an explicit dark and light scope for frames set to one mode", () => {
    const groups = ["bg", "text", "border", "action", "priority", "sensitivity", "state"];
    const names = groups.flatMap(g => Object.entries(tokens.color[g]).filter(([k]) => !k.startsWith("$")).map(([, n]) => (n as { $extensions: Record<string, string> }).$extensions["v2.css"]));
    expect(names).toHaveLength(23);
    for (const selector of [":root {", ':root[data-theme="dark"], [data-mode="dark"] {', '[data-mode="light"] {']) {
      const block = generated.slice(generated.indexOf(selector)), body = block.slice(0, block.indexOf("}"));
      for (const variable of names) expect(body, `${selector} ${variable}`).toContain(`${variable}:`);
    }
    expect(generated).toContain("--v2-c-material-state-technical-ready: var(--v2-c-state-ok);");
  });
  it("draws the primary action solid: the gradient token is not used on the web (design-system-v2.md)", () => {
    expect(styles).not.toContain("--v2-c-action-gradient-end");
    expect(styles).not.toMatch(/linear-gradient\([^)]*--v2-c-action/);
  });
  it("meets the contrast pairs the design system names, in both modes (WCAG 2.1 AA: text 4.5, ui 3)", () => {
    const pairs = tokens.$extensions["v2.contrastPairs"] as [string, string, "text" | "ui"][];
    expect(pairs.length).toBeGreaterThanOrEqual(25);
    for (const mode of ["light", "dark"] as Mode[]) for (const [fg, bg, kind] of pairs) expect(contrast(color(fg, mode), color(bg, mode)), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(kind === "text" ? 4.5 : 3);
  });
  it("meets AA for the pairs the web adds: the urgent pill, state words on the page, the dark panels and the solid primary", () => {
    const text: [string, string][] = [["text/on-brand", "priority/urgent"], ["text/on-brand", "state/danger"], ["text/brand", "bg/sunken"], ["text/primary", "bg/sunken"], ["text/primary", "action/soft"],
      ...["ok", "warn", "muted", "brand", "danger"].map(s => [`state/${s}`, "bg/base"] as [string, string]), ["priority/urgent", "bg/base"], ["text/primary", "sensitivity/bg"]];
    for (const mode of ["light", "dark"] as Mode[]) {
      for (const [fg, bg] of text) expect(contrast(color(fg, mode), color(bg, mode)), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // الجدار ولوحة الدخول والمشغّل بوضع داكن صريح: نصّها على bg/raised وbg/base الداكنين.
      for (const [fg, bg] of [["text/on-store", "bg/store"], ["text/secondary", "bg/store"]] as [string, string][]) expect(contrast(color(fg, "dark"), color(bg, "dark")), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // حدود الحقول والحلقة والحدّ العاجل ≥ 3:1 (معيار 1.4.11).
      for (const [fg, bg] of [["border/edge", "bg/sunken"], ["action/primary", "bg/raised"], ["action/primary", "bg/base"], ["priority/urgent", "bg/raised"]] as [string, string][]) expect(contrast(color(fg, mode), color(bg, mode)), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
  it("keeps the track line segments at 3:1 or more against the page and cards in both modes", () => {
    for (const mode of ["light", "dark"] as Mode[]) {
      const segments: Record<string, string> = { empty: color("border/edge", mode), done: color("state/brand", mode), attention: color("state/warn", mode), blocked: color("state/danger", mode) };
      for (const [name, value] of Object.entries(segments)) for (const bg of ["bg/raised", "bg/base"]) expect(contrast(value, color(bg, mode)), `${mode} ${name} on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(color("bg/raised", mode), color("state/danger", mode)), `${mode} hatch on blocked`).toBeGreaterThanOrEqual(3);
    }
  });
  it("hosts Rubik, Readex Pro and IBM Plex Mono as WOFF2 next to their OFL licences, and nothing else (ADR 0085)", () => {
    const family = (key: string) => tokens.font.family[key].$value[0];
    expect([family("display"), family("text"), family("num")]).toEqual(["Rubik", "Readex Pro", "Rubik"]);
    const files = [...generated.matchAll(/url\("\/fonts\/([^"]+)"\) format\("woff2"\)/g)].map(m => m[1]);
    expect(files.length).toBe(Object.values(fontFiles).flat().length);
    expect(generated.match(/font-display: swap;/g)).toHaveLength(files.length);
    const hosted = readdirSync(new URL("../public/fonts/", import.meta.url));
    expect(hosted.filter(f => !f.endsWith(".txt")).sort()).toEqual([...files].sort());
    for (const file of files) {
      const bytes = readFileSync(new URL(`../public/fonts/${file}`, import.meta.url));
      expect(bytes.subarray(0, 4).toString("latin1"), `${file} is a WOFF2 font`).toBe("wOF2");
    }
    for (const licence of ["OFL-Rubik.txt", "OFL-ReadexPro.txt", "OFL-IBMPlexMono.txt"]) {
      expect(existsSync(new URL(`../public/fonts/${licence}`, import.meta.url)), licence).toBe(true);
      expect(read(`../public/fonts/${licence}`)).toContain("SIL Open Font License, Version 1.1");
    }
    // لا طلب خطوط من خارج الأصل عند التشغيل (CSP font-src 'self').
    expect(styles + generated).not.toMatch(/fonts\.(googleapis|gstatic)\.com|@import url\(/);
  });
});
