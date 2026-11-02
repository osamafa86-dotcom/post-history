export const sensitivityFlags = ["minors", "injured", "graphic"] as const;
export type SensitivityFlag = (typeof sensitivityFlags)[number];
export type SensitivityState = { known: false } | { known: true; flags: SensitivityFlag[] };

/**
 * حالة سطر الحساسية (W2): «غير معروف» حين يغيب الحقل أو ينقصه علم أو يأتي بقيمة غير منطقية، فلا يطمئن السطر عن بيانات غائبة؛
 * وإلا الأعلام المفعّلة (ولا علم = لم يُوسَم شيء). العقد يجعل الحقل إلزاميًا، والفشل هنا مغلق لا مفتوح.
 */
export function sensitivityState(value: unknown): SensitivityState {
  if (!value || typeof value !== "object") return { known: false };
  const record = value as Record<string, unknown>;
  if (sensitivityFlags.some(flag => typeof record[flag] !== "boolean")) return { known: false };
  return { known: true, flags: sensitivityFlags.filter(flag => record[flag] === true) };
}
