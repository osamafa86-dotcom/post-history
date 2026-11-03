import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { safeStaffPage, staffQuery, staffReaders } from "@/lib/staff-policy";
import { rewriteInput, safeRewrite, safeSuggestions, safeTagUsagePage, suggestionReaders, suggestionsInput, tagAdmins, tagUsageQuery } from "@/lib/tag-policy";
import { platformAdmins, platformInput, safePlatformSettings } from "@/lib/platform-policy";
import { contributorQuery, purchaseQuery, reportReaders, safeContributorPage, safePurchasePage } from "@/lib/finance-reports";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
/** الإصدار في `ETag` (`"<version>"`) من الجسم المنقّى نفسه، فلا يمرّ ترويس من الخادم لم يُفحص. */
const json = (value: unknown, status = 200, version?: number) => {
  const response = NextResponse.json(value, { status, headers: privateHeaders });
  if (version !== undefined) response.headers.set("ETag", `"${version}"`);
  return response;
};
const readPaths = ["users", "tag-suggestions", "tags", "platform-settings", "contributor-earnings", "buyer-purchase-totals"];
const writePaths: Record<string, string> = { "tag-suggestions": "PUT", "tag-rewrites": "POST", "platform-settings": "PUT" };
export const adminReadPath = (path: string) => readPaths.includes(path);
export const adminWritePath = (path: string, method: string) => writePaths[path] === method;
function role(me: Me, ...roles: Parameters<typeof hasRole>[1][]) { if (!hasRole(me, ...roles)) throw new WebError(403, "request_failed"); }
function parsed<T>(read: () => T): T { try { return read(); } catch { throw new WebError(400, "request_failed"); } }
/** ردّ الخادم المخالف للعقد لا يصل المتصفح. */
function checked<T>(read: () => T): T { try { return read(); } catch { throw new WebError(502, "temporarily_unavailable"); } }

/**
 * قراءات لوحة الإدارة (ADR 0098، 0099): حسابات الطاقم بلا بريد، والوسوم وقائمتها المقترحة بإصدارها، وهوية المنصة بإصدارها، ومستحقات
 * المساهمين في شهر، ومشتريات المؤسسات في سنة. الأدوار كما في `x-roles`، والمعاملات بقائمة بيضاء، والرد منقّى.
 */
export async function adminRead(request: Request, path: string, api: Api, me: Me) {
  const search = new URL(request.url).searchParams;
  if (path === "users") {
    role(me, ...staffReaders); const query = parsed(() => staffQuery(search));
    const page = requireOk(await api.GET("/users", { params: { query } }));
    return json(checked(() => safeStaffPage(page)));
  }
  if (path === "tag-suggestions") {
    role(me, ...suggestionReaders); if (search.size) throw new WebError(400, "request_failed");
    const data = requireOk(await api.GET("/tag-suggestions"));
    const value = checked(() => safeSuggestions(data));
    return json(value, 200, value.version);
  }
  if (path === "tags") {
    role(me, ...tagAdmins); const query = parsed(() => tagUsageQuery(search));
    const page = requireOk(await api.GET("/tags", { params: { query } }));
    return json(safeTagUsagePage(page));
  }
  if (path === "platform-settings") {
    role(me, ...platformAdmins); if (search.size) throw new WebError(400, "request_failed");
    const data = requireOk(await api.GET("/platform-settings"));
    const value = checked(() => safePlatformSettings(data));
    return json(value, 200, value.version);
  }
  if (path === "contributor-earnings") {
    role(me, ...reportReaders); const query = parsed(() => contributorQuery(search));
    const page = requireOk(await api.GET("/contributor-earnings", { params: { query } }));
    return json(checked(() => safeContributorPage(page)));
  }
  if (path === "buyer-purchase-totals") {
    role(me, ...reportReaders); const query = parsed(() => purchaseQuery(search));
    const page = requireOk(await api.GET("/buyer-purchase-totals", { params: { query } }));
    return json(checked(() => safePurchasePage(page)));
  }
  throw new WebError(404, "request_failed");
}

/**
 * الكتابة: استبدال القائمة المقترحة وهوية المنصة بـ `If-Match` (412 يعود كما هو فيعيد المتصفح التحميل)، والدمج أو إعادة التسمية بلا
 * `If-Match` لأن الخادم يحسم الوضع في معاملته. كل طلب بمفتاح المتصفح نفسه، والجسم يُعاد بناؤه من حقول العقد وحدها.
 */
export async function adminWrite(path: string, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }, versioned: () => { "Idempotency-Key": string; "If-Match": string }) {
  if (path === "tag-suggestions") {
    role(me, ...tagAdmins); const input = suggestionsInput(body); if (!input) throw new WebError(422, "request_failed");
    const data = requireOk(await api.PUT("/tag-suggestions", { params: { header: versioned() }, body: input }));
    const value = checked(() => safeSuggestions(data));
    return json(value, 200, value.version);
  }
  if (path === "tag-rewrites") {
    role(me, ...tagAdmins); const input = rewriteInput(body); if (!input) throw new WebError(422, "request_failed");
    const data = requireOk(await api.POST("/tag-rewrites", { params: { header }, body: input }));
    return json(checked(() => safeRewrite(data)), 201);
  }
  if (path === "platform-settings") {
    role(me, ...platformAdmins); const input = platformInput(body); if (!input) throw new WebError(422, "request_failed");
    const data = requireOk(await api.PUT("/platform-settings", { params: { header: versioned() }, body: input }));
    const value = checked(() => safePlatformSettings(data));
    return json(value, 200, value.version);
  }
  throw new WebError(405, "request_failed");
}
