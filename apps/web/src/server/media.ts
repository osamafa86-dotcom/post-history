import { NextResponse } from "next/server";
import type { components } from "@/generated/schema";
import { requireOk, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";

export async function getDerivativeUrl(api: Api, config: WebConfig, materialId: string, fileId: string) {
  const material = requireOk(await api.GET("/materials/{id}", { params: { path: { id: materialId } } }));
  const file = material.files.find(file => file.id === fileId && file.state === "verified" && (file.kind === "proxy" || file.kind === "thumbnail"));
  if (!file) throw new WebError(404, "request_failed");
  const link: components["schemas"]["FileDownloadUrl"] = requireOk(await api.GET("/materials/{id}/files/{file_id}/download-url", { params: { path: { id: materialId, file_id: fileId } } }));
  const url = new URL(link.url), remaining = Date.parse(link.expires_at) - Date.now();
  if (!config.mediaOrigins.includes(url.origin) || url.username || url.password || url.hash || !Number.isFinite(remaining) || remaining <= 0 || remaining > 600000) throw new WebError(503, "temporarily_unavailable");
  return { file, link };
}

export async function streamDerivative(request: Request, api: Api, config: WebConfig, materialId: string, fileId: string, transport: typeof fetch = fetch) {
  const range = request.headers.get("range");
  if (range && !/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(range)) throw new WebError(416, "request_failed");
  const { file, link } = await getDerivativeUrl(api, config, materialId, fileId);
  const controller = new AbortController();
  // مهلة الوصول إلى الترويسات لا تبقي قفل الجلسة طويلًا؛ نقل الجسم ينتهي خارجه.
  const headerTimer = setTimeout(() => controller.abort(), 8000);
  const transferTimer = setTimeout(() => controller.abort(), 120000);
  const cleanup = () => { clearTimeout(headerTimer); clearTimeout(transferTimer); };
  try {
    const response = await transport(new Request(link.url, { cache: "no-store", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.any([request.signal, controller.signal]), headers: range ? { Range: range } : {} }));
    clearTimeout(headerTimer);
    const mime = response.headers.get("content-type")?.split(";")[0].trim();
    const allowed = file.kind === "proxy" ? mime === "video/mp4" : ["image/jpeg", "image/png", "image/webp"].includes(mime ?? "");
    if (![200, 206].includes(response.status) || !allowed || !response.body) {
      // قد ينتظر cancel اكتمال فرع آخر من استجابة fetch المنسوخة في Next؛ لا يحجز الجلسة.
      controller.abort(); void response.body?.cancel().catch(() => {});
      throw new WebError(response.status === 416 ? 416 : 503, "temporarily_unavailable");
    }
    const headers = new Headers({ "Content-Type": mime!, "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
    for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) { const value = response.headers.get(name); if (value) headers.set(name, value); }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(target) {
        try { const { value, done } = await reader.read(); if (done) { cleanup(); target.close(); } else target.enqueue(value); }
        catch { cleanup(); target.error(new Error("Media unavailable")); }
      },
      async cancel() { cleanup(); controller.abort(); await reader.cancel().catch(() => {}); },
    });
    return new NextResponse(stream, { status: response.status, headers });
  } catch (error) {
    cleanup(); controller.abort();
    throw error instanceof WebError ? error : new WebError(503, "temporarily_unavailable");
  }
}
