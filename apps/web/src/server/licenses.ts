import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { allowedDownload, licenseDownloaders, licenseReaders, licenseStatuses, safeLicense } from "@/lib/issued-licenses";
import { requireOk, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

/** التراخيص (#203 بند 31): المشتري يرى تراخيص مؤسسته (نطاق الخادم)، والطاقم يصفّي بالمؤسسة. */
export async function licenseRead(request: Request, id: string | undefined, api: Api, me: Me) {
  if (!hasRole(me, ...licenseReaders)) throw new WebError(403, "request_failed");
  const search = new URL(request.url).searchParams;
  if (id) {
    if (!uuid.test(id) || search.size) throw new WebError(404, "request_failed");
    return json(safeLicense(requireOk(await api.GET("/licenses/{license_id}", { params: { path: { license_id: id } } }))));
  }
  if ([...search.keys()].some(key => !["status", "organization_id", "cursor", "limit"].includes(key) || search.getAll(key).length > 1)) throw new WebError(400, "request_failed");
  const status = search.get("status"), org = search.get("organization_id"), limit = search.get("limit") ?? "50", cursor = search.get("cursor");
  if ((status && !(licenseStatuses as readonly string[]).includes(status)) || (org && !uuid.test(org)) || !/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
  const page = requireOk(await api.GET("/licenses", { params: { query: { limit: +limit, ...(status ? { status: status as typeof licenseStatuses[number] } : {}), ...(org ? { organization_id: org } : {}), ...(cursor ? { cursor } : {}) } } }));
  return json({ items: page.items.map(safeLicense), next_cursor: page.next_cursor });
}

/** منحة تنزيل تُحصى في الخادم؛ الرابط يذهب إلى المتصفح وحده، لا يُسجَّل، ولا يخرج عن أصول التخزين في الإعداد. */
export async function licenseDownload(path: string, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }, config: WebConfig) {
  const match = /^licenses\/([^/]+)\/download-url$/.exec(path);
  if (!match || !uuid.test(match[1])) throw new WebError(404, "request_failed");
  if (!hasRole(me, ...licenseDownloaders)) throw new WebError(403, "request_failed");
  if (Object.keys(body).length) throw new WebError(422, "request_failed");
  const data = requireOk(await api.POST("/licenses/{license_id}/download-url", { params: { path: { license_id: match[1] }, header } }));
  if (!allowedDownload(data.url, config.mediaOrigins) || !Number.isSafeInteger(data.downloads_remaining)) throw new WebError(502, "temporarily_unavailable");
  return json({ url: data.url, expires_at: data.expires_at, downloads_remaining: data.downloads_remaining });
}
