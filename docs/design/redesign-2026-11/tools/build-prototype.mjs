// يولّد prototype/post-maydan.html من القالب post-maydan.src.html ورموز docs/design/tokens.v2.json.
// الاستعمال: node tools/build-prototype.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const tokens = JSON.parse(readFileSync(join(ROOT, '..', 'tokens.v2.json'), 'utf8'));
const at = (ref) => (ref.includes('/') && !ref.startsWith('color/') ? `color/${ref}` : ref).split(/[./]/).reduce((o, k) => o?.[k], tokens);
const resolve = (ref, mode) => { let v = at(ref).$value; if (typeof v === 'object') v = v[mode]; const m = typeof v === 'string' && v.match(/^\{(.+)\}$/); return m ? resolve(m[1], mode) : v; };

// المسارات بشرطة مائلة (كأسماء Figma)؛ تُحوَّل إلى نقاط عند الحلّ.
const SEM = ['bg/base', 'bg/raised', 'bg/sunken', 'text/primary', 'text/secondary', 'text/on-brand', 'border/line', 'border/edge', 'action/primary', 'action/gradient-end', 'priority/urgent', 'sensitivity/bg', 'sensitivity/border', 'state/ok', 'state/warn', 'state/muted', 'state/brand', 'state/danger'];
const block = (mode) => SEM.map((p) => `--${p.replace('/', '-')}:${resolve(`color/${p}`, mode)}`).join(';')
  + `;--page:${mode === 'light' ? resolve('color/neutral/50', 'light') : resolve('color/neutral/950', 'light')};color-scheme:${mode}`;
const fam = (k) => tokens.font.family[k].$value.map((f) => (f.includes(' ') ? `'${f}'` : f)).join(',');
const r = (k) => tokens.radius[k].$value;
const css = `:root{${block('light')};--f-display:${fam('display')};--f-text:${fam('text')};--f-num:${fam('num')};--r-sm:${r('sm')};--r-md:${r('md')};--r-chip:${r('chip')}}\n:root[data-mode="dark"]{${block('dark')}}`;

const pairs = ['light', 'dark'].flatMap((mode) => tokens.$extensions['v2.contrastPairs'].map(([fg, bg, role]) => ({ name: `${mode} ${fg} on ${bg}`, fg: resolve(fg, mode), bg: resolve(bg, mode), role })));

const P = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'), check: P('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), clock: P('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>'),
  wifi: P('<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M19 13a10 10 0 0 0-3-2"/>'), bolt: P('<path d="M13 3L5 13.5h6L10 21l9-11h-6z"/>'),
  pin: P('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'), shield: P('<path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z"/>'),
  pen: P('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), key: P('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>'),
  play: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor;stroke:none"><path d="M8 5.5v13l11-6.5z"/></svg>', pause: P('<path d="M8 5v14M16 5v14"/>'),
};

const T = {
  hint: ['نموذج تجريبي: الملفات والصور عيّنات، ولا يُرسل شيء.', 'Prototype: files and images are samples. Nothing is sent.'],
  hello: ['مساء الخير، سامي', 'Good evening, Sami'], sendField: ['إرسال من الميدان', 'Send from the field'],
  shareHint: ['أو شارك من معرض الصور مباشرة: اختر المقاطع ← مشاركة ← ميدان بوست', 'Or share straight from Photos: pick clips → Share → Maydan Post'],
  recent: ['آخر الإرسالات', 'Recent sends'], g2: ['غرق الخيام بعد المنخفض الجوي', 'Tents flooded after the storm'], arrived: ['وصل', 'Arrived'], mine: ['موادي', 'My materials'],
  newSend: ['إرسال جديد', 'New send'], files: ['3 ملفات', '3 files'], lightStarted: ['نجهّز نسخة خفيفة على الهاتف الآن، ويبدأ رفعها حين تضغط «أرسل».', 'Preparing a light copy on your phone. It starts uploading when you tap Send.'],
  fTitle: ['عنوان التغطية', 'Coverage title'], titlePh: ['مثال: توزيع مساعدات في مخيم النصيرات', 'e.g. Aid distribution in Nuseirat camp'],
  fType: ['نوع التغطية', 'Coverage type'], fTags: ['الوسوم', 'Tags'], addTag: ['أضف وسمًا ثم Enter', 'Add a tag, then Enter'], fromDesk: ['من قائمة الإدارة:', 'From the desk list:'],
  place: ['دير البلح · النصيرات', 'Deir al-Balah · Nuseirat'], remembered: ['من آخر إرسال', 'From your last send'], urgent: ['عاجل', 'Urgent'],
  sensQ: ['هل تتضمن المواد قاصرين أو مصابين أو مشاهد صادمة؟', 'Does it include minors, injured people or graphic scenes?'], no: ['لا', 'No'], yes: ['نعم', 'Yes'],
  fu_minors: ['هل يظهر فيها قاصرون؟', 'Are minors visible?'], fu_injured: ['هل يظهر فيها مصابون؟', 'Are injured people visible?'], fu_graphic: ['هل فيها مشاهد صادمة؟', 'Does it show graphic scenes?'],
  needTitle: ['اكتب عنوان التغطية (5 أحرف على الأقل)', 'Write the coverage title (5+ characters)'], needType: ['اختر نوع التغطية', 'Choose the coverage type'],
  needSens: ['أجب عن سؤال الحساسية', 'Answer the sensitivity question'], needFu: ['أجب عن الأسئلة الثلاثة', 'Answer the three questions'],
  send3: ['أرسل 3 مواد', 'Send 3 items'], uploading: ['يُرفع', 'Uploading'], simOff: ['محاكاة: انقطاع الشبكة', 'Simulate: go offline'], simOn: ['محاكاة: عودة الشبكة', 'Simulate: back online'],
  bgNote: ['أغلق التطبيق متى شئت، والرفع يكمل وحده.', 'Close the app any time. The upload carries on.'],
  clip1: ['مقطع 1', 'Clip 1'], clip2: ['مقطع 2', 'Clip 2'], photo3: ['صورة 3', 'Photo 3'], waitingNet: ['بانتظار الشبكة', 'Waiting for network'],
  lightArrived: ['وصلت نسخة خفيفة، والمحرر يستطيع مشاهدتها الآن.', 'A light copy has arrived. Editors can watch it now.'],
  offline: ['انقطعت الشبكة. ما وصل محفوظ، والرفع يُستأنف وحده حين تعود.', 'You’re offline. What arrived is safe, and the upload resumes when you reconnect.'],
  delivered: ['وصلت المواد', 'Delivered'], deliveredSub: ['استلم المحرّرون 3 مواد بعنوان', 'Editors received 3 items titled'],
  rNo: ['رقم الإيصال', 'Receipt no.'], rTime: ['الوقت', 'Time'], rSize: ['الحجم', 'Size'], rHash: ['البصمة', 'Fingerprint'], again: ['إرسال آخر', 'Send another'],
  fAll: ['الكل', 'All'], fVideo: ['فيديو', 'Video'], fPhotos: ['صور', 'Photos'], fUrgent: ['عاجل', 'Urgent'], today: ['اليوم', 'Today'], yesterday: ['أمس', 'Yesterday'],
  processing: ['تُعالَج', 'Processing'], inReview: ['قيد المراجعة', 'In review'], ready: ['جاهزة', 'Ready'], approved: ['معتمدة', 'Approved'], internal: ['داخلي', 'Internal'], listed: ['للعرض', 'Listed'],
  open: ['افتح المادة', 'Open item'], empty: ['لا مواد بهذا الفلتر.', 'Nothing matches this filter.'], remove: ['إزالة', 'Remove'],
  needTags: ['أضف وسمًا واحدًا على الأقل', 'Add at least one tag'],
  stPreview: ['وصلت المعاينة', 'Preview arrived'], stOriginal: ['وصل الأصل وتحقّق', 'Original verified'], stBackup: ['اكتملت النسخة الاحتياطية', 'Backup complete'],
  delLocal: ['احذف النسخ المحلية من الهاتف بعد اكتمال النسخة الاحتياطية', 'Delete the copies on this phone once the backup completes'],
  delLocalHint: ['الأصل محفوظ ببصمته على الخادم، ويبقى في «موادي».', 'The original is kept with its fingerprint on the server and stays in My materials.'],
  alReview: ['أدوات المراجعة', 'Review tools'], alHome: ['الرئيسية', 'Home'], alSend: ['إرسال جديد', 'New send'], alUpload: ['الرفع', 'Upload'], alReceipt: ['الإيصال', 'Receipt'], alMine: ['موادي', 'My materials'], alItem: ['مادة', 'Item'],
  alClose: ['إغلاق', 'Close'], alBack: ['رجوع', 'Back'], alSeek: ['موضع التشغيل', 'Playback position'], alFb: ['إطار للخلف', 'Back one frame'], alFf: ['إطار للأمام', 'Forward one frame'], alPlay: ['تشغيل', 'Play'], alPause: ['إيقاف مؤقت', 'Pause'], alFs: ['ملء الشاشة', 'Full screen'],
  item: ['مادة', 'Item'], iMeta: ['دير البلح · 1:42 · فيديو', 'Deir al-Balah · 1:42 · Video'], stTech: ['فنية', 'Technical'], stEdit: ['تحريرية', 'Editorial'], stRights: ['حقوق', 'Rights'],
};

let html = readFileSync(join(ROOT, 'prototype', 'post-maydan.src.html'), 'utf8');
const video = `data:video/mp4;base64,${readFileSync(join(ROOT, 'directions', 'samples', 'store-sample.mp4')).toString('base64')}`;
const put = (s, k, v) => s.split(k).join(v);
html = put(put(put(put(put(html, '/*__TOKENS__*/', css), '__PAIRS__', JSON.stringify({ pairs })), '__STRINGS__', JSON.stringify(T)), '__ICONS__', JSON.stringify(ICONS)), '__VIDEO__', video).replace(/__I_([a-z]+)__/g, (_, n) => ICONS[n]);
const missing = [...html.matchAll(/data-(?:i|aria)="([^"]+)"/g)].map((m) => m[1]).filter((k) => !T[k]);
if (missing.length) throw new Error(`missing strings: ${[...new Set(missing)].join(', ')}`);
writeFileSync(join(ROOT, 'prototype', 'post-maydan.html'), html);
console.log('built prototype/post-maydan.html');
