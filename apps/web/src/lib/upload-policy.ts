// قواعد الرفع من الحاسوب المشتركة بين الـBFF والمتصفح (#88). لا شيء هنا يحمل رمزًا.
// أدوار الرفع من الحاسوب كما في `x-roles` للعقد بعد #193 (createMaterial وcreateUploadSession وcreateWebIngestToken)؛ يطابقها contract-drift.
export const uploadRoles = ["reporter", "supervisor", "producer", "editor_in_chief"] as const;
export const sha256Hex = /^[0-9a-f]{64}$/;
// ملفات الكاميرات التي يقرؤها عامل الوسائط: حاويات الفيديو في قائمته البيضاء (ومنها MXF)، وصور JPEG وPNG (تُصنع لها مصغّرة)، وHEIC
// وRAW (أصول تُحفظ بلا معاينة). لا AVI: لا مسار يقرؤه. الخادم وعامل الوسائط هما الحكم النهائي على صلاحية الملف.
export const cameraExtensions = [".mov", ".mxf", ".mp4", ".m4v", ".mts", ".m2ts", ".mkv", ".wav", ".jpg", ".jpeg", ".heic", ".png", ".dng", ".arw", ".cr3", ".nef"] as const;
export const fingerprintBytes = 1048576;
export const hashSliceBytes = 8 * 1048576;
// تجديد رمز ingest قبل انتهائه بدقيقة: عمره ≤ 10 دقائق، والجزء الواحد قد يستغرق دقائق على شبكة ضعيفة.
export const ingestRefreshMarginMs = 60000;

export type FileIdentity = { name: string; size: number; lastModified: number };
export const fileKey = (file: FileIdentity) => `${file.size}:${file.lastModified}:${file.name}`;

/** نقطة tus مقبولة: أصل من قائمة الإعداد، بلا بيانات اعتماد ولا استعلام. */
export function allowedTusEndpoint(value: unknown, origins: readonly string[]): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return origins.includes(url.origin) && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith("/");
  } catch { return false; }
}

/** عنوان رفع tus (من Location) يجب أن يبقى تحت نقطة الإنشاء نفسها، فلا تُرسل الرموز إلى مضيف آخر. */
export function withinEndpoint(value: string, endpoint: string): boolean {
  try {
    const url = new URL(value), base = new URL(endpoint);
    return url.origin === base.origin && url.pathname.startsWith(base.pathname) && url.pathname.length > base.pathname.length && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export function acceptedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return cameraExtensions.some(extension => lower.endsWith(extension));
}

// سؤال الحساسية كما في تطبيقَي المراسل (reporter-v2.md 04 و04b و04c): سؤال واحد بلا جواب مسبق؛ «لا» تعني الأعلام الثلاثة `false` لأن السؤال
// يسمّيها، و«نعم» تفتح الثلاثة ولكلٍّ جواب صريح. لا يُنشأ طلب قبل اكتمال الجواب.
export const sensitivityFlagNames = ["minors", "injured", "graphic"] as const;
export type SensitivityFlag = typeof sensitivityFlagNames[number];
export type SensitivityAnswers = { gate: "no" | "yes" | null } & Record<SensitivityFlag, boolean | null>;
export const noSensitivityAnswer: SensitivityAnswers = { gate: null, minors: null, injured: null, graphic: null };

/** إعادة اختيار الجواب نفسه لا تمحو شيئًا؛ تغييره يبدأ من جديد. */
export function answerSensitivity(current: SensitivityAnswers, gate: "no" | "yes"): SensitivityAnswers {
  if (current.gate === gate) return current;
  const each = gate === "no" ? false : null;
  return { gate, minors: each, injured: each, graphic: each };
}
export const answerFollowup = (current: SensitivityAnswers, flag: SensitivityFlag, value: boolean): SensitivityAnswers => ({ ...current, gate: "yes", [flag]: value });

/** أعلام العقد حين يكتمل الجواب، وإلا `null`. */
export function sensitivityFlags(answers: SensitivityAnswers): Record<SensitivityFlag, boolean> | null {
  const { minors, injured, graphic } = answers;
  return answers.gate !== null && minors !== null && injured !== null && graphic !== null ? { minors, injured, graphic } : null;
}

/** أول ما ينقص قبل إنشاء المادة، بترتيب النموذج: النوع ثم الوسوم ثم جواب الحساسية ثم أسئلته الثلاثة. */
export function uploadNeed({ types, tags, sensitivity }: { types: readonly string[]; tags: readonly string[]; sensitivity: SensitivityAnswers }): "type" | "tags" | "sensitivity" | "followups" | null {
  if (!types.length) return "type";
  if (!tags.length) return "tags";
  if (sensitivity.gate === null) return "sensitivity";
  return sensitivityFlags(sensitivity) ? null : "followups";
}

// حدود الحقول الأساسية كما يتحقق منها الـBFF (server/uploads.ts): العنوان بنقاط الترميز بعد قصّ طرفيه.
export const titleLimits = { min: 5, max: 80 } as const;
export type BaseField = "title" | "governorate" | "city" | "shot_at" | "pseudonym";
/** الحقول الأساسية الخاطئة بترتيب النموذج، فتأخذ كل واحدة رسالتها تحتها والأولى التركيز. وقت التصوير لا يكون في المستقبل. */
export function baseErrors(base: { title: string; governorate: string; city: string; shot_at: string; mode: string; pseudonym: string }, now: number): BaseField[] {
  const length = Array.from(base.title.trim()).length, errors: BaseField[] = [];
  if (length < titleLimits.min || length > titleLimits.max) errors.push("title");
  if (!base.governorate.trim()) errors.push("governorate");
  if (!base.city.trim()) errors.push("city");
  if (base.shot_at && !(Date.parse(base.shot_at) <= now)) errors.push("shot_at");
  if (base.mode === "pseudonym" && !base.pseudonym.trim()) errors.push("pseudonym");
  return errors;
}

/** فشل إنشاء جلسة الرفع: 401 جلسة الدخول، و404 و409 جلسة لم تعد تقبل، و5xx عطل عندنا لا رفض، وما عداها رفض. */
export function createFailure(status: number): "session_revoked" | "not_accepted" | "storage_error" | "rejected" {
  return status === 401 ? "session_revoked" : status === 404 || status === 409 ? "not_accepted" : status >= 500 ? "storage_error" : "rejected";
}

/**
 * بطاقة واحدة لكل ملف في «رفعات لم تكتمل»: جلسة الخادم تأخذ سجلها المحلي بمعرّفها، وإن لم يحفظه السجل (ضاع ردّ إنشائها) فبالمادة والنوع
 * والحجم. السجل لا يُعطى لجلستين، وما بقي بلا جلسة سجلات لم تبدأ على الخادم.
 */
export function pairSessions<S extends { id: string; material_id: string; kind: string; size_bytes: number }, R extends { session_id?: string; material_id: string; create: { kind: string; size_bytes: number } }>(sessions: readonly S[], records: readonly R[]): { pairs: { session: S; record: R | null }[]; orphans: R[] } {
  const free = [...records], take = (match: (record: R) => boolean) => { const index = free.findIndex(match); return index < 0 ? null : free.splice(index, 1)[0]; };
  const known = sessions.map(session => ({ session, record: take(record => record.session_id === session.id) }));
  const pairs = known.map(pair => pair.record ? pair : { session: pair.session, record: take(record => !record.session_id && record.material_id === pair.session.material_id && record.create.kind === pair.session.kind && record.create.size_bytes === pair.session.size_bytes) });
  return { pairs, orphans: free };
}
