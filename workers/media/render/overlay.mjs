// طبقة القالب الشفافة («مواد متداولة» ADR 0091، و«الشاهد» ADR 0109): ترسم مقاطع الإطارات المطلوبة من الحزمة المجمّعة وقت
// البناء بالمتصفح المثبّت في الصورة، ProRes 4444 بقناة شفافية موسومًا BT.709 بنطاق محدود، ثم يركّبها FFmpeg فوق الأصل في
// العامل.
//
// - المعاملات من ملف JSON يكتبه العامل (المسار وحده في سطر الأوامر)، وتصل القالب `inputProps` لا نصًّا في HTML.
// - لا شبكة: الخطّان والشعار في الحزمة، والمتصفح مُمرَّر صراحةً فلا تنزيل. ولا مفتاح ترخيص (`licenseKey: null`):
//   الرخصة المجانية بقرار المالك 2026-11-02، فلا حدث استخدام يغادر الحاوية (ADR 0091 البند 8).
// - لا يطبع شيئًا من المعاملات: مستوى سجلّ Remotion `error`، والفشل سطر واحد برمزه. سطر لا يتّسع عند 70% يرميه
//   `calculateMetadata` قبل أي إطار، فيخرج بالرمز 3 و`title_overflow`.
import { readFileSync } from 'node:fs';
import { openBrowser, renderMedia, selectComposition } from '@remotion/renderer';

// التركيبة من القالب في ملف المهمة، من قائمة مغلقة؛ والمقاس من `aspect` في المعاملات، لا من اسم التركيبة. التركيبتان
// تأخذان المعاملات نفسها، و«الشاهد» يرسم التاريخ والحساب فارغين دائمًا (لا اسم حساب ولا مصدر في أي إطار)
const COMPOSITIONS = { circulated: 'Overlay-Vertical', witness: 'Witness-Overlay-Render' };
const EXIT_TITLE_OVERFLOW = 3;

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const common = { logLevel: 'error', browserExecutable: job.browser, chromiumOptions: {} };
let browser;
try {
  const id = Object.hasOwn(COMPOSITIONS, job.template) ? COMPOSITIONS[job.template] : null;
  if (!id) throw Object.assign(new Error('unknown template'), { name: 'UnknownTemplate' });
  browser = await openBrowser('chrome', common);
  const composition = await selectComposition({
    ...common,
    serveUrl: job.serveUrl,
    id,
    inputProps: job.props,
    puppeteerInstance: browser,
  });
  if (composition.durationInFrames !== job.frames || composition.fps !== job.props.fps) {
    throw new Error('composition timing differs from the plan');
  }
  for (const piece of job.pieces) {
    await renderMedia({
      ...common,
      serveUrl: job.serveUrl,
      composition,
      inputProps: job.props,
      puppeteerInstance: browser,
      codec: 'prores',
      proResProfile: '4444',
      pixelFormat: 'yuva444p10le',
      imageFormat: 'png',
      colorSpace: 'bt709',
      muted: true,
      frameRange: [piece.from, piece.to],
      outputLocation: piece.out,
      overwrite: true,
      concurrency: job.concurrency ?? null,
      licenseKey: null,
    });
  }
} catch (err) {
  const overflow = err?.code === 'title_overflow' || /title_overflow/.test(String(err?.message ?? ''));
  process.stderr.write(overflow ? 'title_overflow\n' : `overlay_failed ${err?.name ?? 'Error'}\n`);
  process.exitCode = overflow ? EXIT_TITLE_OVERFLOW : 1;
} finally {
  await browser?.close({ silent: true }).catch(() => {});
}
