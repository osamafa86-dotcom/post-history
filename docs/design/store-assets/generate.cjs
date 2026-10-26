/* Store asset generator — app icon, feature graphic and screenshots for both stores.
 * Every screen shows SYNTHETIC data only (no real material, no location, no identifiers).
 * Run: node docs/design/store-assets/generate.cjs   (needs playwright + chromium; outputs go to apps/ios/store and apps/android/store)
 */
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/design/tokens.json"), "utf8"));
const prim = (ref) => { const m = /\{color\.primitive\.(\w+)\.(\w+)\}/.exec(ref); return tokens.color.primitive[m[1]][m[2]].$value; };
const css = (mode) => Object.entries(tokens.color.semantic).map(([k, v]) => `--c-${k.replace(/\//g, "-")}:${prim(v.$value[mode])};`).join("");
const L = {
  ar: { dir: "rtl", font: "'Noto Sans Arabic'", brand: "المكتبة المرئية", org: "فلسطين بوست", synthetic: "بيانات اصطناعية — للعرض فقط",
    shots: [
      { h: "أرسل الأصل كما صُوِّر", s: "من المعرض مباشرة، دون ضغط ودون إعادة ترميز. النسخة الخفيفة تصل غرفة الأخبار أولًا." },
      { h: "الرفع يستأنف من آخر جزء وصل", s: "انقطعت الشبكة؟ أُغلق التطبيق؟ يكمل من حيث توقف ويخبرك أين وصل." },
      { h: "إيصال استلام برقم", s: "عند تطابق البصمة على الخادم يصلك إيصال تشاركه داخل مؤسستك، بلا موقع ولا أسماء." },
      { h: "ثلاث حالات لكل مادة", s: "فنية، تحريرية، حقوق — كلٌّ على حدة، وخط زمني يقول من فعل ماذا ومتى." },
      { h: "وضع داكن للميدان ليلًا", s: "الواجهة نفسها بألوان مريحة للعين، والعاجل يبقى واضحًا من بعيد." },
    ],
    ui: { newTitle: "مادة جديدة", draft: "حفظ مسودة", step: "الخطوة 2 من 4 · البيانات", file: "IMG_4471.MOV · 1.9 غ.ب · 02:14", fileNote: "الأصل كما صُوِّر، دون ضغط", light: "نسخة خفيفة أولًا: عادي 540p (~45 م.ب)", title: "العنوان القصير", titleV: "لقطات خام من شارع النخيل بعد القصف", titleH: "من 5 إلى 80 حرفًا · 38", type: "نوع المادة *", types: ["لقطات خام", "خبر عاجل", "تقرير", "مقابلة", "صور"], gov: "المحافظة", city: "المدينة", gaza: "غزة", prio: "الأولوية *", prios: ["عاجل", "مهم", "عادي"], sens: "الحساسية — سؤال إلزامي", qs: ["هل تتضمن قاصرين؟", "هل تتضمن مصابين؟", "هل تتضمن مشاهد صادمة؟"], yes: "نعم", no: "لا", next: "التالي: نموذج المكتب",
      upTitle: "الرفع", urgent: "عاجل", lightOk: "تم التحقق", lightMsg: "النسخة الخفيفة وصلت غرفة الأخبار 14:03", pct: "62٪", origUp: "الأصل يُرفع", bytes: "1.18 من 1.9 غ.ب · نحو 6 دقائق على هذه الشبكة", parts: "8 من 12 جزءًا مؤكَّدة من الخادم · الجزء 9 جارٍ", safe: "الانقطاع آمن: يستأنف من آخر جزء وصل، حتى بعد إغلاق التطبيق أو إعادة تشغيل الهاتف.", pause: "إيقاف مؤقت", wifi: "Wi‑Fi فقط", queued: "في الانتظار", q1: "مقابلة مع طبيب في مجمع الأمل الطبي", q1s: "بانتظار الشبكة · 640 م.ب", q2: "تصوير جوي لالميناء القديم", q2s: "تم الاستلام · VL-2026-10-25-0417",
      rcTitle: "تم الاستلام", rcH: "وصل الأصل وتم التحقق منه", rcS: "البصمة على الخادم تطابق بصمة هاتفك. مادتك الآن في الوارد الحي.", receipt: "إيصال استلام", rows: [["المادة", "لقطات خام من شارع النخيل بعد القصف"], ["وقت الاستلام", "26‏/10‏/2026 · 14:11"], ["الحجم", "1.9 غ.ب"], ["المشرف", "اطّلع عليها 14:12 ✓"]], qr: "رمز للمشاركة داخل المؤسسة فقط — لا يحمل موقعًا ولا أسماء", share: "مشاركة الإيصال", copy: "نسخ الرقم", localT: "النسخة المحلية ما زالت على هاتفك", localS: "حذفها قرارك. يُنصح به حين تستدعي السلامة ذلك؛ الأصل محفوظ على خوادم المؤسسة.", del: "حذف النسخة المحلية", keep: "إبقاؤها",
      mine: "موادي", tabs: ["تحتاج إجراء · 1", "الكل · 12"], badges: ["تم التحقق", "تحتاج تعديلًا", "غير موثّقة"], note: "طلب تعديل من المشرف · 14:40", noteS: "«اللقطة عند 00:42 مهتزة، هل لديك بديل؟»", tl: "الخط الزمني — ثلاثة مسارات مستقلة", ev: [["وصلت النسخة الخفيفة", "14:03", "t"], ["وصل الأصل وتم التحقق · VL-…-0481", "14:11", "t"], ["اطّلع عليها المشرف", "14:12", "e"], ["طلب تعديل (لقطة 00:42)", "14:40", "e"], ["الحقوق: بانتظار توثيق العقد", "—", "r"]], alt: "رفع لقطة بديلة", reply: "الرد على المشرف", m2: "مقابلة مع طبيب في مجمع الأمل الطبي", m2b: ["جارٍ الرفع", "واردة", "غير موثّقة"], m3: "تصوير جوي لالميناء القديم", m3b: ["تم التحقق", "مقبولة", "موثّقة"] } },
  "en-US": { dir: "ltr", font: "Inter", brand: "Visual Library", org: "Palestine Post", synthetic: "Synthetic data — for display only",
    shots: [
      { h: "Send the original as shot", s: "Straight from the gallery, no compression, no re-encoding. The light copy reaches the newsroom first." },
      { h: "Uploads resume from the last chunk", s: "Network dropped? App closed? It continues where it stopped and tells you how far it got." },
      { h: "A numbered receipt", s: "When the checksum matches on the server you get a receipt to share inside your organisation — no location, no names." },
      { h: "Three states for every material", s: "Technical, editorial, rights — each on its own, with a timeline of who did what and when." },
      { h: "Dark mode for night work", s: "The same interface in easy-on-the-eyes colours; urgent stays visible from afar." },
    ],
    ui: { newTitle: "New material", draft: "Save draft", step: "Step 2 of 4 · Details", file: "IMG_4471.MOV · 1.9 GB · 02:14", fileNote: "Original as shot, no compression", light: "Light copy first: Normal 540p (~45 MB)", title: "Short title", titleV: "Raw footage from Palm street after the strike", titleH: "5 to 80 characters · 38", type: "Material type *", types: ["Raw footage", "Breaking", "Report", "Interview", "Photos"], gov: "Governorate", city: "City", gaza: "Gaza", prio: "Priority *", prios: ["Urgent", "Important", "Normal"], sens: "Sensitivity — required", qs: ["Includes minors?", "Includes injured people?", "Includes graphic scenes?"], yes: "Yes", no: "No", next: "Next: desk form",
      upTitle: "Upload", urgent: "Urgent", lightOk: "Verified", lightMsg: "Light copy reached the newsroom 14:03", pct: "62%", origUp: "Original uploading", bytes: "1.18 of 1.9 GB · about 6 min on this network", parts: "8 of 12 chunks confirmed by the server · chunk 9 in progress", safe: "Interruptions are safe: resumes from the last confirmed chunk, even after closing the app or restarting the phone.", pause: "Pause", wifi: "Wi‑Fi only", queued: "QUEUED", q1: "Interview with a doctor at Al-Amal medical complex", q1s: "Waiting for network · 640 MB", q2: "Aerial footage of the old harbour", q2s: "Received · VL-2026-10-25-0417",
      rcTitle: "Received", rcH: "Original received and verified", rcS: "The server checksum matches your phone's. Your material is now in the live inbox.", receipt: "RECEIPT", rows: [["Material", "Raw footage from Palm street after the strike"], ["Received at", "26 Oct 2026 · 14:11"], ["Size", "1.9 GB"], ["Supervisor", "Acknowledged 14:12 ✓"]], qr: "Share code for inside the organisation only — carries no location or names", share: "Share receipt", copy: "Copy number", localT: "The local copy is still on your phone", localS: "Deleting it is your call. Recommended when safety requires it; the original is stored on the organisation's servers.", del: "Delete local copy", keep: "Keep it",
      mine: "My materials", tabs: ["Needs action · 1", "All · 12"], badges: ["Verified", "Needs changes", "Undocumented"], note: "Supervisor requested changes · 14:40", noteS: "“The shot at 00:42 is shaky, do you have an alternative?”", tl: "TIMELINE — THREE INDEPENDENT TRACKS", ev: [["Light copy received", "14:03", "t"], ["Original received and verified · VL-…-0481", "14:11", "t"], ["Acknowledged by supervisor", "14:12", "e"], ["Changes requested (shot 00:42)", "14:40", "e"], ["Rights: awaiting contract documentation", "—", "r"]], alt: "Upload alternative shot", reply: "Reply to supervisor", m2: "Interview with a doctor at Al-Amal medical complex", m2b: ["Uploading", "Inbox", "Undocumented"], m3: "Aerial footage of the old harbour", m3b: ["Verified", "Accepted", "Documented"] } },
};
const I = { film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>', pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M13 7l3 3"/></svg>', scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M4 20h16M6 8l6-2 6 2"/><path d="M3 14l3-6 3 6a3 3 0 01-6 0zM15 14l3-6 3 6a3 3 0 01-6 0z"/></svg>', check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>', shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>', alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4M12 17.5v.5"/></svg>', bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0112 0v5l2 2H4l2-2z"/><path d="M10 20a2 2 0 004 0"/></svg>', receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/></svg>', lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>', chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>', upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/></svg>' };
const ic = (n, s = 18) => `<span class="ic" style="width:${s}px;height:${s}px">${I[n]}</span>`;
const BASE_CSS = `
*{box-sizing:border-box;margin:0}html,body{height:100%}
body{font-family:var(--font),system-ui,sans-serif;color:var(--c-text-primary);background:var(--c-bg-canvas);-webkit-font-smoothing:antialiased}
.ic{display:inline-flex;align-items:center;justify-content:center;flex:none}.ic svg{width:100%;height:100%}
.screen{width:390px;min-height:844px;color:var(--c-text-primary);background:var(--c-bg-canvas);display:flex;flex-direction:column;position:relative;overflow:hidden}
.sb{display:flex;justify-content:space-between;padding:14px 24px 6px;font:500 14px Inter}.sb b{font-weight:600}
.tb{display:flex;justify-content:space-between;align-items:center;padding:8px 16px}.tb h1{font-size:20px;font-weight:600;display:flex;align-items:center;gap:8px}
.content{padding:8px 16px 24px;display:flex;flex-direction:column;gap:14px}
.card{background:var(--c-bg-surface);border:1px solid var(--c-border-default);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border-radius:8px;font-weight:500;font-size:16px;border:1px solid transparent}
.btn.p{background:var(--c-bg-brand);color:var(--c-text-on-brand)}.btn.s{background:var(--c-bg-surface);border-color:var(--c-border-strong);color:var(--c-text-primary)}.btn.g{color:var(--c-text-brand)}.btn.full{width:100%}
.badge{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:500;border:1px solid}
.b-good{background:var(--c-tone-good-bg);color:var(--c-tone-good-fg);border-color:var(--c-tone-good-border)}.b-att{background:var(--c-tone-attention-bg);color:var(--c-tone-attention-fg);border-color:var(--c-tone-attention-border)}.b-neu{background:var(--c-tone-neutral-bg);color:var(--c-tone-neutral-fg);border-color:var(--c-tone-neutral-border)}.b-prog{background:var(--c-tone-progress-bg);color:var(--c-tone-progress-fg);border-color:var(--c-tone-progress-border)}.b-urg{background:var(--c-tone-urgent-bg);color:var(--c-tone-urgent-fg);border-color:var(--c-tone-urgent-border);font-weight:600;font-size:14px}
.muted{color:var(--c-text-muted)}.sec{color:var(--c-text-secondary)}.brand{color:var(--c-text-brand)}.sm{font-size:14px;line-height:1.55}.xs{font-size:12px;line-height:1.5}.lbl{font-size:14px;font-weight:500}.h4{font-size:18px;font-weight:600;line-height:1.5}.h2{font-size:24px;font-weight:700;line-height:1.4}
.mono{font-family:'IBM Plex Mono',monospace;direction:ltr;unicode-bidi:isolate;white-space:nowrap}
.row>*{min-width:0}.row .lbl,.row .sm{overflow-wrap:anywhere}
.field{display:flex;flex-direction:column;gap:4px}.field .ctl{height:44px;border:1px solid var(--c-border-strong);border-radius:8px;background:var(--c-bg-surface);padding:0 12px;display:flex;align-items:center;justify-content:space-between;font-size:16px}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{padding:6px 12px;border-radius:999px;border:1px solid var(--c-border-strong);background:var(--c-bg-surface);color:var(--c-text-primary);font-size:14px;font-weight:500;display:inline-flex;gap:6px;align-items:center}.chip.on{background:var(--c-bg-brand-subtle);border-color:var(--c-border-brand);color:var(--c-text-brand)}
.seg{display:flex}.seg span{flex:1;height:44px;display:flex;align-items:center;justify-content:center;border:1px solid var(--c-border-strong);background:var(--c-bg-surface);font-size:14px;font-weight:500}.seg span:first-child{border-radius:0 8px 8px 0}.seg span:last-child{border-radius:8px 0 0 8px}[dir=ltr] .seg span:first-child{border-radius:8px 0 0 8px}[dir=ltr] .seg span:last-child{border-radius:0 8px 8px 0}
.seg span.urg{background:var(--c-tone-urgent-bg);color:var(--c-tone-urgent-fg);border:2px solid var(--c-tone-urgent-border)}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.bar{height:10px;border-radius:5px;background:var(--c-bg-subtle);overflow:hidden}.bar i{display:block;height:100%;width:62%;background:var(--c-bg-brand);border-radius:5px}
.parts{display:flex;gap:3px}.parts i{flex:1;height:6px;border-radius:2px;background:var(--c-border-default)}.parts i.ok{background:var(--c-bg-brand)}.parts i.cur{background:var(--c-tone-progress-border)}
.safe{display:flex;gap:8px;align-items:flex-start;background:var(--c-bg-brand-subtle);color:var(--c-text-brand);border-radius:8px;padding:10px 12px}
.stepper{display:flex;gap:6px}.stepper i{flex:1;height:4px;border-radius:2px;background:var(--c-border-default)}.stepper i.on{background:var(--c-bg-brand)}
.ring{width:88px;height:88px;border-radius:50%;background:var(--c-tone-good-bg);border:2px solid var(--c-tone-good-border);color:var(--c-tone-good-fg);display:flex;align-items:center;justify-content:center;margin:0 auto}
.tl{display:flex;flex-direction:column}.ev .mono{display:inline-block}.ev{display:flex;gap:10px;padding:6px 0;align-items:flex-start}.ev .dot{display:flex;flex-direction:column;align-items:center}.ev .dot b{width:12px;height:12px;border-radius:50%}.ev .dot i{width:2px;height:26px}
.t .dot b{background:var(--c-track-technical-accent)}.t .dot i{background:var(--c-track-technical-subtle)}.t .ic{color:var(--c-track-technical-accent)}
.e .dot b{background:var(--c-track-editorial-accent)}.e .dot i{background:var(--c-track-editorial-subtle)}.e .ic{color:var(--c-track-editorial-accent)}
.r .dot b{background:var(--c-track-rights-accent)}.r .dot i{background:var(--c-track-rights-subtle)}.r .ic{color:var(--c-track-rights-accent)}
.note{display:flex;gap:8px;background:var(--c-tone-attention-bg);border-radius:8px;padding:10px 12px}.note .ic{color:var(--c-tone-attention-fg)}
.tabs{display:flex;gap:8px}.tab{padding:8px 14px;border-radius:999px;background:var(--c-bg-subtle);font-size:14px;font-weight:500}.tab.on{background:var(--c-bg-brand);color:var(--c-text-on-brand)}
.qr{width:96px;height:96px;border-radius:8px;background:var(--c-bg-subtle);margin:0 auto;display:grid;grid-template-columns:repeat(7,1fr);gap:3px;padding:10px}.qr i{background:var(--c-text-primary);border-radius:2px}.qr i.o{background:transparent}
`;
const qr = () => { let s = ""; const seed = [1,1,1,0,1,0,1, 1,0,1,0,0,1,1, 1,1,1,0,1,0,1, 0,0,0,1,0,1,0, 1,0,1,1,0,1,1, 1,0,0,0,1,0,1, 1,1,1,0,1,1,1]; for (const v of seed) s += `<i class="${v ? "" : "o"}"></i>`; return `<div class="qr">${s}</div>`; };
const badges3 = (b) => `<div class="chips"><span class="badge ${["b-good","b-att","b-neu"][0]}">${ic("film", 14)}${b[0]}</span><span class="badge b-att">${ic("pen", 14)}${b[1]}</span><span class="badge b-neu">${ic("scale", 14)}${b[2]}</span></div>`;
const badges = (b, cls) => `<div class="chips">${[0,1,2].map(i => `<span class="badge ${cls[i]}">${ic(["film","pen","scale"][i], 14)}${b[i]}</span>`).join("")}</div>`;
const S = {
  1: (u) => `<div class="sb"><b>9:41</b><span>●●●</span></div><div class="tb"><h1>${ic("chev", 22)} ${u.newTitle}</h1><span class="btn g" style="height:36px">${u.draft}</span></div><div class="content">
    <div><div class="stepper"><i class="on"></i><i class="on"></i><i></i><i></i></div><div class="xs muted" style="margin-top:6px">${u.step}</div></div>
    <div class="card"><div class="row"><div><div class="lbl">${u.file}</div><div class="xs muted">${u.fileNote}</div></div><div style="width:72px;height:48px;border-radius:6px;background:var(--c-bg-media)"></div></div><div class="xs brand" style="display:flex;gap:6px;align-items:center">${ic("film", 14)}${u.light}</div></div>
    <div class="field"><div class="lbl">${u.title} <span style="color:var(--c-text-danger)">*</span></div><div class="ctl">${u.titleV}</div><div class="xs muted">${u.titleH}</div></div>
    <div class="field"><div class="lbl">${u.type}</div><div class="chips">${u.types.map((t, i) => `<span class="chip ${i < 2 ? "on" : ""}">${t}${i < 2 ? ic("check", 14) : ""}</span>`).join("")}</div></div>
    <div class="row"><div class="field" style="flex:1"><div class="lbl">${u.gov}</div><div class="ctl">${u.gaza}${ic("chev", 18)}</div></div><div class="field" style="flex:1"><div class="lbl">${u.city}</div><div class="ctl">${u.gaza}${ic("chev", 18)}</div></div></div>
    <div class="field"><div class="lbl">${u.prio}</div><div class="seg"><span class="urg">${u.prios[0]}</span><span>${u.prios[1]}</span><span>${u.prios[2]}</span></div></div>
    <div class="card" style="background:var(--c-bg-sunken)"><div class="lbl">${u.sens}</div>${u.qs.map((q, i) => `<div class="row"><span class="sm">${q}</span><span class="chips"><span class="chip ${i === 1 ? "on" : ""}" style="padding:4px 14px">${u.yes}</span><span class="chip ${i !== 1 ? "on" : ""}" style="padding:4px 14px">${u.no}</span></span></div>`).join("")}</div>
    <span class="btn p full">${u.next} ${ic("chev", 18)}</span></div>`,
  2: (u) => `<div class="sb"><b>9:41</b><span>●●●</span></div><div class="tb"><h1>${ic("chev", 22)} ${u.upTitle}</h1>${ic("bell", 24)}</div><div class="content">
    <div class="card" style="border-color:var(--c-tone-progress-border)"><div class="row" style="align-items:flex-start"><div class="h4" style="flex:1">${u.titleV}</div><span class="badge b-urg">${ic("alert", 14)}${u.urgent}</span></div><div class="xs muted">${u.file}</div>
    <div class="row"><span class="sm sec">${u.lightMsg}</span><span class="badge b-good">${ic("film", 14)}${u.lightOk}</span></div>
    <div class="row"><div><div class="lbl" style="font-size:16px">${u.origUp}</div><div class="xs muted">${u.bytes}</div></div><div class="mono" style="font:700 40px Inter;color:var(--c-text-brand)">${u.pct}</div></div>
    <div class="bar"><i></i></div><div class="parts">${Array.from({ length: 12 }, (_, i) => `<i class="${i < 8 ? "ok" : i === 8 ? "cur" : ""}"></i>`).join("")}</div><div class="xs muted">${u.parts}</div>
    <div class="safe"><span class="sm" style="flex:1">${u.safe}</span>${ic("shield", 20)}</div>
    <div class="chips"><span class="btn s">${u.pause}</span><span class="btn g">${u.wifi}</span></div></div>
    <div class="card"><div class="xs muted" style="font-weight:600;letter-spacing:.3px">${u.queued}</div><div class="row"><span class="lbl">${u.q1}</span><span class="xs muted">${u.q1s}</span></div><div class="row"><span class="lbl">${u.q2}</span><span class="xs muted mono">${u.q2s}</span></div></div></div>`,
  3: (u) => `<div class="sb"><b>9:41</b><span>●●●</span></div><div class="tb"><h1>${ic("chev", 22)} ${u.rcTitle}</h1><span></span></div><div class="content" style="text-align:center">
    <div style="padding-top:12px"><div class="ring">${ic("check", 40)}</div><div class="h2" style="margin-top:12px">${u.rcH}</div><div class="sm sec" style="margin-top:6px">${u.rcS}</div></div>
    <div class="card" style="border-color:var(--c-border-strong);box-shadow:0 4px 12px -2px rgba(23,28,26,.1)"><div class="xs muted" style="display:flex;gap:6px;justify-content:center;align-items:center">${u.receipt}${ic("receipt", 14)}</div><div class="mono" style="font-size:22px;font-weight:500">VL-2026-10-26-0481</div>
    <div style="text-align:start">${u.rows.map(([k, v]) => `<div class="row sm" style="padding:4px 0"><span class="muted">${k}</span><span>${v}</span></div>`).join("")}</div>${qr()}<div class="xs muted">${u.qr}</div></div>
    <div class="chips" style="justify-content:center"><span class="btn s">${u.share}</span><span class="btn g">${u.copy}</span></div>
    <div class="card" style="background:var(--c-tone-attention-bg);border-color:var(--c-tone-attention-border);text-align:start"><div class="lbl" style="font-size:16px;color:var(--c-tone-attention-fg)">${u.localT}</div><div class="sm">${u.localS}</div><div class="chips"><span class="btn p">${ic("lock", 18)}${u.del}</span><span class="btn g">${u.keep}</span></div></div></div>`,
  4: (u) => `<div class="sb"><b>9:41</b><span>●●●</span></div><div class="tb"><h1>${u.mine}</h1>${ic("bell", 24)}</div><div class="content" style="gap:12px">
    <div class="tabs"><span class="tab on">${u.tabs[0]}</span><span class="tab">${u.tabs[1]}</span></div>
    <div class="card"><div class="row" style="align-items:flex-start"><div class="h4" style="flex:1">${u.titleV}</div><span class="badge b-urg">${ic("alert", 14)}${u.urgent}</span></div>${badges(u.badges, ["b-good", "b-att", "b-neu"])}
    <div class="note"><div style="flex:1"><div class="lbl" style="color:var(--c-tone-attention-fg)">${u.note}</div><div class="sm">${u.noteS}</div></div>${ic("pen", 18)}</div>
    <div class="tl"><div class="xs muted" style="font-weight:600;margin-bottom:4px">${u.tl}</div>${u.ev.map(([l, t, k]) => `<div class="ev ${k}">${ic(k === "t" ? "film" : k === "e" ? "pen" : "scale", 18)}<div class="dot"><b></b><i></i></div><div style="flex:1"><div class="sm">${l}</div><div class="xs muted mono">${t}</div></div></div>`).join("")}</div>
    <div class="chips"><span class="btn p">${ic("upload", 18)}${u.alt}</span><span class="btn g">${u.reply}</span></div></div>
    <div class="card"><div class="h4">${u.m2}</div>${badges(u.m2b, ["b-prog", "b-neu", "b-neu"])}</div><div class="card"><div class="h4">${u.m3}</div>${badges(u.m3b, ["b-good", "b-good", "b-good"])}</div></div>`,
};
S[5] = S[4];
// Fonts are vendored (SIL OFL 1.1) in ./fonts and inlined as data URIs, so rendering needs no network access.
const FONT_DIR = path.join(__dirname, "fonts");
const FONTS = "<style>" + [["Inter", "Inter", [400, 500, 600, 700]], ["Noto Sans Arabic", "NotoSansArabic", [400, 500, 600, 700]], ["IBM Plex Mono", "IBMPlexMono", [400, 500]]].map(([fam, file, ws]) => ws.map((w) => { const b = fs.readFileSync(path.join(FONT_DIR, `${file}-${w}.woff`)).toString("base64"); return `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff;base64,${b}) format('woff')}`; }).join("")).join("") + "</style>";
function pageHtml({ locale, n, W, H, device, capH, scale, screenW }) {
  const l = L[locale], u = l.ui, dark = n === 5, mode = dark ? "dark" : "light";
  const cap = l.shots[n - 1];
  const devW = Math.round(screenW * scale) + 40, bez = 20;
  const headScale = device === "tablet" ? 0.052 : 0.066;
  const frame = device === "tablet" ? `border-radius:56px;` : `border-radius:${Math.round(22 * scale)}px;`;
  return `<!doctype html><html lang="${locale.slice(0, 2)}" dir="${l.dir}"><head><meta charset="utf-8">${FONTS}<style>
  :root{--font:${l.font};${css("light")}}:root[data-theme=dark]{${css("dark")}}
  ${BASE_CSS}
  body{width:${W}px;height:${H}px;overflow:hidden;background:linear-gradient(160deg,${tokens.color.primitive.green["700"].$value} 0%,${tokens.color.primitive.green["900"].$value} 70%,${tokens.color.primitive.neutral["950"].$value} 100%);color:#fff;display:flex;flex-direction:column;align-items:center}
  .cap{height:${capH}px;width:100%;padding:${Math.round(capH * 0.17)}px ${Math.round(W * 0.075)}px 0;display:flex;flex-direction:column;gap:${Math.round(capH * 0.05)}px}
  .brandline{display:flex;align-items:center;gap:${Math.round(W * 0.012)}px;font:600 ${Math.round(W * 0.022)}px Inter;letter-spacing:.5px;opacity:.9}
  .mark{display:flex;gap:4px}.mark i{width:${Math.round(W * 0.012)}px;height:${Math.round(W * 0.024)}px;border-radius:3px;background:${tokens.color.primitive.green["300"].$value}}.mark i+i{background:${tokens.color.primitive.red["300"].$value}}
  .cap h1{font-size:${Math.round(W * headScale)}px;line-height:1.25;font-weight:700;color:#fff;font-family:${l.font}}
  .cap p{font-size:${Math.round(W * 0.028)}px;line-height:1.6;color:${tokens.color.primitive.green["100"].$value};max-width:${Math.round(W * 0.85)}px;font-family:${l.font}}
  .syn{position:absolute;top:${Math.round(W * 0.03)}px;inset-inline-end:${Math.round(W * 0.04)}px;font:500 ${Math.round(W * 0.018)}px ${l.font};padding:6px 14px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);color:#fff}
  .device{width:${devW}px;background:#0E1211;border-radius:${device === "tablet" ? 64 : Math.round(28 * scale)}px;padding:${bez}px;box-shadow:0 40px 120px rgba(0,0,0,.45);flex:none}
  .device .vp{width:${Math.round(screenW * scale)}px;height:${H}px;overflow:hidden;${frame}}
  .screen{width:${screenW}px;transform:scale(${scale});transform-origin:top ${l.dir === "rtl" ? "right" : "left"};min-height:${Math.round(H / scale)}px}
  .screen .inner{max-width:560px;margin:0 auto;width:100%}
  </style></head><body><div class="syn">${l.synthetic}</div>
  <div class="cap"><div class="brandline"><span class="mark"><i></i><i></i></span>${l.brand} · ${l.org}</div><h1>${cap.h}</h1><p>${cap.s}</p></div>
  <div class="device"><div class="vp"><div class="screen" data-theme="${mode}" ${dark ? 'style="color-scheme:dark"' : ""}><div class="inner">${S[n](u)}</div></div></div></div>
  <script>document.querySelector('.screen').setAttribute('data-theme','${mode}');</script>
  <style>.screen[data-theme=dark]{${css("dark")}}</style></body></html>`;
}
const ICON_SVG = (size, { bg = true, pad = 0 } = {}) => { const g = tokens.color.primitive.green, r = tokens.color.primitive.red["500"].$value; const s = size, k = s / 1024, p = pad * k; return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${bg ? `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g["500"].$value}"/><stop offset="1" stop-color="${g["800"].$value}"/></linearGradient></defs><rect width="${s}" height="${s}" fill="url(#g)"/>` : ""}
<g transform="translate(${p},${p}) scale(${(s - 2 * p) / 1024})" fill="none" stroke="#FFFFFF" stroke-width="64" stroke-linecap="round" stroke-linejoin="round">
<path d="M232 392V296q0-64 64-64h96"/><path d="M632 232h96q64 0 64 64v96"/><path d="M792 632v96q0 64-64 64h-96"/><path d="M392 792h-96q-64 0-64-64v-96"/>
<path d="M512 700V380"/><path d="M400 492l112-112 112 112"/></g><circle cx="${(744 - pad) * ((s - 2 * p) / 1024) + p + (pad ? 0 : 0)}" cy="${(280) * ((s - 2 * p) / 1024) + p}" r="${44 * ((s - 2 * p) / 1024)}" fill="${r}" stroke="#FFFFFF" stroke-width="${18 * ((s - 2 * p) / 1024)}"/></svg>`; };
const FEATURE = (locale) => { const l = L[locale]; const g = tokens.color.primitive.green; return `<!doctype html><html dir="${l.dir}"><head><meta charset="utf-8">${FONTS}<style>body{margin:0;width:1024px;height:500px;overflow:hidden;background:linear-gradient(135deg,${g["600"].$value},${g["900"].$value});color:#fff;font-family:${l.font};display:flex;align-items:center;justify-content:space-between;padding:0 72px;box-sizing:border-box}.t h1{font-size:54px;margin:0 0 10px;font-weight:700}.t p{font-size:22px;margin:0;color:${g["100"].$value};max-width:560px;line-height:1.6}.syn{position:absolute;bottom:18px;inset-inline-start:72px;font-size:14px;opacity:.75}</style></head><body><div class="t"><h1>${l.brand}</h1><p>${locale === "ar" ? "أداة المراسلين لإرسال الأصل كما صُوِّر، برفع يستأنف وإيصال استلام." : "The reporters' tool to send the original as shot, with resumable upload and a receipt."}</p></div><div style="width:260px;height:260px;border-radius:58px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.35)">${ICON_SVG(260)}</div><div class="syn">${l.synthetic}</div></body></html>`; };
async function main() {
  const browser = await chromium.launch(); const ctx = await browser.newContext({ deviceScaleFactor: 1 }); const page = await ctx.newPage();
  const out = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
  const shoot = async (html, W, H, file) => { await page.setViewportSize({ width: W, height: H }); await page.setContent(html, { waitUntil: "networkidle" }); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(150); await page.screenshot({ path: out(file), type: file.endsWith('.jpg') ? 'jpeg' : 'png', quality: file.endsWith('.jpg') ? 92 : undefined, clip: { x: 0, y: 0, width: W, height: H } }); console.log("wrote", path.relative(ROOT, file)); };
  const targets = [
    { key: "iphone-6.9", W: 1320, H: 2868, device: "phone", capH: 700, scale: 2.95, screenW: 390, dir: (loc) => path.join(ROOT, "apps/ios/store/metadata", loc, "screenshots/iphone-6.9") },
    { key: "ipad-13", W: 2064, H: 2752, device: "tablet", capH: 760, scale: 2.9, screenW: 660, dir: (loc) => path.join(ROOT, "apps/ios/store/metadata", loc, "screenshots/ipad-13") },
    { key: "play-phone", W: 1080, H: 1920, device: "phone", capH: 520, scale: 2.4, screenW: 390, dir: (loc) => path.join(ROOT, "apps/android/store/metadata/android", loc, "images/phoneScreenshots") },
  ];
  for (const loc of ["ar", "en-US"]) for (const t of targets) for (let n = 1; n <= 5; n++) await shoot(pageHtml({ locale: loc, n, ...t }), t.W, t.H, path.join(t.dir(loc), `${n}.jpg`));
  // icons
  const iconHtml = (svg, s) => `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;
  const icon = async (svg, s, file) => { await page.setViewportSize({ width: s, height: s }); await page.setContent(iconHtml(svg, s)); await page.screenshot({ path: out(file), omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } }); console.log("wrote", path.relative(ROOT, file)); };
  await icon(ICON_SVG(1024), 1024, path.join(ROOT, "apps/ios/store/icon/AppIcon-1024.png"));
  await icon(ICON_SVG(512), 512, path.join(ROOT, "apps/android/store/icon/play-store-icon-512.png"));
  for (const loc of ["ar", "en-US"]) await icon(ICON_SVG(512), 512, path.join(ROOT, "apps/android/store/metadata/android", loc, "images/icon.png"));
  await icon(ICON_SVG(432, { bg: false, pad: 84 }), 432, path.join(ROOT, "apps/android/store/icon/ic_launcher_foreground-432.png"));
  await icon(`<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tokens.color.primitive.green["500"].$value}"/><stop offset="1" stop-color="${tokens.color.primitive.green["800"].$value}"/></linearGradient></defs><rect width="432" height="432" fill="url(#g)"/></svg>`, 432, path.join(ROOT, "apps/android/store/icon/ic_launcher_background-432.png"));
  fs.writeFileSync(out(path.join(ROOT, "apps/ios/store/icon/AppIcon.svg")), ICON_SVG(1024));
  for (const loc of ["ar", "en-US"]) await shoot(FEATURE(loc), 1024, 500, path.join(ROOT, "apps/android/store/metadata/android", loc, "images/featureGraphic.jpg"));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
