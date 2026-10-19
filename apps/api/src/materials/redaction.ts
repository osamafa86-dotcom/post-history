import type { UploadForm } from '../forms/dynamic-fields';
import type { Permission } from '../identity/principal';

/**
 * قاعدة الحجب (ADR SEC-03): قيمة حقل موسوم `sensitive` تُحذف لمن لا يحمل protected_source:read، وقيمة حقل
 * `location` لمن لا يحمل sensitive_location:read؛ المفتاح يُذكر في redacted_field_keys. ما يُعاد غير محجوب
 * من هذه الحقول يُعاد في `disclosed` ليُسجَّل في التدقيق (material.sensitive_read).
 */
export function redactDynamicFields(
  form: UploadForm | undefined,
  values: Record<string, unknown>,
  permissions: ReadonlySet<Permission>,
): { fields: Record<string, unknown>; redacted: string[]; disclosed: string[] } {
  const fields = { ...values };
  const redacted: string[] = [];
  const disclosed: string[] = [];
  for (const f of form?.fields ?? []) {
    const needed: Permission | undefined =
      f.type === 'location' ? 'sensitive_location:read' : f.sensitive ? 'protected_source:read' : undefined;
    if (!needed || !(f.key in fields)) continue;
    if (permissions.has(needed)) disclosed.push(f.key);
    else {
      delete fields[f.key];
      redacted.push(f.key);
    }
  }
  // بلا نسخة النموذج لا يُعرف ما الحساس: لا يُعاد شيء (لا تُفسَّر الحقول دون إصدارها)
  if (!form) return { fields: {}, redacted: Object.keys(values), disclosed: [] };
  return { fields, redacted, disclosed };
}
