import { materialTypes, states } from "./query";
import { validMaterialTags } from "./tag-policy";

/**
 * مسودة نموذج الرفع في sessionStorage حتى الإرسال: الحقول الأساسية غير الحسّاسة وحدها (العنوان والأنواع والوسوم والمكان ووقت التصوير
 * والأولوية). لا جواب حساسية (يُسأل كل مرة)، ولا اسم مستعار، ولا قيمة حقل ديناميكي. المسودة لصاحبها: تُقرأ بمعرّف حسابه وحده، وتسقط
 * بعد ثماني ساعات (عمر الجلسة)، وتُمحى عند الإرسال وعند الخروج الصريح من هذا التبويب؛ وتبقى حين تُبطَل الجلسة أو تنتهي، فيجدها صاحبها
 * بعد دخوله من جديد (تعديل ADR 0014). التبويب وحده يحملها: لا localStorage ولا خادم.
 */
export type UploadDraft = { title: string; types: string[]; tags: string[]; governorate: string; city: string; shot_at: string; priority: string };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const draftKey = "upload-draft", placeKey = "upload-place", lifetime = 8 * 3600000;
const session = (): Store | null => { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } };
const text = (value: unknown, max: number): value is string => typeof value === "string" && Array.from(value).length <= max;

function valid(value: unknown): value is UploadDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return text(d.title, 80) && text(d.governorate, 64) && text(d.city, 64) && text(d.shot_at, 32) && (d.shot_at === "" || Number.isFinite(Date.parse(d.shot_at)))
    && Array.isArray(d.types) && d.types.every(type => (materialTypes as readonly unknown[]).includes(type)) && new Set(d.types).size === d.types.length
    && validMaterialTags(d.tags) && (states.priority as readonly unknown[]).includes(d.priority);
}
const pick = (d: UploadDraft): UploadDraft => ({ title: d.title, types: [...d.types], tags: [...d.tags], governorate: d.governorate, city: d.city, shot_at: d.shot_at, priority: d.priority });
const empty = (d: UploadDraft) => !d.title.trim() && !d.types.length && !d.tags.length && !d.governorate.trim() && !d.city.trim() && !d.shot_at && d.priority === "normal";

export function saveDraft(user: string, draft: UploadDraft, now = Date.now(), store: Store | null = session()) {
  try { if (empty(draft)) store?.removeItem(draftKey); else store?.setItem(draftKey, JSON.stringify({ user, at: now, draft: pick(draft) })); } catch { /* المسودة تيسير لا شرط */ }
}
export function readDraft(user: string, now = Date.now(), store: Store | null = session()): UploadDraft | null {
  try {
    const raw = store?.getItem(draftKey);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { user?: unknown; at?: unknown; draft?: unknown };
    if (saved.user === user && typeof saved.at === "number" && now - saved.at <= lifetime && now >= saved.at && valid(saved.draft)) return pick(saved.draft);
  } catch { /* مسودة تالفة تُمحى */ }
  clearDraft(store); return null;
}
export function clearDraft(store: Store | null = session()) { try { store?.removeItem(draftKey); } catch { /* لا شيء */ } }

/** آخر مكان أُرسلت منه مادة في هذا التبويب، لصاحبه وحده: تعبئة مسبقة للمادة التالية كما يفعل تطبيقا المراسل. */
export function rememberPlace(user: string, governorate: string, city: string, store: Store | null = session()) {
  try { if (text(governorate, 64) && text(city, 64)) store?.setItem(placeKey, JSON.stringify({ user, governorate, city })); } catch { /* لا شيء */ }
}
export function lastPlace(user: string, store: Store | null = session()): { governorate: string; city: string } | null {
  try {
    const saved = JSON.parse(store?.getItem(placeKey) ?? "null") as { user?: unknown; governorate?: unknown; city?: unknown } | null;
    return saved && saved.user === user && text(saved.governorate, 64) && text(saved.city, 64) ? { governorate: saved.governorate, city: saved.city } : null;
  } catch { return null; }
}
export function clearPlace(store: Store | null = session()) { try { store?.removeItem(placeKey); } catch { /* لا شيء */ } }

// الخروج الصريح من هذا التبويب يمحو المسودة والمكان؛ إبطال الجلسة (يسبقه `session-revoked`) يبقيهما لصاحبهما.
if (typeof window !== "undefined") {
  let revoked = false;
  window.addEventListener("session-revoked", () => { revoked = true; });
  // مستمع حدّ الجلسة يردّ على `session-revoked` بإطلاق `clear-private-state` من داخله، وقد يسبق مستمعَنا للإبطال؛ فالقرار يؤجَّل إلى
  // نهاية المهمة الجارية (قبل أن تغادر الصفحة)، وعندها يُعرف أكان الخروج إبطالًا أم خروجًا صريحًا.
  window.addEventListener("clear-private-state", () => queueMicrotask(() => { if (!revoked) { clearDraft(); clearPlace(); } }));
}
