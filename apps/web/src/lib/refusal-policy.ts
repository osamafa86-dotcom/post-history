// رموز الرفض التي تمرّ من الـBFF إلى الواجهة برسائلها الخاصة (قرار المنسّق 2026-11-15): قائمة بيضاء لا تكشف إلا ما يراه المتصل أصلًا (حالة
// مادته أو سلّته أو طلبه أو مؤسسته). ما عداها يبقى `request_failed` كما كان، ولا تمرّ رسالة الخادم ولا تفاصيله إلا الشروط الفاشلة بأسمائها.
export const refusalCodes = ["listing_conditions_unmet", "listing_sensitive", "rights_not_sellable", "price_changed", "listing_unavailable", "exclusive_unavailable", "order_state_conflict", "mixed_currency", "email_taken", "seats_exhausted", "last_buyer_admin"] as const;
export type RefusalCode = (typeof refusalCodes)[number];
/** شروط العرض التي يسمّيها الخادم في `listing_conditions_unmet`: الاعتماد التحريري للإصدار، والأصل المتحقق. */
export const listingConditions = ["editorial_state", "technical_state"] as const;
export type ListingCondition = (typeof listingConditions)[number];
export type Refusal = { code: RefusalCode; failed?: ListingCondition[] };

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const failedOf = (value: unknown): ListingCondition[] => Array.isArray(value) ? listingConditions.filter(name => value.includes(name)) : [];
const passing: Record<number, readonly string[]> = {
  409: ["rights_not_sellable", "price_changed", "listing_unavailable", "exclusive_unavailable", "order_state_conflict", "seats_exhausted", "last_buyer_admin"],
  422: ["mixed_currency"],
};

/**
 * رفض الخادم (حالته وجسم خطئه) إلى رمز من القائمة، أو `null`. البريد القائم يرده الخادم `409 bad_request` بحقل البريد وحده، والمادة الحسّاسة
 * `422` بحقل الحالة وحده على كتابة الإدراج (`listing`)؛ فيُسمّيان هنا باسميهما.
 */
export function refusalOf(status: number, error: unknown, options: { listing?: boolean } = {}): Refusal | null {
  if (!plain(error) || typeof error.code !== "string") return null;
  const details = plain(error.details) ? error.details : {}, fields = Array.isArray(details.fields) ? details.fields : [], only = (field: string) => fields.length === 1 && fields[0] === field;
  if (status === 409 && error.code === "listing_conditions_unmet") return { code: "listing_conditions_unmet", failed: failedOf(details.failed) };
  if (status === 409 && error.code === "bad_request" && only("/email")) return { code: "email_taken" };
  if (options.listing && status === 422 && error.code === "validation_failed" && only("/state")) return { code: "listing_sensitive" };
  return passing[status]?.includes(error.code) ? { code: error.code as RefusalCode } : null;
}

/** الرفض في المتصفح من جسم ردّ الـBFF: رمز من القائمة وحده، والشروط الفاشلة بأسمائها المعروفة. */
export function refusalFromBody(body: unknown): Refusal | null {
  if (!plain(body) || !(refusalCodes as readonly unknown[]).includes(body.code)) return null;
  const code = body.code as RefusalCode;
  return code === "listing_conditions_unmet" ? { code, failed: failedOf(plain(body.details) ? body.details.failed : undefined) } : { code };
}
