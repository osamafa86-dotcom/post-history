import type { Material, MaterialRender, MaterialRenderRequest, RenderAspect, RenderLabel, RenderTemplate, RoleName } from "./types";
import { sensitivityState } from "./sensitivity";
import { dateTime, uuid } from "./query";

/**
 * نسخة المادة على قالب «مواد متداولة» أو «الشاهد» (ADR 0091 و0109، web-v2.md «نسخة بقالب المتداول»؛ الويب ADR 0110): ما يقرّره
 * الويب قبل الطلب وبعده. القيم هنا من العقد، واختبار التطابق (`contract-drift.test.ts`) يقارنها به.
 */
export const renderRoles = ["supervisor", "producer", "editor_in_chief"] as const satisfies readonly RoleName[];
/** القالبان بترتيب العرض: الأول ما يُفتح عليه الحوار، والطلب يحمل الاختيار صريحًا دائمًا (لا افتراض في العقد). */
export const renderTemplates = ["circulated", "witness"] as const satisfies readonly RenderTemplate[];
export const renderAspects = ["vertical", "horizontal", "square"] as const satisfies readonly RenderAspect[];
export const renderLabels = ["circulated_footage", "none"] as const satisfies readonly RenderLabel[];
export const renderStates = ["requested", "rendering", "ready", "failed"] as const satisfies readonly MaterialRender["state"][];
export const renderFailures = ["source_unavailable", "title_overflow", "render_failed"] as const;
/** الشروط الفاشلة في `details.failed` لردّ `409 render_not_allowed` (وصف `POST /materials/{id}/renders`). */
export const renderConditions = ["source", "editorial_state", "rights_state"] as const;
export type RenderCondition = (typeof renderConditions)[number];
export const titleLineMax = 22, titleLinesMax = 3, locationMax = 44;
/** الاستطلاع كل عشر ثوانٍ ما دامت نسخة في الطابور أو قيد التجهيز؛ العقد لا يعطي نسبة ولا حدثًا للمتصفح. */
export const renderPollMs = 10000;

/** نمط `RenderTitleLine` في العقد حرفيًا (قاعدة `MaterialTag`، ADR 0086): لا مسافة في الطرفين، ولا محارف تحكم ولا اتجاه. */
export const titleLinePattern = "^[^\\s\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069](?:[^\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*[^\\s\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069])?$";
const titleLineRule = new RegExp(titleLinePattern, "u");
const forbidden = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** الطول بنقاط ترميز Unicode كما يعدّه الخادم (`[...line].length`)، لا بوحدات UTF-16. */
export const codePoints = (value: string) => Array.from(value).length;
/** ما يُنظَّف عند الكتابة واللصق: محارف التحكم والاتجاه، فالخادم يرفضها في أي موضع. */
export const cleanLine = (value: string) => value.replace(forbidden, "");
export const validLine = (value: string) => codePoints(value) <= titleLineMax && titleLineRule.test(value);

/**
 * القسمة الأولى من عنوان المادة على الكلمات (ADR 0091 البند 3): أقل عدد من الأسطر يسع كل سطر فيه 22، وبأقصر سطر أطول
 * بينها، فتتوازن الأسطر. وإن لم يسع ثلاثة أسطر بقي الفائض في الثالث فيظهر عدّاده أحمر، والطاقم يقسم على المعنى.
 */
export function splitTitle(title: string): string[] {
  const words = cleanLine(title).split(/\s+/u).filter(Boolean);
  if (!words.length) return [""];
  const joined = (from: number, to: number) => words.slice(from, to).join(" ");
  for (let count = 1; count <= Math.min(titleLinesMax, words.length); count++) {
    let best: string[] | null = null, bestWidth = Infinity;
    const cuts = count === 1 ? [[]] : count === 2 ? words.slice(1).map((_, i) => [i + 1]) : words.slice(1).flatMap((_, i) => words.slice(i + 2).map((__, j) => [i + 1, i + j + 2]));
    for (const cut of cuts) {
      const bounds = [0, ...cut, words.length], lines = bounds.slice(1).map((end, i) => joined(bounds[i], end));
      const width = Math.max(...lines.map(codePoints));
      if (width < bestWidth) { best = lines; bestWidth = width; }
    }
    if (best && bestWidth <= titleLineMax) return best;
  }
  const lines: string[] = [""];
  for (const word of words) {
    const current = lines[lines.length - 1];
    if (current && lines.length < titleLinesMax && codePoints(`${current} ${word}`) > titleLineMax) lines.push(word);
    else lines[lines.length - 1] = current ? `${current} ${word}` : word;
  }
  return lines;
}

/** الحساسية تطفئ المكان افتراضيًا (قرار المنسّق 2026-11-02)، والمجهولة تُعامَل حساسة: الفشل مغلق. */
export function isSensitive(material: Pick<Material, "sensitivity">) {
  const state = sensitivityState(material.sensitivity);
  return !state.known || state.flags.length > 0;
}

/** النص الذي يبنيه الخادم ساعة الطلب كما سيُطبع، للمعاينة وحدها: «المدينة، المحافظة»، والمدينة وحدها إن ساوت المحافظة. لا يُرسل أبدًا. */
export const locationPreview = (material: Pick<Material, "city" | "governorate">) =>
  material.city === material.governorate ? material.city : `${material.city}، ${material.governorate}`;

export type RenderDraft = { template: RenderTemplate; aspect: RenderAspect; lines: string[]; showLocation: boolean; label: RenderLabel | null };
const pad = (lines: string[]) => [...lines, "", "", ""].slice(0, titleLinesMax);
/**
 * الحوار ابتداءً، أو مملوءًا بمعاملات النسخة الفاشلة («طلب جديد») ومنها قالبها. الوسم بلا قيمة افتراضية في الطلب الجديد،
 * والقالب على «مواد متداولة» كما كان قبل «الشاهد» (لا يضلّل أيّهما، فالاختيار ظاهر يغيّره الطاقم).
 */
export function initialDraft(material: Pick<Material, "title" | "sensitivity">, from?: Pick<MaterialRender, "template" | "aspect" | "title_lines" | "show_location" | "label">): RenderDraft {
  if (from) return { template: from.template, aspect: from.aspect, lines: pad(from.title_lines), showLocation: from.show_location, label: from.label };
  return { template: renderTemplates[0], aspect: "vertical", lines: pad(splitTitle(material.title)), showLocation: !isSensitive(material), label: null };
}
export const lineOver = (line: string) => codePoints(line) > titleLineMax;
/** ما يمنع الإرسال: سطر فوق 22 أو مخالف، أو لا سطر، أو وسم لم يُختر. */
export function canSubmit(draft: RenderDraft) {
  const lines = draft.lines.map(line => line.trim()).filter(Boolean);
  return draft.label !== null && lines.length > 0 && !draft.lines.some(lineOver) && lines.every(validLine);
}
/** جسم الطلب كما في `MaterialRenderRequest` وحده: لا نص مكان ولا مفتاح غيره (المخطط مغلق). */
export function renderRequest(draft: RenderDraft): MaterialRenderRequest | null {
  if (!canSubmit(draft) || draft.label === null) return null;
  return { template: draft.template, aspect: draft.aspect, title_lines: draft.lines.map(line => line.trim()).filter(Boolean), show_location: draft.showLocation, label: draft.label };
}

/** التحقق في الـBFF قبل الخادم: المفاتيح الخمسة وحدها، والقيم من العقد، ويُعاد بناء الجسم منها. */
export function renderInput(body: Record<string, unknown>): MaterialRenderRequest | null {
  const keys = Object.keys(body).sort().join(","), lines = body.title_lines;
  if (keys !== "aspect,label,show_location,template,title_lines" || !(renderTemplates as readonly unknown[]).includes(body.template) || typeof body.show_location !== "boolean") return null;
  if (!(renderAspects as readonly unknown[]).includes(body.aspect) || !(renderLabels as readonly unknown[]).includes(body.label)) return null;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > titleLinesMax || !lines.every(line => typeof line === "string" && validLine(line))) return null;
  return { template: body.template as RenderTemplate, aspect: body.aspect as RenderAspect, title_lines: lines as string[], show_location: body.show_location, label: body.label as RenderLabel };
}

const time = (value: unknown) => typeof value === "string" && dateTime.test(value) && Number.isFinite(Date.parse(value));
const optional = <T>(value: unknown, test: (v: unknown) => boolean) => (value === null || value === undefined ? null : test(value) ? value as T : undefined);
/** النسخة بقائمة بيضاء؛ وما خالف العقد يُسقط الصفّ كله (فشل مغلق). */
export function safeRender(item: MaterialRender): MaterialRender | null {
  const fileId = optional<string>(item.file_id, v => typeof v === "string" && uuid.test(v)), reason = optional<MaterialRender["failure_reason"]>(item.failure_reason, v => (renderFailures as readonly unknown[]).includes(v));
  const location = optional<string>(item.location_text, v => typeof v === "string" && codePoints(v) <= locationMax);
  const started = optional<string>(item.started_at, time), completed = optional<string>(item.completed_at, time);
  if (![item.id, item.material_id, item.source_file_id, item.requested_by].every(v => typeof v === "string" && uuid.test(v)) || !Number.isSafeInteger(item.material_version) || !(renderTemplates as readonly string[]).includes(item.template)
    || !(renderAspects as readonly string[]).includes(item.aspect) || !(renderLabels as readonly string[]).includes(item.label) || !(renderStates as readonly string[]).includes(item.state)
    || typeof item.show_location !== "boolean" || !Array.isArray(item.title_lines) || item.title_lines.length < 1 || item.title_lines.length > titleLinesMax || !item.title_lines.every(line => typeof line === "string" && validLine(line))
    || !time(item.requested_at) || [fileId, reason, location, started, completed].includes(undefined)) return null;
  return { id: item.id, material_id: item.material_id, material_version: item.material_version, source_file_id: item.source_file_id, template: item.template, aspect: item.aspect,
    title_lines: [...item.title_lines], show_location: item.show_location, location_text: location ?? null, label: item.label, state: item.state, file_id: fileId ?? null,
    failure_reason: reason ?? null, requested_by: item.requested_by, requested_at: item.requested_at, started_at: started ?? null, completed_at: completed ?? null };
}

/** تفاصيل `409 render_not_allowed` الآلية وحدها: الشروط من قائمتها، والحدّ عددًا صحيحًا موجبًا. */
export function renderDetails(value: unknown): { failed: RenderCondition[]; max_source_duration_ms?: number } {
  const details = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const failed = Array.isArray(details.failed) ? renderConditions.filter(c => (details.failed as unknown[]).includes(c)) : [];
  const max = details.max_source_duration_ms;
  return { failed, ...(Number.isSafeInteger(max) && Number(max) > 0 ? { max_source_duration_ms: Number(max) } : {}) };
}

export const unfinished = <T extends Pick<MaterialRender, "state">>(items: readonly T[]) => items.filter(item => item.state === "requested" || item.state === "rendering");
/** النسخ بقالبها لبطاقة الملفات: مجموعة لكل قالب فيه نسخة، بترتيب القالبين، والأحدث أولًا داخلها كما جاءت. */
export const byTemplate = <T extends Pick<MaterialRender, "template">>(items: readonly T[]) =>
  renderTemplates.map(template => ({ template, items: items.filter(item => item.template === template) })).filter(group => group.items.length > 0);
/** هل يُعاد الطلب؟ ما دامت نسخة في الطابور أو قيد التجهيز. */
export const shouldPoll = (items: readonly Pick<MaterialRender, "state">[]) => unfinished(items).length > 0;

export type PollResult = { items: MaterialRender[] } | { status: number };
/**
 * يقرأ القائمة ثم يعيدها كل `interval` ما دامت `shouldPoll`، ويقف حين لا تبقى نسخة غير منتهية، أو عند ردّ نهائي (401 و403 و404:
 * العلم مطفأ أو الدور لا يطلب). الخطأ العابر يُعاد بعد المدة نفسها. يعيد دالة الإيقاف.
 */
export function pollRenders(load: (signal: AbortSignal) => Promise<MaterialRender[]>, report: (result: PollResult) => void, statusOf: (error: unknown) => number, interval = renderPollMs) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let again: boolean;
    try {
      const items = await load(controller.signal);
      if (controller.signal.aborted) return;
      report({ items }); again = shouldPoll(items);
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = statusOf(error); report({ status }); again = ![401, 403, 404].includes(status);
    }
    if (again && !controller.signal.aborted) timer = setTimeout(() => void tick(), interval);
  };
  void tick();
  return () => { controller.abort(); clearTimeout(timer); };
}
