// قواعد الرفع من الحاسوب المشتركة بين الـBFF والمتصفح (#88). لا شيء هنا يحمل رمزًا.
// أدوار الرفع من الحاسوب كما في `x-roles` للعقد بعد #193 (createMaterial وcreateUploadSession وcreateWebIngestToken)؛ يطابقها contract-drift.
export const uploadRoles = ["reporter", "supervisor", "producer", "editor_in_chief"] as const;
export const sha256Hex = /^[0-9a-f]{64}$/;
// ملفات الكاميرات الشائعة؛ الخادم وعامل الوسائط هما الحكم النهائي على صلاحية الملف.
export const cameraExtensions = [".mov", ".mxf", ".mp4", ".m4v", ".mts", ".m2ts", ".avi", ".mkv", ".wav", ".jpg", ".jpeg", ".heic", ".png", ".dng", ".arw", ".cr3", ".nef"] as const;
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
