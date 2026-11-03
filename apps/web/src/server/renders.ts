import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { renderDetails, renderInput, renderRoles, safeRender } from "@/lib/render-policy";
import { requireOk, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";
import { checkLink } from "./media";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

function allowed(me: Me, materialId: string) {
  if (!uuid.test(materialId)) throw new WebError(404, "request_failed");
  if (!hasRole(me, ...renderRoles)) throw new WebError(403, "request_failed");
}

/** رموز النسخة الثلاثة تمرّ برمزها، و`render_not_allowed` بتفاصيله الآلية المنقّاة؛ وما عداها كما في `requireOk`. */
function renderOk<T>(result: { data?: T; error?: unknown; response: Response }): T {
  const status = result.response.status, error = result.error && typeof result.error === "object" ? result.error as { code?: unknown; details?: unknown } : {};
  if (status === 409 && error.code === "render_not_allowed") throw new WebError(409, "render_not_allowed", renderDetails(error.details));
  if (status === 409 && error.code === "render_limit_reached") throw new WebError(409, "render_limit_reached");
  if (status === 422 && error.code === "render_location_unusable") throw new WebError(422, "render_location_unusable");
  return requireOk(result);
}

/** نسخ المادة (ADR 0091): لأدوار الطلب وحدها؛ والعلم المطفأ عند الخادم `404`، فتُخفي الواجهة كل شيء. */
export async function renderRead(request: Request, materialId: string, api: Api, me: Me) {
  allowed(me, materialId);
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  const result = await api.GET("/materials/{id}/renders", { params: { path: { id: materialId } } });
  // العلم المطفأ عند الخادم 404: حالة لا خطأ، فتصل المتصفح 204 بلا جسم (لا «فشل تحميل مورد» في وحدة التحكم) وتخفي الواجهة البطاقة.
  if (result.response.status === 404) return new NextResponse(null, { status: 204, headers: privateHeaders });
  const page = requireOk(result);
  return json({ items: page.items.map(safeRender).filter(item => item !== null) });
}

/** الطلب بالمفتاح الذي أرسله المتصفح؛ الجسم يُعاد بناؤه من الحقول الخمسة، ولا نص مكان أبدًا. */
export async function renderWrite(materialId: string, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }) {
  allowed(me, materialId);
  const input = renderInput(body);
  if (!input) throw new WebError(422, "request_failed");
  const render = safeRender(renderOk(await api.POST("/materials/{id}/renders", { params: { path: { id: materialId }, header }, body: input })));
  if (!render) throw new WebError(502, "temporarily_unavailable");
  return json(render, 202);
}

/**
 * رابط التنزيل الداخلي المدقَّق لنسخة جاهزة وحدها: يُطلب عند النقر ولا يُخزَّن، ومن أصول التخزين في الإعداد وبعمر ≤ 10 دقائق.
 * الملف يجب أن يكون `file_id` نسخة جاهزة لهذه المادة، فلا يصير المسار بابًا لروابط مشتقات أخرى.
 */
export async function renderDownload(request: Request, materialId: string, fileId: string, api: Api, me: Me, config: WebConfig) {
  allowed(me, materialId);
  if (!uuid.test(fileId)) throw new WebError(404, "request_failed");
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  const page = requireOk(await api.GET("/materials/{id}/renders", { params: { path: { id: materialId }, query: { limit: 50 } } }));
  if (!page.items.some(item => item.state === "ready" && item.file_id === fileId)) throw new WebError(404, "request_failed");
  const link = checkLink(renderOk(await api.GET("/materials/{id}/files/{file_id}/download-url", { params: { path: { id: materialId, file_id: fileId } } })), config);
  return json({ url: link.url, expires_at: link.expires_at });
}
