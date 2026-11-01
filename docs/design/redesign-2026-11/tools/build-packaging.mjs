// تغليف «بوست ميدان»: الأيقونة (iOS 1024 + طبقتا أندرويد)، ولقطات المتجرين من النموذج الحيّ.
// الاستعمال: node tools/build-packaging.mjs   (يتطلب prototype/post-maydan.html مبنيًا)
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packaging'); mkdirSync(join(OUT, 'store'), { recursive: true });
const tokens = JSON.parse(readFileSync(join(ROOT, '..', 'tokens.v2.json'), 'utf8'));
const c = (p) => p.split('.').reduce((o, k) => o[k], tokens.color).$value;
const BRAND = c('brand.600'), BLUE = c('blue.600'), GOLD = c('accent.gold.500'), INK = c('neutral.850');

// ── الأيقونة: دوائر البثّ داخل منطقة أندرويد الآمنة (66 من 108 = نصف قطر 313 في 1024) ──
const rings = (stroke = '#FFFFFF') => `<g fill="none" stroke="${stroke}" stroke-width="40"><circle cx="512" cy="512" r="286" opacity=".38"/><circle cx="512" cy="512" r="200" opacity=".66"/><circle cx="512" cy="512" r="114"/></g><circle cx="512" cy="512" r="54" fill="${GOLD}"/>`;
const grad = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND}"/><stop offset="1" stop-color="${BLUE}"/></linearGradient></defs>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${body}</svg>\n`;
writeFileSync(join(OUT, 'icon.svg'), svg(`${grad}<rect width="1024" height="1024" fill="url(#g)"/>${rings()}`));
writeFileSync(join(OUT, 'icon-android-background.svg'), svg(`${grad}<rect width="1024" height="1024" fill="url(#g)"/>`));
writeFileSync(join(OUT, 'icon-android-foreground.svg'), svg(rings()));
writeFileSync(join(OUT, 'icon-android-monochrome.svg'), svg(rings('#000000').replace(GOLD, '#000000')));

const SCENES = [
  { id: 'send', ar: ['أرسل من الميدان بخطوة ', 'واحدة'], en: ['Send from the field in ', 'one step'] },
  { id: 'upload', ar: ['الرفع يكمل ', 'وحده'], en: ['Uploads finish ', 'on their own'] },
  { id: 'receipt', ar: ['إيصال لكل ', 'إرسال'], en: ['A receipt for ', 'every send'] },
  { id: 'mine', ar: ['موادك ', 'مرتّبة', ' بالعنوان والتاريخ'], en: ['Your footage, ', 'organised'] },
  { id: 'player', ar: ['شاهد كل ', 'إطار'], en: ['See ', 'every frame'] },
];
const SUB = {
  send: ['العنوان والنوع والوسوم وسؤال الحساسية، في شاشة واحدة.', 'Title, type, tags and the safety question on one screen.'],
  upload: ['نسخة خفيفة تصل المحرر فورًا، والأصل يُستأنف إن انقطعت الشبكة.', 'A light copy reaches editors at once; the original resumes after a drop.'],
  receipt: ['رقم وبصمة لكل إرسال، بلا أي بيانات كاشفة.', 'A number and fingerprint for each send, with nothing revealing.'],
  mine: ['ما أرسلته، وحالته التحريرية وحقوقه، في معرض واحد.', 'What you sent, with its editorial and rights status, in one gallery.'],
  player: ['إطار بإطار، بالسرعة التي تريد، وملء الشاشة.', 'Frame by frame, at any speed, full screen.'],
};

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy });
const proto = pathToFileURL(join(ROOT, 'prototype', 'post-maydan.html')).href;

// ١. التقاط شاشة التطبيق لكل مشهد بالعربية والإنجليزية (390pt × 3)
async function capture(lang, scene) {
  const ctx = await browser.newContext({ viewport: { width: 422, height: 900 }, deviceScaleFactor: 3, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${proto}?lang=${lang}&scale=1&mode=light`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '.review{display:none!important}.phone{margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;max-width:none!important}body{padding:0!important}.sim{display:none!important}' });
  const fill = async () => {
    await page.click('[data-go="send"]');
    await page.fill('#title', lang === 'ar' ? 'توزيع مساعدات غذائية في مخيم النصيرات' : 'Food aid distribution in Nuseirat camp');
    await page.click('[data-type="breaking"]');
    for (const t of lang === 'ar' ? ['مساعدات', 'النصيرات', 'شتاء'] : ['Aid', 'Nuseirat', 'Winter']) { await page.fill('#tagIn', t); await page.press('#tagIn', 'Enter'); }
    await page.click('[data-sens="no"]');
  };
  if (scene === 'send') await fill();
  if (scene === 'upload') { await fill(); await page.click('#sendBtn'); await page.waitForFunction(() => parseInt(document.querySelector('#pct').textContent) >= 45); }
  if (scene === 'receipt' || scene === 'mine' || scene === 'player') { await fill(); await page.click('#sendBtn'); await page.waitForSelector('#s-receipt.on', { timeout: 20000 }); }
  if (scene === 'mine' || scene === 'player') await page.click('#s-receipt [data-go="mine"]');
  if (scene === 'player') { await page.click('[data-item="0"]'); await page.evaluate(() => { const v = document.querySelector('#vid'); v.currentTime = 2.2; }); await page.waitForTimeout(300); }
  const shot = await page.locator('.phone').screenshot({ clip: undefined, type: 'png' });
  await ctx.close();
  return `data:image/png;base64,${shot.toString('base64')}`;
}

// ٢. تركيب اللقطة: خلفية وجه المؤسسات الداكنة، عنوان عريض بكلمة ذهبية، والهاتف
function storeHtml(lang, scene, img, android) {
  const h = scene[lang]; const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const head = h.map((p, i) => (i === 1 ? `<em>${p}</em>` : p)).join('');
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@400;500&family=Rubik:wght@800&display=swap">
<style>*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
body{background:radial-gradient(120% 70% at 50% 110%,${BRAND}55,transparent 60%),${INK};color:#EDF1F7;font-family:'Readex Pro',sans-serif;display:flex;flex-direction:column;align-items:center;padding:${android ? '34px 22px 0' : '64px 26px 0'};overflow:clip;position:relative}
.rings{position:absolute;right:0;top:0;width:240px;height:240px;opacity:.18}
h1{font:800 ${android ? 30 : 40}px/1.25 Rubik,'Readex Pro',sans-serif;margin:0;text-align:center;text-wrap:balance;max-width:92%}
em{font-style:normal;color:${GOLD}}
p{margin:${android ? 10 : 14}px 0 0;font-size:${android ? 14 : 17}px;line-height:1.6;color:#B7C3D3;text-align:center;max-width:86%}
.dev{margin-top:${android ? 22 : 36}px;width:${android ? 250 : 330}px;border-radius:${android ? 34 : 46}px;padding:${android ? 7 : 9}px;background:#1C2433;box-shadow:0 30px 80px -20px #000,inset 0 0 0 1.5px #2E3A4F}
.dev img{display:block;width:100%;border-radius:${android ? 28 : 38}px}
</style></head><body>
<svg class="rings" viewBox="0 0 200 200" aria-hidden="true"><g fill="none" stroke="${c('brand.300')}" stroke-width="3"><circle cx="100" cy="100" r="96"/><circle cx="100" cy="100" r="70"/><circle cx="100" cy="100" r="44"/></g></svg>
<h1>${head}</h1><p>${SUB[scene.id][lang === 'ar' ? 0 : 1]}</p><div class="dev"><img src="${img}" alt=""></div></body></html>`;
}

const results = [];
for (const lang of ['ar', 'en']) for (const [i, scene] of SCENES.entries()) {
  const img = await capture(lang, scene.id);
  for (const [android, w, h] of [[false, 440, 956], [true, 360, 640]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.setContent(storeHtml(lang, scene, img, android), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const file = join(OUT, 'store', `${android ? 'android' : 'ios'}-${lang}-${i + 1}-${scene.id}.png`);
    await page.screenshot({ path: file });
    results.push(file.split('/').pop());
    await ctx.close();
  }
}
// ٣. الأيقونة PNG للتحقق بصريًا عند 1024 و29
{
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1024 } }); const page = await ctx.newPage();
  await page.setContent(`<html><body style="margin:0">${readFileSync(join(OUT, 'icon.svg'), 'utf8')}</body></html>`);
  await page.screenshot({ path: join(OUT, 'icon-1024.png'), clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  await ctx.close();
}
await browser.close();
console.log(results.length, 'store shots +', 'icon-1024.png');
