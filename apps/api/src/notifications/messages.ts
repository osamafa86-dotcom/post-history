// قوالب عناوين الإشعارات (موارد بالعربية والإنجليزية). العنوان يحمل رقم المادة وحالتها فقط:
// لا عنوان المادة ولا أسماء ولا موقع (ADR SEC-03)، فلا يُبنى من حقول المادة الحرة أبدًا.
export type Locale = 'ar' | 'en';

export const NOTIFICATION_TITLES: Record<string, Record<Locale, string>> = {
  'material.created': { ar: 'مادة واردة #{ref}', en: 'Incoming material #{ref}' },
  'material.urgent_received': { ar: 'مادة عاجلة واردة #{ref}', en: 'Urgent incoming material #{ref}' },
  'material.acknowledged': { ar: 'شوهدت مادتك #{ref}', en: 'Your material #{ref} was seen' },
  'material.change_requested': { ar: 'طلب تعديل على مادتك #{ref}', en: 'Changes requested on your material #{ref}' },
  'material.accepted_for_production': { ar: 'مادة #{ref} مقبولة للإنتاج', en: 'Material #{ref} accepted for production' },
  'material.published': { ar: 'نُشرت مادتك #{ref}', en: 'Your material #{ref} was published' },
  'notification.escalated': { ar: 'تصعيد: لم يُقرّ استلام المادة #{ref}', en: 'Escalation: material #{ref} not acknowledged' },
  'upload.verified': {
    ar: 'تم الاستلام بنجاح — المادة #{ref}، الإيصال {receipt}',
    en: 'Received successfully — material #{ref}, receipt {receipt}',
  },
};

/** رقم المادة المختصر الذي يظهر في العناوين. */
export const materialRef = (materialId: string) => materialId.slice(0, 8);

export function notificationTitle(type: string, locale: Locale, vars: { ref: string; receipt?: string }): string {
  const template = NOTIFICATION_TITLES[type]?.[locale];
  if (!template) throw new Error(`no notification title for ${type}`);
  return template.replace('{ref}', vars.ref).replace('{receipt}', vars.receipt ?? '');
}
