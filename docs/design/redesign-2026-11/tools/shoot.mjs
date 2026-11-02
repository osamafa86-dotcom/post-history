// لقطات الاتجاهات: node tools/shoot.mjs [page.html ...]
// كل صفحة على 390×844 و1440×900، بالعربية والإنجليزية، وبوضع «عنوان طويل و12 وسمًا» على الهاتف.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { mkdirSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c'].map((d) => join(ROOT, 'directions', `${d}.html`));
const out = join(ROOT, 'directions', 'shots');
mkdirSync(out, { recursive: true });
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy });
const views = [{ w: 390, h: 844, tag: 'phone' }, { w: 1440, h: 900, tag: 'desk' }];
for (const p of pages) {
  const name = basename(p, '.html');
  for (const v of views) for (const lang of ['ar', 'en']) for (const stress of v.tag === 'phone' ? [0, 1] : [0]) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(`${pathToFileURL(resolve(p)).href}?lang=${lang}&stress=${stress}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    const file = join(out, `${name}-${v.tag}-${lang}${stress ? '-stress' : ''}.png`); // تُحوَّل إلى WebP قبل الالتزام
    await page.screenshot({ path: file, fullPage: true });
    const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family).filter((x, i, a) => a.indexOf(x) === i).join(','));
    console.log(`${basename(file)} overflow=${overflow} fonts=${fonts}`);
    await ctx.close();
  }
}
await browser.close();
