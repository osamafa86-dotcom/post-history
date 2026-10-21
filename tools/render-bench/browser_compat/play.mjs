// يشغّل مخرجات العامل (النسخة الخفيفة تدريجيًا، ومقاطع HLS عبر MSE بنص CODECS المحسوب) في Chrome وFirefox وWebKit،
// ويكتب نتيجة بمخطط measurement.json. الاستعمال: node play.mjs <مجلد المواد> <ملف النتيجة>
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { chromium, firefox, webkit } from 'playwright-core';

const [dir, outFile] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
const TYPES = { '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.html': 'text/html', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = path === '/' ? '<!doctype html><body></body>' : await readFile(join(dir, path));
    res.writeHead(200, { 'Content-Type': TYPES[path.slice(path.lastIndexOf('.'))] ?? 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const ALL_BROWSERS = [
  ['chrome', () => chromium.launch({ channel: 'chrome' })],
  ['firefox', () => firefox.launch()],
  ['webkit', () => webkit.launch()],
];
const BROWSERS = ALL_BROWSERS.filter(([label]) => !ONLY || ONLY.includes(label));
const MIN_FRAMES = 30;

async function progressive(page, name) {
  return page.evaluate(async ({ name, min }) => {
    const v = document.createElement('video');
    v.muted = true; v.src = `/${name}/proxy.mp4`; document.body.append(v);
    try { await v.play(); } catch (e) { return { ok: false, error: String(e) }; }
    const t0 = performance.now();
    while (v.getVideoPlaybackQuality().totalVideoFrames < min && !v.ended && performance.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const q = v.getVideoPlaybackQuality();
    const r = { frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, width: v.videoWidth, height: v.videoHeight,
      error: v.error && v.error.code };
    v.remove();
    return { ok: r.frames >= min && !r.error, ...r };
  }, { name, min: MIN_FRAMES });
}

async function mse(page, name, codecs, segments) {
  return page.evaluate(async ({ name, codecs, segments, min }) => {
    const type = `video/mp4; codecs="${codecs}"`;
    if (!window.MediaSource || !MediaSource.isTypeSupported(type)) return { ok: false, error: `unsupported ${type}` };
    const ms = new MediaSource();
    const v = document.createElement('video');
    v.muted = true; v.src = URL.createObjectURL(ms); document.body.append(v);
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    const sb = ms.addSourceBuffer(type);
    for (const f of ['init.mp4', ...segments]) {
      const buf = await (await fetch(`/${name}/hls/${f}`)).arrayBuffer();
      sb.appendBuffer(buf);
      await new Promise((r, j) => { sb.onupdateend = r; sb.onerror = () => j(new Error(`append ${f}`)); });
    }
    ms.endOfStream();
    // المقاطع على خط زمن الأصل (-copyts) فقد تبدأ بعد الصفر؛ المشغّل يبدأ من أول ما خُزّن كما يفعل hls.js
    if (v.readyState < 1) {
      await Promise.race([new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true })),
        new Promise((r) => setTimeout(r, 5000))]);
    }
    const start = sb.buffered.length ? sb.buffered.start(0) : 0;
    if (start > 0.05) v.currentTime = start;
    try { await v.play(); } catch (e) { return { ok: false, error: String(e) }; }
    const t0 = performance.now();
    while (v.getVideoPlaybackQuality().totalVideoFrames < min && !v.ended && performance.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const q = v.getVideoPlaybackQuality();
    const r = { frames: q.totalVideoFrames, width: v.videoWidth, height: v.videoHeight, error: v.error && v.error.code };
    v.remove();
    return { ok: r.frames >= min && !r.error, ...r };
  }, { name, codecs, segments, min: MIN_FRAMES }).catch((e) => ({ ok: false, error: String(e) }));
}

// صفحة جديدة لكل قياس، ومهلة من جهة Node: صفحة معلّقة لا توقف بقية المتصفحات
async function fresh(browser, fn) {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    return await Promise.race([fn(page), new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), 30000))]);
  } catch (e) {
    return { ok: false, error: String(e).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

const results = {};
const versions = {};
const started = new Date().toISOString();
for (const [label, launch] of BROWSERS) {
  let browser;
  try { browser = await launch(); } catch (e) { results[label] = { launch_error: String(e).split('\n')[0] }; continue; }
  versions[label] = browser.version();
  results[label] = {};
  for (const [name, m] of Object.entries(manifest)) {
    const p = await fresh(browser, (page) => progressive(page, name));
    if (p.ok && (p.width !== m.width || p.height !== m.height)) Object.assign(p, { ok: false, error: 'size' });
    const h = await fresh(browser, (page) => mse(page, name, m.hls.codecs, m.hls.segments));
    results[label][name] = { progressive: p, hls_mse: h };
    console.log(label, name, p.ok ? 'ok' : `FAIL ${JSON.stringify(p)}`, h.ok ? 'ok' : `FAIL ${JSON.stringify(h)}`);
  }
  await browser.close();
}
server.close();

const metrics = { minimum_frames: MIN_FRAMES };
let allOk = true;
for (const [label, cases] of Object.entries(results)) {
  if (cases.launch_error) { metrics[`${label}_launched`] = false; allOk = false; continue; }
  metrics[`${label}_version`] = versions[label];
  for (const [name, r] of Object.entries(cases)) {
    metrics[`${label}_${name}_progressive`] = r.progressive.ok;
    metrics[`${label}_${name}_hls_mse`] = r.hls_mse.ok;
    allOk &&= r.progressive.ok && r.hls_mse.ok;
  }
}
const record = {
  schema_version: 1, tool: 'other', role: 'media', test_name: 'media-browser-h264-compat',
  started_at: started, ended_at: new Date().toISOString(),
  // Safari الحقيقي على macOS وiOS لم يُشغَّل؛ WebKit على Linux (GStreamer) أقرب بديل مقيس
  result: allOk ? 'partial' : 'fail',
  device: { platform: 'server', model: `${process.platform} ${process.arch}` }, upload_path: 'n/a',
  metrics,
};
if (outFile) await writeFile(outFile, JSON.stringify(record, null, 2) + '\n');
process.exit(allOk ? 0 : 1);
