import { NextResponse } from "next/server";
import type { components, operations } from "@/generated/schema";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { materialTypes, uuid } from "@/lib/query";
import { requireOk, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";
import { checkLink, streamSigned } from "./media";

type CatalogItem = components["schemas"]["CatalogItem"];
type Query = NonNullable<operations["searchCatalog"]["parameters"]["query"]>;
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown) => NextResponse.json(value, { headers: privateHeaders });

// أدوار الكتالوج في `x-roles` لعقد v0.3 (#178)؛ أدوار المشترين تُضاف مع حسابات المؤسسات (#192). يطابقها contract-drift.
// أدوار المشترين (#192) تتصفح الكتالوج كما في x-roles.
export const catalogRoles = ["system_admin", "rights_officer", "editor_in_chief", "finance", "buyer_admin", "buyer_member"] as const;
export const licenseTypes = ["editorial_single", "editorial_term", "exclusive_temporary", "commercial"] as const;
const date = /^\d{4}-\d{2}-\d{2}$/, int = /^\d{1,12}$/;

export function catalogQuery(search: URLSearchParams): Query {
  const allowed = ["q", "material_type", "governorate", "shot_from", "shot_to", "min_duration_ms", "max_duration_ms", "min_height", "license_type", "exclusive_available", "cursor", "limit"];
  if ([...search.keys()].some(key => !allowed.includes(key) || (key !== "material_type" && search.getAll(key).length > 1))) throw new WebError(400, "request_failed");
  const query: Query = {}, get = (key: string) => search.get(key) ?? undefined;
  const q = get("q"), governorate = get("governorate"), types = search.getAll("material_type");
  if (q !== undefined) { if (!q.trim() || Array.from(q).length > 200) throw new WebError(400, "request_failed"); query.q = q; }
  if (governorate !== undefined) { if (!governorate || governorate.length > 64) throw new WebError(400, "request_failed"); query.governorate = governorate; }
  if (types.length) { if (types.length > 8 || types.some(t => !(materialTypes as readonly string[]).includes(t))) throw new WebError(400, "request_failed"); query.material_type = types as Query["material_type"]; }
  for (const key of ["shot_from", "shot_to"] as const) { const v = get(key); if (v !== undefined) { if (!date.test(v)) throw new WebError(400, "request_failed"); query[key] = v; } }
  for (const key of ["min_duration_ms", "max_duration_ms", "min_height"] as const) { const v = get(key); if (v !== undefined) { if (!int.test(v) || (key === "min_height" && +v < 1)) throw new WebError(400, "request_failed"); query[key] = +v; } }
  const license = get("license_type"); if (license !== undefined) { if (!(licenseTypes as readonly string[]).includes(license)) throw new WebError(400, "request_failed"); query.license_type = license as Query["license_type"]; }
  const exclusive = get("exclusive_available"); if (exclusive !== undefined) { if (!["true", "false"].includes(exclusive)) throw new WebError(400, "request_failed"); query.exclusive_available = exclusive === "true"; }
  const limit = get("limit") ?? "24", cursor = get("cursor");
  if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
  return { ...query, limit: +limit, ...(cursor ? { cursor } : {}) };
}

/** عرض المشتري بقائمة بيضاء مغلقة (العقد additionalProperties: false)، ويوم التصوير بلا ساعة. قائمة اللقطات للمحرر وحده ولا تصل المتجر (قرار الأمن، #385). */
export function safeCatalogItem(item: CatalogItem): CatalogItem {
  const text = (t: CatalogItem["title"]) => ({ ar: t.ar, en: t.en });
  return {
    listing_id: item.listing_id, material_version: item.material_version, title: text(item.title), description: text(item.description),
    shot_list: [], material_types: item.material_types, governorate: item.governorate,
    shot_on: item.shot_on && /^\d{4}-\d{2}-\d{2}/.exec(item.shot_on)?.[0] || null, duration_ms: item.duration_ms, width: item.width, height: item.height, credit: item.credit,
    offers: item.offers.map(o => ({ license_template_id: o.license_template_id, license_version: o.license_version, type: o.type, name: text(o.name), price: { amount_minor: o.price.amount_minor, currency: o.price.currency } })),
    exclusive_available: item.exclusive_available, listed_at: item.listed_at,
  };
}

export async function catalogRead(request: Request, path: string, api: Api, me: Me, config: WebConfig, transport?: typeof fetch) {
  if (!hasRole(me, ...catalogRoles)) throw new WebError(403, "request_failed");
  const search = new URL(request.url).searchParams;
  if (path === "catalog") {
    const page = requireOk(await api.GET("/catalog", { params: { query: catalogQuery(search) } }));
    return json({ items: page.items.map(safeCatalogItem), next_cursor: page.next_cursor });
  }
  const match = /^catalog\/([^/]+)(\/preview)?$/.exec(path);
  if (!match || !uuid.test(match[1]) || [...search.keys()].length) throw new WebError(404, "request_failed");
  if (!match[2]) return json(safeCatalogItem(requireOk(await api.GET("/catalog/{listing_id}", { params: { path: { listing_id: match[1] } } }))));
  // المعاينة بعلامة مائية تُبث من الأصل نفسه؛ الرابط الموقّع لا يصل إلى المتصفح.
  const link = checkLink(requireOk(await api.GET("/catalog/{listing_id}/preview-url", { params: { path: { listing_id: match[1] } } })), config);
  return streamSigned(request, link, ["video/mp4"], transport);
}
