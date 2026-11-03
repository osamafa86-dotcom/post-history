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
  // معرّف الطلب في العنوان لأن Notification في العقد لا يحمل حقلًا له؛ المشرف يحتاجه للاعتماد. لا بيانات شخصية.
  'auth.recovery_requested': { ar: 'طلب استعادة حساب بانتظار اعتمادك: {ref}', en: 'Account recovery awaiting your approval: {ref}' },
  'auth.recovery_requested.self': {
    ar: 'طُلبت استعادة حسابك؛ إن لم تطلبها فأبلغ مشرفك',
    en: 'Recovery of your account was requested; tell your supervisor if it was not you',
  },
  'auth.recovery_completed': {
    ar: 'أُكملت استعادة حسابك بكلمة مرور ومصادقة جديدتين؛ إن لم تكن أنت فأبلغ مشرفك فورًا',
    en: 'Your account recovery was completed with a new password and two-factor setup; tell your supervisor now if it was not you',
  },
  'setting.changed': {
    ar: 'تغيّر إعداد من يرى الاسم الحقيقي للمراسلين؛ راجع سجل التدقيق',
    en: 'The setting for who sees reporters\' legal names changed; check the audit log',
  },
  // نسخة قالب «مواد متداولة» لطالبها وحده (ADR 0091): رقم المادة وحالة النسخة، بلا عنوانها ولا مكانها
  'render.completed': {
    ar: 'نسختك من المادة #{ref} على قالب «مواد متداولة» جاهزة',
    en: 'Your circulated-template copy of material #{ref} is ready',
  },
  'render.failed': {
    ar: 'تعذّر إنتاج نسختك من المادة #{ref} على قالب «مواد متداولة»',
    en: 'Your circulated-template copy of material #{ref} could not be made',
  },
  // نسخة قالب «الشاهد» (ADR 0109): الحدثان أنفسهما، والعنوان يسمّي القالب الذي طُلب
  'render.completed.witness': {
    ar: 'نسختك من المادة #{ref} على قالب «الشاهد» جاهزة',
    en: 'Your Witness-template copy of material #{ref} is ready',
  },
  'render.failed.witness': {
    ar: 'تعذّر إنتاج نسختك من المادة #{ref} على قالب «الشاهد»',
    en: 'Your Witness-template copy of material #{ref} could not be made',
  },
  // إسناد المادة إلى المونتير (ADR 0096): رقم المادة وحده، بلا ملاحظة ولا موعد ولا اسم
  'assignment.created': { ar: 'مهمة جديدة: المادة #{ref}', en: 'New task: material #{ref}' },
  'assignment.done': { ar: 'سُلّمت مهمة المادة #{ref}', en: 'Task on material #{ref} delivered' },
  'assignment.returned': { ar: 'أُعيدت مهمة المادة #{ref}', en: 'Task on material #{ref} returned' },
  // عنوان عام لأحداث تضبط لها الإدارة قاعدة ولا قالب خاص لها (v0.2)
  'material.generic': { ar: 'تحديث على المادة #{ref}', en: 'Update on material #{ref}' },
  'upload.verified': {
    ar: 'تم الاستلام بنجاح — المادة #{ref}، الإيصال {receipt}',
    en: 'Received successfully — material #{ref}, receipt {receipt}',
  },
};

/** رقم المادة المختصر الذي يظهر في العناوين. */
export const materialRef = (materialId: string) => materialId.slice(0, 8);

export function notificationTitle(type: string, locale: Locale, vars: { ref: string; receipt?: string }): string {
  const generic = /^(material|upload|ai)\./.test(type) ? NOTIFICATION_TITLES['material.generic'] : undefined;
  const template = (NOTIFICATION_TITLES[type] ?? generic)?.[locale];
  if (!template) throw new Error(`no notification title for ${type}`);
  return template.replace('{ref}', vars.ref).replace('{receipt}', vars.receipt ?? '');
}
