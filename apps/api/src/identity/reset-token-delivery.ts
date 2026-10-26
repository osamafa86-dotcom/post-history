/**
 * تسليم رمز إعادة التعيين بعد اعتماد الاستعادة (v0.1، قرار المنسّق). الافتراضي: يُعاد مرة واحدة في استجابة الاعتماد
 * للمشرف المعتمِد فينقله لصاحب الحساب شفهيًا. قناة أخرى (مثل لقاء مكتبي مُسجَّل) تُحقن بديلًا عن هذا المزوّد، وحين
 * تتولى التسليم بنفسها لا يظهر الرمز في الاستجابة. أي تنفيذ لا يسجل الرمز ولا يكتبه في Outbox أو إشعار.
 */
export interface ResetTokenDelivery {
  /** true = هذه القناة تسلّم الرموز خارج الاستجابة دائمًا؛ يحتاجه رد الدعوة المتعارضة ليطابق شكل الناجحة دون تسليم. */
  readonly outOfBand: boolean;
  /** true = سُلِّم خارج الاستجابة؛ false = يُعاد للمعتمِد في الاستجابة. */
  deliver(handover: { token: string; expiresAt: string; targetUserId: string; recoveryRequestId: string }): Promise<boolean>;
}

export const RESET_TOKEN_DELIVERY = Symbol('RESET_TOKEN_DELIVERY');

export class InlineResetTokenDelivery implements ResetTokenDelivery {
  readonly outOfBand = false;

  async deliver(): Promise<boolean> {
    return false;
  }
}
