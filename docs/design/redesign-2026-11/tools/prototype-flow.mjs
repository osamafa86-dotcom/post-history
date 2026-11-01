// يقيس النموذج الحيّ: المسار كاملًا، والحالات الحدّية (خط 200% على 375، انقطاع الشبكة، تقليل الحركة).
// الاستعمال: node tools/prototype-flow.mjs   — يخرج برمز 1 عند أي فشل، ويحفظ لقطات في prototype/shots/
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(ROOT, 'prototype', 'post-maydan.html')).href;
const out = join(ROOT, 'prototype', 'shots'); mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
// كل عنصر ظاهر في الشاشة داخل حدود الهاتف، ولا عنصران متجاوران يتراكبان (الإطار يقصّ ما يفيض فلا يكشفه فحص التمرير).
const escapes = (page) => page.evaluate(() => { const ph = document.querySelector('.phone').getBoundingClientRect(); const bad = [];
  for (const e of document.querySelectorAll('.scr.on *')) { const r = e.getBoundingClientRect(); if (!r.width || !r.height || e.closest('.pc')) continue;
    if (r.left < ph.left - 1 || r.right > ph.right + 1) bad.push(`${e.tagName}.${e.className || ''} ${Math.round(r.left)}..${Math.round(r.right)}`); }
  for (const row of document.querySelectorAll('.scr.on .row2, .scr.on .picked, .scr.on .rc')) { const k = [...row.children].map((c) => c.getBoundingClientRect());
    for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) { const a = k[i], b = k[j]; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`overlap in ${row.className}`); } }
  for (const s of document.querySelectorAll('.scr.on .rc svg')) if (s.getBoundingClientRect().width > 40) bad.push('oversized status icon');
  for (const t of document.querySelectorAll('.scr.on textarea, .scr.on input:not([type=range])')) if (t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1) bad.push(`${t.id} hides its text`);
  return bad.slice(0, 6); });
const clipped = (page) => page.evaluate(() => [...document.querySelectorAll('.scr.on *')].filter((e) => e.children.length === 0 && e.textContent.trim() && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map((e) => e.textContent.trim().slice(0, 30)));
for (const [w, h, lang, scale, motion] of [[390, 844, 'ar', 1, 'no-preference'], [375, 667, 'ar', 2, 'no-preference'], [375, 667, 'en', 1, 'reduce'], [390, 844, 'en', 2, 'reduce']]) {
  const tag = `${w}-${lang}-x${scale}${motion === 'reduce' ? '-rm' : ''}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ignoreHTTPSErrors: true, reducedMotion: motion });
  const page = await ctx.newPage();
  await page.goto(`${url}?lang=${lang}&scale=${scale}&mode=light`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(await over() === 0, `${tag} home: no horizontal scroll`);
  await page.click('[data-go="send"]');
  check(await page.isDisabled('#sendBtn'), `${tag} send disabled before fields`);
  await page.fill('#title', lang === 'ar' ? 'توزيع مساعدات WFP على 1,250 عائلة في مخيم النصيرات وسط قطاع غزة يوم 28/10 صباحًا' : 'WFP aid to 1,250 families in مخيم النصيرات, central Gaza Strip, on 28 Oct, day 3');
  await page.click('[data-type="breaking"]');
  for (const tg of ['مساعدات', 'النصيرات', 'شتاء', 'WFP', 'طوابير', 'أطفال', 'دير البلح', 'نزوح', 'خيام', 'مطر', 'وكالة الغوث UNRWA', 'توزيع الطحين في الصباح الباكر']) { await page.fill('#tagIn', tg); await page.press('#tagIn', 'Enter'); }
  check(await page.locator('#tags .tag').count() === 12, `${tag} 12 tags added`);
  check(await page.isDisabled('#sendBtn'), `${tag} send stays disabled until sensitivity answered`);
  await page.click('[data-sens="yes"]');
  check(await page.isDisabled('#sendBtn'), `${tag} «yes» requires the three follow-ups`);
  for (const k of ['minors', 'injured', 'graphic']) await page.click(`[data-fu="${k}"][data-v="0"]`);
  check(!(await page.isDisabled('#sendBtn')), `${tag} send enabled when complete`);
  check(await over() === 0, `${tag} send: no horizontal scroll`);
  const cl = await clipped(page); check(cl.length === 0, `${tag} send: no clipped text ${cl.join(' | ')}`);
  const es = await escapes(page); check(es.length === 0, `${tag} send: everything inside the phone ${es.join(' | ')}`);
  const btn = await page.locator('#sendBtn').boundingBox(); check(btn.height >= 44, `${tag} send button ≥ 44 high (${Math.round(btn.height)})`);
  await page.screenshot({ path: join(out, `${tag}-send.png`), fullPage: true });
  await page.click('#sendBtn');
  await page.waitForTimeout(900); await page.click('#off'); await page.waitForTimeout(400);
  check((await page.textContent('#pst')).length > 3 && await page.locator('#ulist .us').filter({ hasText: lang === 'ar' ? 'بانتظار' : 'Waiting' }).count() > 0, `${tag} offline state shown`);
  { const es2 = await escapes(page); check(es2.length === 0, `${tag} offline: layout intact ${es2.join(' | ')}`); }
  if (motion === 'reduce') check(await page.$eval('.ring', (e) => getComputedStyle(e).animationName) === 'none', `${tag} reduced motion stops the rings`);
  await page.screenshot({ path: join(out, `${tag}-offline.png`), fullPage: true });
  await page.click('#on');
  await page.waitForSelector('#s-receipt.on', { timeout: 20000 });
  check((await page.textContent('#rTitle')).includes('1,250'), `${tag} receipt carries the title`);
  await page.screenshot({ path: join(out, `${tag}-receipt.png`), fullPage: true });
  await page.click('#s-receipt [data-go="mine"]');
  check(await page.locator('#groups .group').count() === 2, `${tag} new group on top of «my materials»`);
  await page.click('[data-item="0"]');
  check(await page.isVisible('#vid'), `${tag} player opens`);
  check(await over() === 0, `${tag} player: no horizontal scroll`);
  await page.screenshot({ path: join(out, `${tag}-player.png`), fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
