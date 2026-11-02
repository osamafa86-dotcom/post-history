// يولّد نماذج الاتجاهات البصرية الثلاثة من مصدر واحد:
//   directions/a.html · b.html · c.html  — اتجاه واحد مثبّت في كلٍّ منها
//   directions/index.html                — الثلاثة بتبويبات (هي ما يُنشر للمالك)
// الاستعمال: node tools/build-directions.mjs
// العيّنات في directions/samples/ مستبعدة من جيت (.gitignore: samples/ و*.mp4)، فتُولَّد قبل التشغيل:
//   ffmpeg -f lavfi -i "gradients=s=270x480:d=6:c0=0x0B6E79:c1=0x0A1A2F:speed=0.02" -pix_fmt yuv420p -c:v libx264 directions/samples/store-sample.mp4
//   شعار logo-480.png: brand/palpost-logo.svg مرسومًا بعرض 480 (أي محوّل SVG→PNG)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'directions');
const b64 = (p) => readFileSync(join(OUT, 'samples', p)).toString('base64');
const LOGO = `data:image/png;base64,${b64('logo-480.png')}`;
const VIDEO = `data:video/mp4;base64,${b64('store-sample.mp4')}`;

// ── الاتجاهات: الألوان بالوضعين، والخطوط، والوضع الأصلي ─────────────────────
const DIRS = {
  a: {
    home: 'dark',
    fonts: { display: "'Alexandria', 'Noto Kufi Arabic', system-ui, sans-serif", text: "'IBM Plex Sans Arabic', 'Noto Sans Arabic', system-ui, sans-serif", num: "'JetBrains Mono', ui-monospace, monospace" },
    dark: { bg: '#06121A', raised: '#0C1C26', sunken: '#030A0F', line: '#1A3240', edge: '#4B6B79', text: '#E6F3F5', text2: '#8FAAB5', brand: '#3CCFDB', brand2: '#3CCFDB', brandInk: '#031418', brandSoft: '#0E3440', gold: '#E4B543', goldSoft: '#3A2E0C', urgent: '#FF6257', ok: '#43D99A', warn: '#F0B43C' },
    light: { bg: '#EEF4F6', raised: '#FFFFFF', sunken: '#E1EBEE', line: '#CFDDE2', edge: '#748C96', text: '#08202A', text2: '#456270', brand: '#086C77', brand2: '#086C77', brandInk: '#FFFFFF', brandSoft: '#D6ECEF', gold: '#8A6208', goldSoft: '#F6E3AE', urgent: '#C42F28', ok: '#17804F', warn: '#8A6100' },
  },
  b: {
    home: 'light',
    fonts: { display: "'Baloo Bhaijaan 2', 'Noto Kufi Arabic', system-ui, sans-serif", text: "'Readex Pro', 'Noto Sans Arabic', system-ui, sans-serif", num: "'JetBrains Mono', ui-monospace, monospace" },
    light: { bg: '#E8ECE7', raised: '#F8F9F5', sunken: '#DCE2DB', line: '#C3CCC3', edge: '#2B3734', text: '#111B19', text2: '#485652', brand: '#0D6870', brand2: '#0D6870', brandInk: '#FFFFFF', brandSoft: '#D0E4E1', gold: '#7E5C06', goldSoft: '#F1D27A', urgent: '#B3261E', ok: '#2A6B3F', warn: '#775400' },
    dark: { bg: '#101715', raised: '#18211F', sunken: '#0A100E', line: '#2A3633', edge: '#8E9C97', text: '#E8EEEA', text2: '#9BAAA4', brand: '#5CC3C6', brand2: '#5CC3C6', brandInk: '#071A1B', brandSoft: '#1C3534', gold: '#E3B84E', goldSoft: '#4A3A10', urgent: '#FF6B5F', ok: '#5FCB8A', warn: '#E5B54A' },
  },
  c: {
    home: 'light',
    fonts: { display: "'Rubik', 'Readex Pro', system-ui, sans-serif", text: "'Readex Pro', 'Noto Sans Arabic', system-ui, sans-serif", num: "'Rubik', ui-monospace, monospace" },
    light: { bg: '#F4F6F9', raised: '#FFFFFF', sunken: '#E9EDF3', line: '#DCE2EA', edge: '#6E7B93', text: '#0D1524', text2: '#55617A', brand: '#08717E', brand2: '#2E56E8', brandInk: '#FFFFFF', brandSoft: '#E0F1F4', gold: '#8A6608', goldSoft: '#F5E6B8', urgent: '#C8312B', ok: '#18764E', warn: '#8A6200' },
    dark: { bg: '#090D15', raised: '#121A28', sunken: '#060910', line: '#232C3D', edge: '#6E7B93', text: '#EDF1F7', text2: '#96A2B8', brand: '#42CFDF', brand2: '#8A9DFF', brandInk: '#0A1F26', brandSoft: '#10303A', gold: '#E1B64B', goldSoft: '#3D3110', urgent: '#FF6A60', ok: '#4FD69B', warn: '#E9B649' },
  },
};

// الأزواج التي تُفحص: (لون، خلفية، الدور) — text ≥ 4.5 · large/ui ≥ 3
const PAIRS = [
  ['text', 'bg', 'text'], ['text2', 'bg', 'text'], ['text', 'raised', 'text'], ['text2', 'raised', 'text'],
  ['text2', 'sunken', 'text'], ['brandInk', 'brand', 'text'], ['brandInk', 'brand2', 'text'], ['brand', 'bg', 'text'],
  ['brand', 'raised', 'text'], ['brand', 'brandSoft', 'text'], ['text', 'goldSoft', 'text'], ['gold', 'bg', 'large'],
  ['urgent', 'raised', 'text'], ['ok', 'raised', 'text'], ['warn', 'raised', 'text'], ['edge', 'raised', 'ui'], ['edge', 'bg', 'ui'],
];
const pairsFor = (ids) => ids.flatMap((d) => ['light', 'dark'].flatMap((m) =>
  PAIRS.map(([fg, bg, role]) => ({ d, mode: m, name: `${d}/${m} ${fg} on ${bg}`, fg: DIRS[d][m][fg], bg: DIRS[d][m][bg], role }))));

const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const vars = (o) => Object.entries(o).map(([k, v]) => `--${kebab(k)}:${v}`).join(';');
function tokenCss(ids) {
  const first = ids[0];
  let css = `:root{${vars(DIRS[first][DIRS[first].home])};--f-display:${DIRS[first].fonts.display};--f-text:${DIRS[first].fonts.text};--f-num:${DIRS[first].fonts.num};color-scheme:${DIRS[first].home}}\n`;
  for (const d of ids) for (const m of ['light', 'dark'])
    css += `:root[data-d="${d}"][data-mode="${m}"]{${vars(DIRS[d][m])};--f-display:${DIRS[d].fonts.display};--f-text:${DIRS[d].fonts.text};--f-num:${DIRS[d].fonts.num};color-scheme:${m}}\n`;
  return css;
}

// ── النصوص بالعربية والإنجليزية ──────────────────────────────────────────────
const T = {
  pageTitle: ['اتجاهات بوست ميدان', 'Post Maydan directions'],
  pageLede: ['ثلاث هويات مقترحة لتطبيق المراسل والمكتبة المرئية. جرّب كل اتجاه بالوضعين واللغتين، ثم اختر واحدًا أو امزج بين اثنين.', 'Three proposed identities for the reporter app and the visual library. Try each one in both modes and both languages, then pick one or mix two.'],
  lang: ['English', 'عربي'], dark: ['داكن', 'Dark'], light: ['فاتح', 'Light'], stress: ['عنوان طويل و12 وسمًا', 'Long title + 12 tags'],
  a: ['بثّ', 'Broadcast'], b: ['ميدان', 'Field'], c: ['إشارة ✓', 'Signal ✓'],
  aBlurb: ['داكن عميق كشاشة غرفة الأخبار، فيروزي كهربائي، وذهبي نادر. دوائر البثّ تنبض أثناء الرفع، وهو الأقرب إلى إحساس الجزيرة 360 بين الثلاثة.', 'Deep newsroom-screen dark, electric teal, rare gold. Broadcast rings pulse while uploading. Closest to Al Jazeera 360.'],
  bBlurb: ['فاتح كدفتر المراسل، فيروزي عميق، ونقاط خريطة الشعار. حدود حبر واضحة وأختام بدل الظلال الناعمة. يُقرأ في شمس الميدان.', 'Light like a reporter’s notebook, deep teal, the logo’s map dots. Clear ink edges and stamps instead of soft shadows. Readable in field sunlight.'],
  cBlurb: ['المعتمد (2026-11-01). محايد بارد بالغ الحداثة، والفيروزي غالب. التدرّج إلى الأزرق في زر الإرسال والأيقونة وحدهما، ودوائر البثّ تنبض أثناء الرفع، وحدود الحقول وسؤال الحساسية أوضح ليُقرأ في الشمس.', 'Chosen (1 Nov 2026). Cool and neutral, teal leading. The teal-to-blue blend only on the send button and the icon, broadcast rings pulse while uploading, and field edges and the sensitivity question are stronger for sunlight.'],
  secScreens: ['شاشات المراسل', 'Reporter screens'], secStore: ['وجه المؤسسات والأيقونة', 'Buyer face and app icon'], secColor: ['اللون والتباين', 'Colour and contrast'], secType: ['الخط', 'Type'],
  sSend: ['الإرسال', 'Send'], sUpload: ['الرفع', 'Upload'], sReceipt: ['الإيصال', 'Receipt'], sGallery: ['موادي', 'My materials'],
  newSend: ['إرسال جديد', 'New send'], files: ['3 ملفات', '3 files'],
  fTitle: ['عنوان التغطية', 'Coverage title'], titleVal: ['توزيع مساعدات غذائية في مخيم النصيرات', 'Food aid distribution in Nuseirat camp'],
  fType: ['نوع التغطية', 'Coverage type'], tyEvent: ['حدث ميداني', 'Field event'], tyReport: ['تقرير', 'Report'], tyInterview: ['مقابلة', 'Interview'], tyBroll: ['مشاهد خام', 'Raw footage'],
  fTags: ['الوسوم', 'Tags'], tag1: ['مساعدات', 'Aid'], tag2: ['النصيرات', 'Nuseirat'], tag3: ['شتاء', 'Winter'], addTag: ['أضف وسمًا', 'Add a tag'], suggest: ['طوابير', 'Queues'], fromAdmin: ['من قائمة الإدارة', 'From the desk list'],
  fPlace: ['المكان', 'Location'], placeVal: ['دير البلح · النصيرات', 'Deir al-Balah · Nuseirat'], remembered: ['من آخر إرسال', 'From your last send'],
  urgent: ['عاجل', 'Urgent'], urgentHint: ['يصل المحرر فورًا مع تنبيه', 'Alerts the editor right away'],
  sens: ['هل تتضمن المواد قاصرين أو مصابين أو مشاهد صادمة؟', 'Does it include minors, injured people or graphic scenes?'], no: ['لا', 'No'], yes: ['نعم', 'Yes'],
  sendCta: ['أرسل 3 مواد', 'Send 3 items'],
  uploading: ['يُرفع', 'Uploading'], reassure: ['وصلت نسخة خفيفة من الملفين الأولين، والمحرر يستطيع مشاهدتهما الآن.', 'A light copy of the first two files has arrived. Editors can watch them now.'],
  bg: ['أغلق التطبيق متى شئت، والرفع يكمل وحده.', 'Close the app any time. The upload carries on.'],
  clip1: ['مقطع 1', 'Clip 1'], clip2: ['مقطع 2', 'Clip 2'], photo3: ['صورة 3', 'Photo 3'], arrived: ['وصل', 'Arrived'], waitingNet: ['بانتظار الشبكة', 'Waiting for network'],
  delivered: ['وصلت المواد', 'Delivered'], deliveredSub: ['استلم المحرّرون 3 مواد بعنوان', 'Editors received 3 items titled'],
  rNo: ['رقم الإيصال', 'Receipt no.'], rTime: ['الوقت', 'Time'], rSize: ['الحجم', 'Size'], rHash: ['البصمة', 'Fingerprint'],
  again: ['إرسال آخر', 'Send another'], mine: ['موادي', 'My materials'],
  fAll: ['الكل', 'All'], fVideo: ['فيديو', 'Video'], fPhotos: ['صور', 'Photos'], fUrgent: ['عاجل', 'Urgent'],
  today: ['حدث ميداني · اليوم', 'Field event · Today'], g2Title: ['غرق الخيام بعد المنخفض الجوي', 'Tents flooded after the storm'], yesterday: ['تقرير · أمس', 'Report · Yesterday'],
  stTech: ['فنية', 'Technical'], stEdit: ['تحريرية', 'Editorial'], stRights: ['حقوق', 'Rights'],
  ready: ['جاهزة', 'Ready'], processing: ['تُعالَج', 'Processing'], inReview: ['قيد المراجعة', 'In review'], approved: ['معتمدة', 'Approved'], internal: ['داخلي', 'Internal'], forSale: ['للعرض', 'Listed'],
  preview: ['معاينة', 'Preview'], storeTitle: ['طوابير الخبز في النصيرات', 'Bread queues in Nuseirat'], filmed: ['صُوّر 28 أكتوبر 2026', 'Filmed 28 Oct 2026'], gov: ['دير البلح', 'Deir al-Balah'],
  hover: ['مرّر أو المس للمعاينة', 'Hover or tap to preview'], request: ['اطلب المادة', 'Request footage'], iconCap: ['أيقونة التطبيق', 'App icon'],
  typeDisplay: ['المكتبة المرئية', 'The Visual Library'], typeTitle: ['ما يصوّره المراسل يصل كاملًا', 'What reporters film arrives whole'],
  typeBody: ['المراسل يرسل من الميدان بخطوة واحدة، والمحرر يرى نسخة خفيفة أولًا، والأصل يصل كاملًا ببصمته.', 'Reporters send from the field in one step. Editors see a light copy first, and the original arrives intact with its fingerprint.'],
  typeCaption: ['تعليق · 13 بكسل', 'Caption · 13px'],
  thPair: ['الزوج', 'Pair'], thRatio: ['النسبة', 'Ratio'], thNeed: ['المطلوب', 'Needed'], pass: ['يجتاز', 'Pass'], fail: ['لا يجتاز', 'Fail'],
  sample: ['عيّنة', 'Sample'],
};
const STRESS = {
  title: ['توزيع مساعدات WFP على 1,250 عائلة في مخيم النصيرات وسط قطاع غزة يوم 28/10 صباحًا', 'WFP aid to 1,250 families in مخيم النصيرات, central Gaza Strip, on 28 Oct, day 3'],
  tags: [['مساعدات', 'النصيرات', 'شتاء', 'WFP', 'طوابير', 'أطفال', 'دير البلح', 'نزوح', 'خيام', 'مطر', 'وكالة الغوث UNRWA', 'توزيع الطحين في الصباح الباكر'],
    ['Aid', 'Nuseirat', 'Winter', 'WFP', 'Queues', 'Children', 'Deir al-Balah', 'Displacement', 'Tents', 'Rain', 'UNRWA وكالة', 'Early-morning flour distribution']],
};
const t = (k) => `<span data-i="${k}">${T[k][0]}</span>`;

// ── عناصر مشتركة ────────────────────────────────────────────────────────────
const ic = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>',
  wifiOff: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M19 13a10 10 0 0 0-3-2M2 9.5a15 15 0 0 1 4-2.6M22 9.5A15 15 0 0 0 12 5.5"/><circle cx="12" cy="20" r=".8"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l9-11h-6z"/>', pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z"/>', film: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M16 5v14M4 9.5h4M16 9.5h4M4 14.5h4M16 14.5h4"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 17"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>', play: '<path d="M8 5.5v13l11-6.5z"/>',
};
const svg = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ic[n]}</svg>`;

function rings(pct, label) {
  const p = Math.round(pct * 100);
  return `<div class="rings" role="img" aria-label="${p}%">
  <svg viewBox="0 0 200 200" aria-hidden="true">
    <circle class="ring r3" cx="100" cy="100" r="94"/><circle class="ring r2" cx="100" cy="100" r="78"/><circle class="ring r1" cx="100" cy="100" r="62"/>
    <circle class="track" cx="100" cy="100" r="46"/><circle class="arc" cx="100" cy="100" r="46" pathLength="100" stroke-dasharray="${p} 100"/>
  </svg><div class="rings-c"><b class="num">${p}%</b>${label}</div></div>`;
}
const stateBadge = (icon, k, v, tone) => `<span class="st st-${tone}" title="${T[k][0]}">${svg(icon)}<span class="sr">${t(k)}: </span>${t(v)}</span>`;

const phone = (label, body) => `<figure class="phone-wrap"><figcaption>${label}</figcaption><div class="phone"><div class="statusbar"><span class="num">9:41</span><span class="sb-r"><i></i><i></i><i></i></span></div>${body}</div></figure>`;

const SEND = phone(t('sSend'), `
<header class="bar"><button class="iconbtn" aria-label="close">${svg('close')}</button><h3>${t('newSend')}</h3><span class="bar-s"></span></header>
<div class="screen">
  <div class="picked"><div class="pk th1"><span class="dur num">1:42</span></div><div class="pk th2"><span class="dur num">3:05</span></div><div class="pk th3"></div><div class="pk-meta"><b>${t('files')}</b><span class="num" dir="ltr">412 MB</span></div></div>
  <label class="fld"><span class="lbl">${t('fTitle')}</span><span class="input" id="title-box"><span class="tv" data-i="titleVal" data-stress="title">${T.titleVal[0]}</span><span class="count num" dir="ltr" data-count>38/80</span></span></label>
  <div class="fld"><span class="lbl">${t('fType')}</span><div class="seg"><span class="chip on">${t('tyEvent')}</span><span class="chip">${t('tyReport')}</span><span class="chip">${t('tyInterview')}</span><span class="chip">${t('tyBroll')}</span></div></div>
  <div class="fld"><span class="lbl">${t('fTags')}</span><div class="tags" data-tags><span class="tag">${t('tag1')}<i>×</i></span><span class="tag">${t('tag2')}<i>×</i></span><span class="tag">${t('tag3')}<i>×</i></span><span class="tag-add">${svg('plus')}${t('addTag')}</span></div>
    <div class="suggest"><span class="tag ghost">${t('suggest')}</span><small>${t('fromAdmin')}</small></div></div>
  <div class="row2"><div class="place">${svg('pin')}<div><b>${t('placeVal')}</b><small>${t('remembered')}</small></div></div>
    <button class="urgent" aria-pressed="false">${svg('bolt')}<span>${t('urgent')}</span></button></div>
  <div class="sens"><p>${svg('shield')}<span>${t('sens')}</span></p><div class="yn"><span class="chip on">${t('no')}</span><span class="chip">${t('yes')}</span></div></div>
  <button class="cta">${t('sendCta')}</button>
</div>`);

const UPLOAD = phone(t('sUpload'), `
<header class="bar"><span class="bar-s"></span><h3>${t('uploading')}</h3><span class="bar-s"></span></header>
<div class="screen center">
  ${rings(0.64, t('uploading'))}
  <p class="reassure">${svg('check')}<span>${t('reassure')}</span></p>
  <ul class="ulist">
    <li><span class="ut th1"></span><span class="un">${t('clip1')} <span class="num">· 1:42</span></span><span class="us ok">${svg('check')}${t('arrived')}</span></li>
    <li><span class="ut th2"></span><span class="un">${t('clip2')} <span class="num">· 3:05</span></span><span class="us run"><span class="num" dir="ltr">64%</span></span><span class="ubar"><i style="inline-size:64%"></i></span></li>
    <li><span class="ut th3"></span><span class="un">${t('photo3')}</span><span class="us wait">${svg('wifiOff')}${t('waitingNet')}</span></li>
  </ul>
  <p class="muted small">${t('bg')}</p>
</div>`);

const RECEIPT = phone(t('sReceipt'), `
<div class="screen center receipt">
  <div class="rc-mark"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="ring r3" cx="100" cy="100" r="94"/><circle class="ring r2" cx="100" cy="100" r="76"/><circle class="ring r1" cx="100" cy="100" r="58"/><circle class="done" cx="100" cy="100" r="40"/></svg>${svg('check', 'rc-check')}</div>
  <h2 class="disp">${t('delivered')}</h2>
  <p class="muted">${t('deliveredSub')} <q data-i="titleVal" data-stress="title">${T.titleVal[0]}</q></p>
  <dl class="slip">
    <div><dt>${t('rNo')}</dt><dd class="num" dir="ltr">PH-2611-0482</dd></div>
    <div><dt>${t('rTime')}</dt><dd class="num" dir="ltr">14:32</dd></div>
    <div><dt>${t('rSize')}</dt><dd class="num" dir="ltr">412 MB</dd></div>
    <div><dt>${t('rHash')}</dt><dd class="num" dir="ltr">9f2c…a71e</dd></div>
  </dl>
  <div class="two"><button class="cta ghost">${t('again')}</button><button class="cta solid">${t('mine')}</button></div>
</div>`);

const card = (th, dur, kind, tech, edit, rights, urgent = false) => `<article class="mcard">
  <div class="mthumb ${th}">${kind === 'v' ? `<span class="dur num">${dur}</span>` : ''}${urgent ? `<span class="pill-urgent">${svg('bolt')}${t('urgent')}</span>` : ''}<span class="kind">${svg(kind === 'v' ? 'film' : 'image')}</span></div>
  <div class="mstates">${stateBadge(tech[0], 'stTech', tech[1], tech[2])}${stateBadge('pen', 'stEdit', edit[0], edit[1])}${stateBadge('key', 'stRights', rights[0], rights[1])}</div>
</article>`;

const GALLERY = phone(t('sGallery'), `
<header class="bar"><h3 class="disp">${t('mine')}</h3><span class="bar-s"></span><button class="iconbtn" aria-label="settings">${svg('gear')}</button></header>
<div class="screen">
  <div class="filters"><span class="chip on">${t('fAll')}</span><span class="chip">${t('fVideo')}</span><span class="chip">${t('fPhotos')}</span><span class="chip">${t('fUrgent')}</span></div>
  <section class="group"><h4 data-i="titleVal" data-stress="title">${T.titleVal[0]}</h4><small>${t('today')}</small>
    <div class="grid">${card('th1', '1:42', 'v', ['check', 'ready', 'ok'], ['inReview', 'warn'], ['internal', 'mute'], true)}${card('th2', '3:05', 'v', ['clock', 'processing', 'mute'], ['inReview', 'warn'], ['internal', 'mute'])}${card('th3', '', 'p', ['check', 'ready', 'ok'], ['approved', 'ok'], ['forSale', 'brand'])}</div></section>
  <section class="group"><h4>${t('g2Title')}</h4><small>${t('yesterday')}</small>
    <div class="grid">${card('th4', '0:58', 'v', ['check', 'ready', 'ok'], ['approved', 'ok'], ['forSale', 'brand'])}${card('th5', '2:11', 'v', ['check', 'ready', 'ok'], ['approved', 'ok'], ['internal', 'mute'])}</div></section>
</div>`);

const STORE = `<div class="store-row">
  <article class="store" tabindex="0" aria-label="${T.storeTitle[0]}">
    <div class="sv"><video muted loop playsinline preload="metadata" src="${VIDEO}"></video><img class="wm" src="${LOGO}" alt=""><span class="pv">${t('preview')}</span><span class="dur num">1:42</span><span class="play">${svg('play')}</span></div>
    <div class="sb"><h4 class="disp">${t('storeTitle')}</h4><p><span>${t('filmed')}</span><span class="dot">·</span><span>${t('gov')}</span></p><button class="cta small">${t('request')}</button><small class="muted">${t('hover')}</small></div>
  </article>
  <figure class="icons"><div class="appicon" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/><circle cx="50" cy="50" r="29"/><circle cx="50" cy="50" r="18"/><circle class="core" cx="50" cy="50" r="8"/></svg></div>
    <div class="appicon sm" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/><circle cx="50" cy="50" r="29"/><circle cx="50" cy="50" r="18"/><circle class="core" cx="50" cy="50" r="8"/></svg></div>
    <figcaption>${t('iconCap')}<br><b>${t('a') /* replaced per tab */}</b></figcaption></figure>
</div>`;

const COLOR = `<div class="palette" id="palette"></div><div class="tblwrap"><table class="contrast" id="contrast"><caption class="sr">contrast</caption><thead><tr><th scope="col">${t('thPair')}</th><th scope="col">${t('thRatio')}</th><th scope="col">${t('thNeed')}</th><th scope="col"></th></tr></thead><tbody></tbody></table></div>`;
const TYPE = `<div class="typescale"><p class="ts-d disp">${t('typeDisplay')}</p><p class="ts-t">${t('typeTitle')}</p><p class="ts-b">${t('typeBody')}</p><p class="ts-n num" dir="ltr">PH-2611-0482 · 14:32 · 412 MB · 1,250</p><p class="ts-c">${t('typeCaption')}</p><p class="ts-fonts" id="fontnames"></p></div>`;

// ── الأنماط ─────────────────────────────────────────────────────────────────
const CSS = `
/* التخطيط: شريط تحكم ملتصق، ثم الشاشات الأربع صفًّا يلتفّ، ثم المتجر والأيقونة، ثم اللون والخط. */
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:400 15px/1.6 var(--f-text);padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:0 64px;transition:background .3s,color .3s}
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);z-index:10;background:var(--bg)}
.num{font-family:var(--f-num);font-variant-numeric:tabular-nums;unicode-bidi:isolate}
.disp{font-family:var(--f-display);font-weight:800}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--text2)} .small{font-size:13px}
.ic{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
button{font:inherit;color:inherit;cursor:pointer}
:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
.wrap{max-width:1400px;margin-inline:auto}
:root[lang="ar"] q{quotes:"«" "»"}
.top{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--bg);padding-block:14px 12px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:space-between}
.brandmark{display:flex;align-items:center;gap:12px}
.brandmark .logo{inline-size:84px;block-size:35px;background:var(--text);-webkit-mask:url("${LOGO}") center/contain no-repeat;mask:url("${LOGO}") center/contain no-repeat}
.brandmark h1{font:800 18px/1.2 var(--f-display);margin:0}
.ctrls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.seg-c{display:inline-flex;border:1px solid var(--edge);border-radius:999px;overflow:hidden}
.seg-c button{border:0;background:transparent;padding:7px 14px;font-size:14px;min-height:36px}
.seg-c button[aria-pressed="true"]{background:var(--text);color:var(--bg)}
.tabs{display:flex;gap:6px;margin-block:22px 6px;flex-wrap:wrap}
.tabs button{border:1px solid var(--edge);background:transparent;border-radius:999px;padding:8px 18px 8px 14px;min-height:44px;display:flex;gap:10px;align-items:center;font-weight:600}
.tabs button[aria-selected="true"]{background:var(--brand);color:var(--brand-ink);border-color:var(--brand)}
.tabs .lt{font:700 12px var(--f-num);opacity:.75}
.lede{max-width:68ch;color:var(--text2);margin:6px 0 0}
.blurb{max-width:68ch;margin:10px 0 0;font-size:16px}
h2.sec{font:800 20px/1.3 var(--f-display);margin:40px 0 16px;text-wrap:balance}
.phones{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:28px 18px;align-items:start}
.phone-wrap{margin:0;min-width:0}
.phone-wrap figcaption{font-size:13px;color:var(--text2);margin-bottom:8px;font-weight:600}
.phone{inline-size:min(375px,100%);margin-inline:auto;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-phone);overflow:hidden;box-shadow:var(--sh-phone);position:relative}
.statusbar{display:flex;justify-content:space-between;align-items:center;padding:12px 22px 4px;font-size:13px}
.sb-r{display:flex;gap:3px;align-items:flex-end}.sb-r i{width:4px;background:var(--text);border-radius:1px}.sb-r i:nth-child(1){height:6px}.sb-r i:nth-child(2){height:9px}.sb-r i:nth-child(3){height:12px}
.bar{display:flex;align-items:center;gap:8px;padding:6px 14px 10px}
.bar h3{flex:1;margin:0;font:700 17px/1.3 var(--f-text);text-align:center}
.bar h3.disp{text-align:start;font:800 26px/1.2 var(--f-display);padding-inline-start:4px}
.bar-s{inline-size:44px}
.iconbtn{inline-size:44px;block-size:44px;border-radius:50%;border:0;background:var(--sunken);display:grid;place-items:center}
.screen{padding:4px 16px 20px;display:flex;flex-direction:column;gap:16px}
.screen.center{align-items:center;text-align:center}
.picked{display:flex;gap:8px;align-items:stretch}
.pk{inline-size:64px;block-size:84px;border-radius:var(--r-sm);position:relative;flex:none}
.pk-meta{display:flex;flex-direction:column;justify-content:center;gap:2px;padding-inline-start:4px;font-size:13px;color:var(--text2);min-width:0}
.pk-meta b{color:var(--text);font-size:15px}
.dur{position:absolute;inset-block-end:5px;inset-inline-end:5px;background:rgba(0,0,0,.62);color:#fff;font-size:11px;padding:1px 6px;border-radius:6px}
.fld{display:flex;flex-direction:column;gap:7px}
.lbl{font-size:13px;font-weight:600;color:var(--text2)}
.input{display:flex;gap:8px;align-items:flex-end;border:var(--b-field) solid var(--edge);background:var(--raised);border-radius:var(--r-md);padding:11px 12px;font-size:16px;font-weight:500;min-height:48px}
.input .tv{flex:1;min-width:0;overflow-wrap:anywhere;unicode-bidi:plaintext}
.count{font-size:11px;color:var(--text2);flex:none}
.seg,.filters,.yn{display:flex;flex-wrap:wrap;gap:7px}
.chip{border:1px solid var(--edge);border-radius:var(--r-chip);padding:7px 13px;font-size:14px;min-height:36px;display:inline-flex;align-items:center;background:var(--raised)}
.chip.on{background:var(--brand-soft);border-color:var(--brand);color:var(--brand);font-weight:700}
.tags{display:flex;flex-wrap:wrap;gap:7px;border:var(--b-field) solid var(--edge);border-radius:var(--r-md);padding:8px;background:var(--raised)}
.tag{display:inline-flex;gap:6px;align-items:center;background:var(--sunken);border-radius:var(--r-chip);padding:5px 10px;font-size:14px;max-width:100%;overflow-wrap:anywhere;unicode-bidi:plaintext}
.tag i{font-style:normal;color:var(--text2)}
.tag.ghost{background:transparent;border:1px dashed var(--edge)}
.tag-add{display:inline-flex;gap:4px;align-items:center;color:var(--text2);font-size:14px;padding-inline:6px}
.tag-add .ic{width:16px;height:16px}
.suggest{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text2)}
.row2{display:flex;gap:10px;align-items:stretch}
.place{flex:1;min-width:0;display:flex;gap:9px;align-items:center;background:var(--sunken);border-radius:var(--r-md);padding:9px 11px}
.place b{display:block;font-size:14px}.place small{color:var(--text2);font-size:12px}
.urgent{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;inline-size:84px;border:var(--b-field) solid var(--urgent);color:var(--urgent);background:transparent;border-radius:var(--r-md);font-weight:700;font-size:14px}
.sens{border-radius:var(--r-md);background:var(--gold-soft);padding:11px 12px;display:flex;flex-direction:column;gap:9px}
.sens p{margin:0;display:flex;gap:8px;align-items:flex-start;font-weight:600;font-size:14px;color:var(--text)}
.sens .chip{min-width:72px;justify-content:center}
.cta{border:0;border-radius:var(--r-cta);background:var(--cta-bg);color:var(--brand-ink);font-weight:700;font-size:17px;min-height:54px;padding:0 22px;inline-size:100%;box-shadow:var(--sh-cta)}
.cta.ghost{background:transparent;color:var(--text);border:var(--b-field) solid var(--edge);box-shadow:none}
.cta.solid{background:var(--cta-solid)}
.cta.small{min-height:44px;font-size:15px;inline-size:auto}
.rings{position:relative;inline-size:220px;block-size:220px;margin-block:6px}
.rings svg{inline-size:100%;block-size:100%;overflow:visible}
.ring{fill:none;stroke:var(--brand);stroke-width:var(--ring-w)}
.r1{opacity:.55}.r2{opacity:.32}.r3{opacity:.16}
.track{fill:none;stroke:var(--sunken);stroke-width:10}
.arc{fill:none;stroke:var(--arc);stroke-width:10;stroke-linecap:round;transform:rotate(-90deg);transform-origin:100px 100px}
.rings-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:13px;color:var(--text2)}
.rings-c b{font-size:30px;color:var(--text);font-weight:700;line-height:1}
.reassure{display:flex;gap:8px;align-items:flex-start;text-align:start;margin:0;background:var(--sunken);border-radius:var(--r-md);padding:10px 12px;font-size:14px}
.reassure .ic{color:var(--ok)}
.ulist{list-style:none;margin:0;padding:0;inline-size:100%;display:flex;flex-direction:column;gap:8px}
.ulist li{display:grid;grid-template-columns:40px 1fr auto;grid-template-areas:"t n s" "t b b";gap:2px 10px;align-items:center;text-align:start;background:var(--raised);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px}
.ut{grid-area:t;inline-size:40px;block-size:40px;border-radius:8px}
.un{grid-area:n;font-size:14px;font-weight:600}
.us{grid-area:s;display:inline-flex;gap:4px;align-items:center;font-size:13px;font-weight:600}
.us .ic{width:16px;height:16px}
.us.ok{color:var(--ok)}.us.run{color:var(--brand)}.us.wait{color:var(--warn)}
.ubar{grid-area:b;block-size:4px;background:var(--sunken);border-radius:4px;overflow:hidden}
.ubar i{display:block;block-size:100%;background:var(--arc)}
.receipt{gap:12px;padding-block:24px}
.rc-mark{position:relative;inline-size:170px;block-size:170px}
.rc-mark>svg:first-child{inline-size:100%;block-size:100%;overflow:visible}
.done{fill:var(--cta-solid)}
.rc-check{position:absolute;inset:0;margin:auto;width:46px;height:46px;color:var(--brand-ink);stroke-width:2.6}
.receipt h2{font-size:30px;margin:4px 0 0}
.receipt p{margin:0;max-width:30ch;overflow-wrap:anywhere}
.receipt q{color:var(--text);font-weight:600;unicode-bidi:plaintext}
.slip{inline-size:100%;margin:8px 0;background:var(--raised);border:1px var(--slip-border) var(--edge);border-radius:var(--r-md);padding:4px 14px;text-align:start}
.slip div{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
.slip div:last-child{border-bottom:0}
.slip dt{color:var(--text2);font-size:13px}.slip dd{margin:0;font-weight:600}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px;inline-size:100%}
.two .cta{font-size:15px;padding:0 10px}
.group{display:flex;flex-direction:column;gap:4px}
.group h4{margin:0;font:700 16px/1.4 var(--f-text);overflow-wrap:anywhere;unicode-bidi:plaintext}
.group small{color:var(--text2);font-size:12px;margin-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.mcard{display:flex;flex-direction:column;gap:6px;min-width:0}
.mthumb{aspect-ratio:9/16;border-radius:var(--r-sm);position:relative;max-width:100%}
.kind{position:absolute;inset-block-start:5px;inset-inline-start:5px;color:#fff;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
.kind .ic{width:16px;height:16px}
.pill-urgent{position:absolute;inset-block-start:5px;inset-inline-end:5px;background:var(--urgent);color:#fff;font-size:10px;font-weight:700;border-radius:999px;padding:1px 6px 1px 5px;display:flex;gap:2px;align-items:center}
.pill-urgent .ic{width:11px;height:11px;stroke-width:2.4}
.mstates{display:flex;flex-direction:column;gap:3px}
.st{display:flex;gap:4px;align-items:center;font-size:11px;font-weight:600;line-height:1.3;min-width:0}
.st .ic{width:13px;height:13px}
.st-ok{color:var(--ok)}.st-warn{color:var(--warn)}.st-mute{color:var(--text2)}.st-brand{color:var(--brand)}
.th1{background:radial-gradient(120% 80% at 70% 20%,#e9c46a 0,#b07a2a 22%,transparent 50%),linear-gradient(170deg,#2a4b55 0,#11262d 60%,#0a171c 100%)}
.th2{background:radial-gradient(90% 60% at 30% 70%,#58a7b3 0,transparent 55%),linear-gradient(200deg,#3a3f46 0,#1d2228 70%)}
.th3{background:radial-gradient(70% 45% at 50% 35%,#f2efe6 0,#c9c2b0 30%,transparent 62%),linear-gradient(180deg,#7d8a8f 0,#3b4448 100%)}
.th4{background:radial-gradient(100% 70% at 40% 80%,#2f6f82 0,transparent 60%),linear-gradient(160deg,#9aa8ad 0,#4f5d63 55%,#263035 100%)}
.th5{background:radial-gradient(80% 60% at 60% 30%,#d0a030 0,transparent 55%),linear-gradient(190deg,#593f22 0,#22180f 100%)}
.store-row{display:grid;grid-template-columns:minmax(0,640px) minmax(0,1fr);gap:24px;align-items:start}
.store{display:grid;grid-template-columns:minmax(0,220px) 1fr;gap:20px;background:#0B141B;color:#EEF3F5;border-radius:var(--r-lg);padding:16px;outline-offset:3px}
.store .muted{color:#9FB2BA}
.sv{position:relative;aspect-ratio:9/16;border-radius:var(--r-sm);overflow:hidden;background:#06222b}
.sv video{inline-size:100%;block-size:100%;object-fit:cover;display:block}
.wm{position:absolute;inset:0;margin:auto;inline-size:62%;opacity:.42;pointer-events:none}
.pv{position:absolute;inset-block-start:8px;inset-inline-start:8px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}
.play{position:absolute;inset:0;margin:auto;inline-size:52px;block-size:52px;border-radius:50%;background:rgba(0,0,0,.45);display:grid;place-items:center;color:#fff;transition:opacity .2s}
.play .ic{fill:#fff;stroke:none;width:22px;height:22px}
.store.playing .play{opacity:0}
.sb{display:flex;flex-direction:column;gap:10px;justify-content:flex-end;min-width:0}
.sb h4{margin:0;font-size:24px;line-height:1.25;text-wrap:balance}
.sb p{margin:0;color:#B7C6CC;display:flex;gap:6px;flex-wrap:wrap}
.store .cta{background:${'#D0A030'};color:#14110A;box-shadow:none}
.icons{margin:0;display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap}
.icons figcaption{font-size:13px;color:var(--text2);flex-basis:100%}
.appicon{inline-size:120px;block-size:120px;border-radius:27%;background:var(--icon-bg);display:grid;place-items:center;box-shadow:var(--sh-cta)}
.appicon.sm{inline-size:58px;block-size:58px}
.appicon svg{inline-size:78%;block-size:78%}
.appicon circle{fill:none;stroke:var(--icon-fg);stroke-width:var(--icon-w)}
.appicon circle:nth-child(1){opacity:.35}.appicon circle:nth-child(2){opacity:.6}
.appicon .core{fill:var(--icon-core);stroke:none}
.palette{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.sw{border-radius:var(--r-md);overflow:hidden;border:1px solid var(--line);background:var(--raised);font-size:12px}
.sw .c{display:flex;block-size:54px}.sw .c span{flex:1}
.sw p{margin:0;padding:7px 9px;display:flex;justify-content:space-between;gap:6px}
.sw p b{font-weight:600}
.tblwrap{overflow-x:auto;margin-top:16px;border:1px solid var(--line);border-radius:var(--r-md)}
.contrast{border-collapse:collapse;inline-size:100%;font-size:13px;min-width:520px}
.contrast th,.contrast td{padding:7px 12px;border-bottom:1px solid var(--line);text-align:start}
.contrast td.n{text-align:right;font-family:var(--f-num)}
.contrast th{color:var(--text2);font-weight:600;background:var(--sunken)}
.contrast .chipx{display:inline-block;inline-size:18px;block-size:18px;border-radius:4px;vertical-align:middle;margin-inline-end:8px;border:1px solid var(--line)}
.ok-t{color:var(--ok);font-weight:700}.bad-t{color:var(--urgent);font-weight:700}
.typescale{display:flex;flex-direction:column;gap:10px;max-width:72ch}
.typescale p{margin:0}
.ts-d{font-size:clamp(34px,6vw,52px);line-height:1.1}
.ts-t{font:700 24px/1.35 var(--f-display)}
.ts-b{font-size:17px;line-height:1.75;color:var(--text)}
.ts-n{font-size:15px;color:var(--text2)}
.ts-c{font-size:13px;color:var(--text2)}
.ts-fonts{font-size:13px;color:var(--text2);border-top:1px solid var(--line);padding-top:10px}
@media (max-width:760px){.store-row{grid-template-columns:1fr}.store{grid-template-columns:1fr}.sv{max-inline-size:240px}}

/* ── أ «بثّ»: توهّج ودوائر تنبض ── */
:root[data-d="a"]{--r-phone:38px;--r-lg:20px;--r-md:14px;--r-sm:10px;--r-chip:999px;--r-cta:999px;--b-field:1px;--ring-w:1.5;--slip-border:solid;--arc:var(--brand);--cta-bg:var(--brand);--cta-solid:var(--brand);--sh-phone:0 30px 80px -30px rgba(0,0,0,.6);--sh-cta:0 10px 30px -10px var(--brand);--icon-bg:radial-gradient(circle at 50% 45%,#0f3a46,#05141b 70%);--icon-fg:#3CCFDB;--icon-core:#E4B543;--icon-w:5}
:root[data-d="a"][data-mode="light"]{--sh-phone:0 24px 60px -30px rgba(8,32,42,.35);--sh-cta:0 8px 22px -12px var(--brand)}
:root[data-d="a"] .r1{animation:pulse 2.4s ease-out infinite}:root[data-d="a"] .r2{animation:pulse 2.4s .4s ease-out infinite}:root[data-d="a"] .r3{animation:pulse 2.4s .8s ease-out infinite}
:root[data-d="a"] .rings svg{filter:drop-shadow(0 0 14px var(--brand-soft))}
@keyframes pulse{0%{opacity:.7;transform:scale(.9)}100%{opacity:0;transform:scale(1.08)}}
.ring{transform-origin:100px 100px}

/* ── ب «ميدان»: حبر ونقاط وأختام ── */
:root[data-d="b"]{--r-phone:22px;--r-lg:8px;--r-md:6px;--r-sm:4px;--r-chip:4px;--r-cta:6px;--b-field:2px;--ring-w:3;--slip-border:dashed;--arc:var(--brand);--cta-bg:var(--brand);--cta-solid:var(--brand);--sh-phone:6px 6px 0 var(--edge);--sh-cta:3px 3px 0 var(--text);--icon-bg:#0D6870;--icon-fg:#F8F9F5;--icon-core:#F1D27A;--icon-w:6}
:root[data-d="b"] body{background-image:radial-gradient(var(--line) 1.1px,transparent 1.3px);background-size:14px 14px}
:root[data-d="b"] .phone{border:2px solid var(--edge)}
:root[data-d="b"] .ring{stroke-dasharray:2 7;stroke-linecap:round}
:root[data-d="b"] .rings svg{animation:spin 40s linear infinite}
:root[data-d="b"] .chip.on{background:var(--text);color:var(--bg);border-color:var(--text)}
:root[data-d="b"] .lbl{text-transform:none;letter-spacing:.02em;color:var(--text)}
:root[data-d="b"] .tabs button[aria-selected="true"]{box-shadow:3px 3px 0 var(--text)}
:root[data-d="b"] .disp{letter-spacing:-.01em}
:root[data-d="b"] .sens{border:2px solid var(--text);background:var(--gold-soft)}
:root[data-d="b"] .store{border-radius:8px}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── ج «إشارة»: زجاج وخط رفيع وتدرّج ── */
:root[data-d="c"]{--r-phone:44px;--r-lg:28px;--r-md:18px;--r-sm:14px;--r-chip:12px;--r-cta:18px;--b-field:1.5px;--ring-w:1.4;--slip-border:solid;--cta-bg:linear-gradient(120deg,var(--brand),var(--brand2));--cta-solid:var(--brand);--sh-phone:0 1px 0 var(--line),0 40px 90px -40px rgba(13,21,36,.35);--sh-cta:0 12px 30px -14px var(--brand2);--icon-bg:linear-gradient(140deg,#0A7987,#2E56E8);--icon-fg:#FFFFFF;--icon-core:#FFFFFF;--icon-w:2.5}
:root[data-d="c"]{--arc:var(--brand)}
:root[data-d="c"] .phone{background:linear-gradient(180deg,var(--raised),var(--bg) 40%)}
:root[data-d="c"] .ulist li,:root[data-d="c"] .slip{background:color-mix(in srgb,var(--raised) 70%,transparent);backdrop-filter:blur(12px);box-shadow:0 1px 2px rgba(13,21,36,.06)}
:root[data-d="c"] .ring{stroke-dasharray:none}
:root[data-d="c"] .r1{opacity:.9}:root[data-d="c"] .r2{opacity:.5}:root[data-d="c"] .r3{opacity:.25}
:root[data-d="c"] .arc{stroke-width:6}:root[data-d="c"] .track{stroke-width:6}
:root[data-d="c"] .chip.on{background:var(--text);color:var(--bg);border-color:var(--text)}
:root[data-d="c"] .sens{background:var(--gold-soft);border:1.5px solid var(--warn)}
/* المعتمد 2026-11-01: الدوائر تنبض أثناء الرفع، والتدرّج في الزر الرئيسي والأيقونة وحدهما، وحدود أوضح للشمس */
:root[data-d="c"] .rings .r1{animation:pulse 2.4s ease-out infinite}:root[data-d="c"] .rings .r2{animation:pulse 2.4s .4s ease-out infinite}:root[data-d="c"] .rings .r3{animation:pulse 2.4s .8s ease-out infinite}

@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
`;

// ── السلوك: اللغة والوضع والتبويب واختبار الضغط وجدول التباين ────────────────
const JS = (ids, pairs) => `
const T=${JSON.stringify(T)},S=${JSON.stringify(STRESS)},IDS=${JSON.stringify(ids)},HOME=${JSON.stringify(Object.fromEntries(ids.map((d) => [d, DIRS[d].home])))};
const PAL=${JSON.stringify(Object.fromEntries(ids.map((d) => [d, { light: DIRS[d].light, dark: DIRS[d].dark, fonts: DIRS[d].fonts }])))};
const PAIRS=${JSON.stringify(pairs)};
const q=new URLSearchParams(location.search),root=document.documentElement;
const store={get(k){try{return localStorage.getItem('pm-'+k)}catch{return null}},set(k,v){try{localStorage.setItem('pm-'+k,v)}catch{}}};
const st={d:q.get('d')||store.get('d')||IDS[0],lang:q.get('lang')||store.get('lang')||'ar',mode:q.get('mode')||null,stress:q.get('stress')==='1'};
if(!IDS.includes(st.d))st.d=IDS[0];
function L(i){return st.lang==='en'?1:0}
function lum(h){h=h.replace('#','');const c=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]}
function ratio(a,b){const[x,y]=[lum(a),lum(b)].sort((p,r)=>r-p);return(x+.05)/(y+.05)}
function render(){
  const mode=st.mode||HOME[st.d];const li=L();
  root.dataset.d=st.d;root.dataset.mode=mode;root.lang=st.lang;root.dir=st.lang==='en'?'ltr':'rtl';
  document.querySelectorAll('[data-i]').forEach(el=>{const k=el.dataset.i;if(T[k])el.textContent=T[k][li]});
  document.querySelectorAll('[data-stress="title"]').forEach(el=>{el.textContent=st.stress?S.title[li]:T.titleVal[li]});
  const cnt=document.querySelector('[data-count]');if(cnt)cnt.textContent=[...(st.stress?S.title[li]:T.titleVal[li])].length+'/80';
  const tags=document.querySelector('[data-tags]');if(tags){const list=st.stress?S.tags[li]:[T.tag1[li],T.tag2[li],T.tag3[li]];tags.innerHTML=list.map(x=>'<span class="tag">'+x.replace(/</g,'&lt;')+'<i>×</i></span>').join('')+'<span class="tag-add">+ '+T.addTag[li]+'</span>'}
  document.querySelectorAll('.tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.d===st.d)));
  document.querySelectorAll('[data-mode-btn]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.modeBtn===mode)));
  document.querySelectorAll('[data-lang-btn]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.langBtn===st.lang)));
  const sb=document.getElementById('stress');if(sb)sb.setAttribute('aria-pressed',String(st.stress));
  const bl=document.getElementById('blurb');if(bl)bl.textContent=T[st.d+'Blurb'][li];
  const nm=document.querySelector('.icons figcaption b');if(nm)nm.textContent=T[st.d][li];
  const p=PAL[st.d][mode];
  const groups=[['bg','raised','sunken','line'],['text','text2','edge'],['brand','brand2','brandSoft','brandInk'],['gold','goldSoft'],['urgent','ok','warn']];
  document.getElementById('palette').innerHTML=groups.map(g=>'<div class="sw"><div class="c">'+g.map(k=>'<span style="background:'+p[k]+'"></span>').join('')+'</div>'+g.map(k=>'<p><b>'+k+'</b><span class="num" dir="ltr">'+p[k]+'</span></p>').join('')+'</div>').join('');
  const need={text:4.5,large:3,ui:3};
  document.querySelector('#contrast tbody').innerHTML=PAIRS.filter(x=>x.d===st.d&&x.mode===mode).map(x=>{const r=ratio(x.fg,x['bg']),ok=r>=need[x.role];return '<tr><td><span class="chipx" style="background:'+x['bg']+';box-shadow:inset 0 0 0 5px '+x['bg']+',inset 0 0 0 9px '+x.fg+'"></span><span dir="ltr">'+x.name.split(' ').slice(1).join(' ')+'</span></td><td class="n">'+r.toFixed(2)+'</td><td class="n">'+need[x.role]+'</td><td class="'+(ok?'ok-t':'bad-t')+'">'+(ok?T.pass[li]:T.fail[li])+'</td></tr>'}).join('');
  const f=PAL[st.d].fonts;document.getElementById('fontnames').textContent=[f.display,f.text,f.num].map(s=>s.split(',')[0].replace(/'/g,'')).join(' · ');
  store.set('d',st.d);store.set('lang',st.lang);
}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.d){st.d=b.dataset.d;st.mode=null}else if(b.dataset.modeBtn){st.mode=b.dataset.modeBtn}else if(b.dataset.langBtn){st.lang=b.dataset.langBtn}else if(b['id']==='stress'){st.stress=!st.stress}else return;render()});
const card=document.querySelector('.store'),vid=card&&card.querySelector('video');
if(vid){const on=()=>{vid.play().catch(()=>{});card.classList.add('playing')},off=()=>{vid.pause();card.classList.remove('playing')};
  card.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')on()});card.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')off()});
  card.addEventListener('focus',on);card.addEventListener('blur',off);card.addEventListener('click',()=>card.classList.contains('playing')?off():on())}
render();
`;

function page(ids) {
  const pairs = pairsFor(ids);
  const fontsHref = 'https://fonts.googleapis.com/css2?family=Alexandria:wght@700;800&family=Baloo+Bhaijaan+2:wght@600;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&family=Noto+Kufi+Arabic:wght@400;500;600;700&family=Readex+Pro:wght@300..700&family=Rubik:wght@500;700;800&display=swap';
  const tabs = ids.length > 1 ? `<nav class="tabs" role="tablist">${ids.map((d) => `<button role="tab" data-d="${d}" aria-selected="false"><span class="lt">${d.toUpperCase()}</span>${t(d)}</button>`).join('')}</nav>` : `<h2 class="sec" style="margin-top:22px">${t(ids[0])}</h2>`;
  return `<title>اتجاهات بوست ميدان</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fontsHref}">
<style>${tokenCss(ids)}${CSS}</style>
<script type="application/json" id="tokens">${JSON.stringify({ pairs })}</script>
<div class="wrap">
<header class="top"><div class="brandmark"><span class="logo" role="img" aria-label="Palestine Post"></span><h1>${t('pageTitle')}</h1></div>
<div class="ctrls"><div class="seg-c"><button data-mode-btn="dark">${t('dark')}</button><button data-mode-btn="light">${t('light')}</button></div>
<div class="seg-c"><button data-lang-btn="ar">عربي</button><button data-lang-btn="en">English</button></div>
<div class="seg-c"><button id="stress" aria-pressed="false">${t('stress')}</button></div></div></header>
<p class="lede">${t('pageLede')}</p>
${tabs}
<p class="blurb" id="blurb"></p>
<h2 class="sec">${t('secScreens')}</h2>
<div class="phones">${SEND}${UPLOAD}${RECEIPT}${GALLERY}</div>
<h2 class="sec">${t('secStore')}</h2>${STORE}
<h2 class="sec">${t('secColor')}</h2>${COLOR}
<h2 class="sec">${t('secType')}</h2>${TYPE}
</div>
<script>${JS(ids, pairs)}</script>`;
}

for (const d of ['a', 'b', 'c']) writeFileSync(join(OUT, `${d}.html`), page([d]));
writeFileSync(join(OUT, 'index.html'), page(['c', 'a', 'b'])); // المعتمد أولًا
console.log('built a.html b.html c.html index.html');
