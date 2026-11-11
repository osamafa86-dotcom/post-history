import { expect, test } from "@playwright/test";

/** القطع الثابتة ببصمة محتواها تُخزَّن طويلًا ولا تُعاد؛ والصفحات وردود الـBFF لا تُخزَّن أبدًا. */
test("fingerprinted static scripts are cached for good, while pages and BFF answers are never stored", async ({ page, request }) => {
  const html = await (await request.get("/ar/login")).text();
  const scripts = [...new Set([...html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)].map(match => match[0]))];
  expect(scripts.length).toBeGreaterThan(0);
  for (const path of scripts) {
    const chunk = await request.get(path), cache = chunk.headers()["cache-control"] ?? "";
    expect(chunk.status(), path).toBe(200); expect(cache, path).toContain("immutable"); expect(cache, path).toContain("max-age=31536000"); expect(cache, path).not.toContain("no-store");
    expect(chunk.headers()["x-content-type-options"], path).toBe("nosniff");
  }
  const css = [...html.matchAll(/\/_next\/static\/[^"'\\ ]+\.css/g)].map(match => match[0])[0];
  if (css) expect((await request.get(css)).headers()["cache-control"]).toContain("immutable");
  for (const path of ["/ar/login", "/en/login", "/api/bff/auth/me"]) {
    const answer = await request.get(path), cache = answer.headers()["cache-control"] ?? "";
    expect(cache, path).toContain("no-store"); expect(cache, path).not.toContain("immutable");
  }
  // في التحميل الثاني لا تُنقل السكربتات من جديد.
  await page.goto("/ar/login"); await page.waitForLoadState("networkidle"); await page.reload(); await page.waitForLoadState("networkidle");
  const again = await page.evaluate(() => performance.getEntriesByType("resource").filter(entry => entry.name.includes("/_next/static/") && entry.name.endsWith(".js")).map(entry => (entry as PerformanceResourceTiming).transferSize));
  expect(again.length).toBeGreaterThan(0); expect(again.filter(size => size > 0)).toEqual([]);
});
