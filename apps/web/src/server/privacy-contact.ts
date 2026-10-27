// بريد التواصل بشأن الخصوصية: يُقرأ من بيئة الخادم عند كل طلب، ولا يُكتب في المستودع (عام) ولا يُدمج وقت البناء.
// لا يُسجَّل في أي سجل؛ تأتي القيمة من متغير البيئة وحده ويفحصها الخادم قبل العرض.
export const PRIVACY_CONTACT_ENV = "PRIVACY_CONTACT_EMAIL";

// شكل بريد بسيط ومحافظ: أحرف وأرقام ونقطة وشرطتان وزائد في الجزء المحلي، ونطاق بنقطة واحدة على الأقل.
// يستبعد عمدًا ما يغيّر معنى رابط mailto (?، &، #، %، المسافات، الفواصل) كي لا تُحقن معاملات في الرابط.
const EMAIL_SHAPE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const MAX_LENGTH = 254;

/** يعيد البريد المنظَّف، أو null إن غاب المتغير أو فرغ أو لم يطابق الشكل. */
export function privacyContactEmail(env: Record<string, string | undefined> = process.env): string | null {
  const value = env[PRIVACY_CONTACT_ENV]?.trim();
  if (!value || value.length > MAX_LENGTH || !EMAIL_SHAPE.test(value)) return null;
  return value;
}
