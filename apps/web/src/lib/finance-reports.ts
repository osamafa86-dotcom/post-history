import type { components, operations } from "@/generated/schema";
import { uuid } from "./query";
import { workName } from "./work-name";
import { currencies } from "./license-policy";
import { earningsLimits } from "./earnings-policy";

// قراءات المال المجمّعة (A4 وM5 وA5، ADR 0099): أنواع العقد المولَّدة؛ يطابق contract-drift الأدوار والأنماط مع OpenAPI.
export type ContributorEarnings = components["schemas"]["ContributorEarnings"];
export type ContributorEarningsTotals = components["schemas"]["ContributorEarningsTotals"];
export type ContributorEarningsPage = components["schemas"]["ContributorEarningsPage"];
export type BuyerPurchaseTotal = components["schemas"]["BuyerPurchaseTotal"];
export type BuyerPurchaseTotalsPage = components["schemas"]["BuyerPurchaseTotalsPage"];
export type ContributorQuery = operations["listContributorEarnings"]["parameters"]["query"];
export type PurchaseQuery = operations["listBuyerPurchaseTotals"]["parameters"]["query"];
type Role = components["schemas"]["RoleName"];
type Currency = components["schemas"]["Currency"];
type Money = components["schemas"]["Money"];
type Balance = components["schemas"]["EarningsBalance"];

export const reportReaders = ["system_admin", "finance"] as const satisfies readonly Role[];
export const monthPattern = /^20[0-9]{2}-(0[1-9]|1[0-2])$/;
export const yearLimits = { min: 2020, max: 2100 } as const;
const cursorMax = 2048;

const money = (value: unknown, currency: Currency): value is Money => !!value && typeof value === "object" && Number.isSafeInteger((value as Money).amount_minor) && (value as Money).amount_minor >= 0 && (value as Money).amount_minor <= earningsLimits.amountMax && (value as Money).currency === currency;
const copy = (value: Money): Money => ({ amount_minor: value.amount_minor, currency: value.currency });
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const basis = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10000 ? value as number : null;
const isCurrency = (value: unknown): value is Currency => (currencies as readonly unknown[]).includes(value);
const moneyKeys = ["gross", "fees_and_taxes", "net", "share", "refunded"] as const;

function page(params: URLSearchParams, allowed: string[]) {
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length > 1)) throw new Error("Invalid query");
  const limit = params.get("limit") ?? "100", cursor = params.get("cursor");
  if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > cursorMax) throw new Error("Invalid page");
  return { limit: +limit, ...(cursor ? { cursor } : {}) };
}
/** `month` إلزامي بنمط العقد (الخادم يفحص حضوره)، والعملة اختيارية. */
export function contributorQuery(params: URLSearchParams): ContributorQuery {
  const paging = page(params, ["month", "currency", "cursor", "limit"]), month = params.get("month"), currency = params.get("currency");
  if (!month || !monthPattern.test(month) || (currency !== null && !isCurrency(currency))) throw new Error("Invalid month");
  return { month, ...(currency ? { currency } : {}), ...paging };
}
export function purchaseQuery(params: URLSearchParams): PurchaseQuery {
  const paging = page(params, ["year", "cursor", "limit"]), year = params.get("year");
  if (!year || !/^\d{4}$/.test(year) || +year < yearLimits.min || +year > yearLimits.max) throw new Error("Invalid year");
  return { year: +year, ...paging };
}

function safeBalance(value: Balance, currency: Currency): Balance | null {
  const keys = ["pending", "available", "in_payout", "paid", "reserve", "requestable", "minimum"] as const;
  if (!value || value.currency !== currency || keys.some(key => !money(value[key], currency))) return null;
  return { currency, pending: copy(value.pending), available: copy(value.available), in_payout: copy(value.in_payout), paid: copy(value.paid), reserve: copy(value.reserve), requestable: copy(value.requestable), minimum: copy(value.minimum) };
}
/** صف المساهم بقائمة بيضاء: اسم العمل وحده، بلا بريد ولا اسم حقيقي ولا مشترٍ ولا مادة. الصف المخالف يسقط. */
export function safeContributor(row: ContributorEarnings): ContributorEarnings | null {
  if (!uuid.test(row.user_id) || !isCurrency(row.currency) || !count(row.sales) || moneyKeys.some(key => !money(row[key], row.currency))) return null;
  const balance = safeBalance(row.balance, row.currency);
  if (!balance) return null;
  return { user_id: row.user_id, work_name: workName(row.work_name), currency: row.currency, sales: row.sales, gross: copy(row.gross), fees_and_taxes: copy(row.fees_and_taxes), net: copy(row.net), share: copy(row.share), refunded: copy(row.refunded), share_basis_points: basis(row.share_basis_points), balance };
}
export function safeTotals(row: ContributorEarningsTotals): ContributorEarningsTotals | null {
  if (!isCurrency(row.currency) || !count(row.contributors) || !count(row.sales) || moneyKeys.some(key => !money(row[key], row.currency))) return null;
  return { currency: row.currency, contributors: row.contributors, sales: row.sales, gross: copy(row.gross), fees_and_taxes: copy(row.fees_and_taxes), net: copy(row.net), share: copy(row.share), refunded: copy(row.refunded), share_basis_points: basis(row.share_basis_points) };
}
export function safeContributorPage(value: ContributorEarningsPage): ContributorEarningsPage {
  if (!monthPattern.test(value.month)) throw new Error("Invalid month");
  return {
    month: value.month, items: value.items.map(safeContributor).filter((row): row is ContributorEarnings => row !== null),
    totals: value.totals.map(safeTotals).filter((row): row is ContributorEarningsTotals => row !== null),
    next_cursor: typeof value.next_cursor === "string" && value.next_cursor.length <= cursorMax ? value.next_cursor : null,
  };
}
export function safePurchaseTotal(row: BuyerPurchaseTotal): BuyerPurchaseTotal | null {
  if (!uuid.test(row.organization_id) || !isCurrency(row.currency) || !Number.isSafeInteger(row.paid_orders) || row.paid_orders < 1 || !money(row.paid, row.currency) || !money(row.refunded, row.currency)) return null;
  return { organization_id: row.organization_id, currency: row.currency, paid_orders: row.paid_orders, paid: copy(row.paid), refunded: copy(row.refunded) };
}
export function safePurchasePage(value: BuyerPurchaseTotalsPage): BuyerPurchaseTotalsPage {
  if (!Number.isSafeInteger(value.year)) throw new Error("Invalid year");
  return { year: value.year, items: value.items.map(safePurchaseTotal).filter((row): row is BuyerPurchaseTotal => row !== null), next_cursor: typeof value.next_cursor === "string" && value.next_cursor.length <= cursorMax ? value.next_cursor : null };
}

/** حالة الصرف من الرصيد الحالي لا من الشهر (ADR 0099): جاهز إن بلغ المتاح للطلب الحدَّ الأدنى، وقيد الصرف إن كان له طلب جارٍ، وإلا تحت الحد. */
export type PayoutReadiness = "ready" | "in_payout" | "below_minimum";
export function readiness(balance: Balance): PayoutReadiness {
  if (balance.requestable.amount_minor > 0 && balance.requestable.amount_minor >= balance.minimum.amount_minor) return "ready";
  return balance.in_payout.amount_minor > 0 ? "in_payout" : "below_minimum";
}

/** الشهر الحالي بتوقيت UTC كما يقرؤه الخادم، والانتقال شهرًا للأمام أو الخلف. */
export function currentMonth(now = new Date()) { return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; }
export function shiftMonth(month: string, delta: number) {
  const [year, value] = month.split("-").map(Number), date = new Date(Date.UTC(year, value - 1 + delta, 1));
  return currentMonth(date);
}
/** سطر جدول أو قائمة: المبلغ بلا رمز عملة (العملة في رأس العمود، A4)، بمنزلتين وأرقام لاتينية. */
export function plainAmount(value: Money, locale: "ar" | "en") {
  return new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value.amount_minor / 100);
}
/** نسبة العمولة المجمّدة نصًّا («30%»)، أو `null` حين تختلف بين البيعات. */
export function basisPercent(points: number | null, locale: "ar" | "en") {
  // الرقم وحده من Intl ثم «%»: نمط النسبة في العربية يُدخل علامات اتجاه خفية حول الرمز.
  return points === null ? null : `${new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { maximumFractionDigits: 2 }).format(points / 100)}%`;
}
