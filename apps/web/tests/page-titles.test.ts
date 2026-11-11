import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pageNames, pageTitle } from "../src/lib/page-titles";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const root = fileURLToPath(new URL("../src/app/[locale]", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : name === "page.tsx" ? [path] : []; });
/** مسار الصفحة كما في العنوان: بلا مجموعة `(workspace)` وبلا `page.tsx`. */
const routes = walk(root).map(path => ({ path, route: path.slice(root.length + 1).replace(/\/?page\.tsx$/, "").replace(/^\(workspace\)\//, "") })).filter(page => page.route !== "");

describe("every page has its own browser title (WCAG 2.4.2)", () => {
  it("names every route, and every route's page asks for its name", () => {
    expect(routes.length).toBeGreaterThanOrEqual(38);
    expect(Object.keys(pageNames).sort()).toEqual(routes.map(page => page.route).sort());
    for (const { path, route } of routes) expect(readFileSync(path, "utf8"), route).toContain(`export const generateMetadata = pageMetadata("${route}");`);
  });
  it("titles a page with its fixed name and the product, in both languages, and no two pages alike", () => {
    for (const [locale, m] of [["ar", ar], ["en", en]] as const) {
      const titles = Object.keys(pageNames).map(route => pageTitle(locale, route as keyof typeof pageNames));
      for (const title of titles) expect(title).toMatch(new RegExp(`^\\S.* · ${m.product}$`));
      expect(new Set(titles).size).toBe(titles.length);
    }
    expect(pageTitle("ar", "inbox")).toBe(`${ar.inbox} · ${ar.product}`);
  });
  it("never puts material data in a title: a name is a function of the language alone", () => {
    for (const name of Object.values(pageNames)) expect(name.length).toBe(1);
    expect(pageTitle("ar", "materials/[id]")).toBe(`${ar.pageTitles.material} · ${ar.product}`);
  });
});
