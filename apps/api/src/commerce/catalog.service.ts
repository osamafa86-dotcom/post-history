import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { buyerOrganizations, catalogListings, licenseTemplateVersions, listingOffers, materialFiles } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { iso } from '../materials/material-store';
import { validTimestamp } from '../uploads/uploads.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { licenseTerms } from './license-templates.service';
import { sourceFileId } from './listing-store';

type CatalogItem = components['schemas']['CatalogItem'];
type CatalogOffer = components['schemas']['CatalogOffer'];
export interface CatalogQuery {
  q?: string;
  material_type?: string[];
  governorate?: string;
  shot_from?: string;
  shot_to?: string;
  min_duration_ms?: number;
  max_duration_ms?: number;
  min_height?: number;
  license_type?: string;
  exclusive_available?: boolean;
  cursor?: string;
  limit?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_TTL_SECONDS = 600;
// يوم التصوير بتوقيت المكان، بلا ساعة
const SHOT_ZONE = 'Asia/Gaza';

interface Row extends Record<string, unknown> {
  id: string;
  material_version: number;
  title_ar: string;
  title_en: string;
  description_ar: string;
  description_en: string;
  shot_list: CatalogItem['shot_list'];
  listed_at: string;
  material_types: string[];
  governorate: string;
  shot_on: string | null;
  duration_ms: string | null;
  width: number | null;
  height: number | null;
  verified_on: string | null;
  editorial_approved_on: string | null;
  editorial_approver_role: CatalogItem['editorial_approver_role'];
  exclusive_unavailable_until: string | null;
  exclusive_blocked: boolean;
}

/**
 * ما يراه المشتري (v0.3، ADR 0025): الإدراجات `listed` وحدها، بقائمة `CatalogItem` البيضاء المغلقة. الاستعلام يختار
 * أعمدة القائمة وحدها، فلا تمر إحداثيات ولا مدينة ولا ساعة ولا معرّف مراسل أو مادة ولا حقول ديناميكية حتى إلى الذاكرة.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** المشتري يقرأ الكتالوج ما دامت مؤسسته فعّالة (ADR 0025 الجزء 3)؛ المعلّقة وقيد التحقق `403 forbidden_scope`. */
  async assertReader(p: Principal): Promise<void> {
    if (!p.organizationId) return;
    const [org] = await this.db.select({ status: buyerOrganizations.status }).from(buyerOrganizations).where(eq(buyerOrganizations.id, p.organizationId));
    if (org?.status !== 'active') throw new ApiError(403, 'forbidden_scope', 'The organization cannot browse the catalog until it is active.');
  }

  async search(q: CatalogQuery): Promise<components['schemas']['CatalogPage']> {
    const limit = q.limit ?? 50;
    const where: SQL[] = [sql`l.state = 'listed'`];
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(sql`(l.title_ar ILIKE ${like} OR l.title_en ILIKE ${like} OR l.description_ar ILIKE ${like} OR l.description_en ILIKE ${like})`);
    }
    if (q.material_type?.length) where.push(sql`m.material_types && ${sql`ARRAY[${sql.join(q.material_type.map((t) => sql`${t}`), sql`, `)}]::text[]`}`);
    if (q.governorate) where.push(sql`m.governorate = ${q.governorate}`);
    if (q.shot_from) where.push(sql`(m.shot_at AT TIME ZONE ${SHOT_ZONE})::date >= ${q.shot_from}::date`);
    if (q.shot_to) where.push(sql`(m.shot_at AT TIME ZONE ${SHOT_ZONE})::date <= ${q.shot_to}::date`);
    if (q.min_duration_ms !== undefined) where.push(sql`f.duration_ms >= ${q.min_duration_ms}`);
    if (q.max_duration_ms !== undefined) where.push(sql`f.duration_ms <= ${q.max_duration_ms}`);
    if (q.min_height !== undefined) where.push(sql`f.height >= ${q.min_height}`);
    if (q.license_type) where.push(sql`EXISTS (${offerExists(sql`t.type = ${q.license_type}`)})`);
    if (q.exclusive_available !== undefined) {
      where.push(q.exclusive_available ? sql`(EXISTS (${offerExists(sql`t.type = 'exclusive_temporary'`)}) AND NOT ${exclusiveBlocked()})` : sql`(NOT EXISTS (${offerExists(sql`t.type = 'exclusive_temporary'`)}) OR ${exclusiveBlocked()})`);
    }
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push(sql`(l.listed_at, l.id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const { rows } = await this.db.execute<Row & { listed_at_raw: string }>(sql`
      ${selectItems()} WHERE ${sql.join(where, sql` AND `)}
      ORDER BY l.listed_at DESC, l.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.items(page),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.listed_at_raw, last.id])).toString('base64url') : null,
    };
  }

  /** الإدراج غير `listed` كغير الموجود (404). */
  async item(listingId: string): Promise<CatalogItem> {
    if (!UUID.test(listingId)) throw ApiError.notFound();
    const { rows } = await this.db.execute<Row>(sql`${selectItems()} WHERE l.state = 'listed' AND l.id = ${listingId}`);
    if (!rows[0]) throw ApiError.notFound();
    return (await this.items(rows))[0]!;
  }

  /** معاينة `watermarked_preview` وحدها، المشتقة من الأصل المتحقق الحالي، برابط ≤ 10 دقائق. قبل جاهزيتها 409. */
  async previewUrl(listingId: string): Promise<components['schemas']['FileDownloadUrl']> {
    if (!UUID.test(listingId) || !this.storage.presignGet) throw ApiError.notFound();
    const [listing] = await this.db
      .select({ materialId: catalogListings.materialId })
      .from(catalogListings)
      .where(and(eq(catalogListings.id, listingId), eq(catalogListings.state, 'listed')));
    if (!listing) throw ApiError.notFound();
    // المعاينة المشتقة من الأصل المتحقق الحالي وحدها: أصل أحدث بعد الإدراج يجعلها غير جاهزة حتى تُبنى من جديد
    const source = await sourceFileId(this.db, listing.materialId);
    const [preview] = source
      ? await this.db
          .select({ storageKey: materialFiles.storageKey })
          .from(materialFiles)
          .where(and(eq(materialFiles.derivedFromId, source), eq(materialFiles.kind, 'watermarked_preview'), eq(materialFiles.state, 'verified')))
          .orderBy(desc(materialFiles.verifiedAt))
          .limit(1)
      : [];
    if (!preview?.storageKey) throw new ApiError(409, 'preview_not_ready', 'The watermarked preview is not ready yet.');
    const now = new Date();
    const url = this.storage.presignGet(this.config.S3_BUCKET_MEDIA, preview.storageKey, PREVIEW_TTL_SECONDS, now);
    return { url, expires_at: new Date(now.getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString() };
  }

  private async items(rows: Row[]): Promise<CatalogItem[]> {
    const offers = await this.offers(rows.map((r) => r.id));
    return rows.map((r) => {
      const own = offers.get(r.id) ?? [];
      return {
        listing_id: r.id,
        material_version: r.material_version,
        title: { ar: r.title_ar, en: r.title_en },
        description: { ar: r.description_ar, en: r.description_en },
        shot_list: r.shot_list,
        material_types: r.material_types as CatalogItem['material_types'],
        governorate: r.governorate,
        shot_on: r.shot_on,
        duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
        width: r.width,
        height: r.height,
        // لا اسم مراسل: لا حقل لاسم نشر معتمد بعد، والاسم القانوني محمي والمستعار لا يدخل الكتالوج، فالنسب للشبكة
        credit: this.config.CATALOG_CREDIT,
        offers: own,
        // توافر الحصرية محسوب من الحجوزات والتراخيص، لا من وجود العرض وحده
        exclusive_available: own.some((o) => o.type === 'exclusive_temporary') && !r.exclusive_blocked,
        exclusive_unavailable_until: iso(r.exclusive_unavailable_until),
        verified_on: r.verified_on,
        editorial_approved_on: r.editorial_approved_on,
        editorial_approver_role: r.editorial_approver_role,
        listed_at: iso(r.listed_at)!,
      };
    });
  }

  /** العروض بالإصدار الحالي لكل قالب مفعّل، وبالسعر الخاص إن وُجد وإلا السعر الأساسي. */
  private async offers(listingIds: string[]): Promise<Map<string, CatalogOffer[]>> {
    const out = new Map<string, CatalogOffer[]>();
    if (listingIds.length === 0) return out;
    const offers = await this.db.select().from(listingOffers).where(inArray(listingOffers.listingId, listingIds));
    if (offers.length === 0) return out;
    const templates = await this.db
      .selectDistinctOn([licenseTemplateVersions.templateId])
      .from(licenseTemplateVersions)
      .where(inArray(licenseTemplateVersions.templateId, [...new Set(offers.map((o) => o.licenseTemplateId))]))
      .orderBy(licenseTemplateVersions.templateId, desc(licenseTemplateVersions.version));
    const current = new Map(templates.filter((t) => t.enabled).map((t) => [t.templateId, t]));
    for (const o of offers) {
      const t = current.get(o.licenseTemplateId);
      if (!t) continue;
      const price =
        o.priceOverrideMinor === null
          ? { amount_minor: Number(t.basePriceMinor), currency: t.currency as 'USD' | 'ILS' }
          : { amount_minor: Number(o.priceOverrideMinor), currency: o.priceOverrideCurrency as 'USD' | 'ILS' };
      const list = out.get(o.listingId) ?? [];
      list.push({ license_template_id: t.templateId, license_version: t.version, type: t.type as CatalogOffer['type'], name: { ar: t.nameAr, en: t.nameEn }, price, terms: licenseTerms(t) });
      out.set(o.listingId, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.price.amount_minor - b.price.amount_minor || (a.license_template_id < b.license_template_id ? -1 : 1));
    return out;
  }
}

/** أعمدة القائمة البيضاء وحدها، ومدة الأصل المتحقق ودقته. */
function selectItems(): SQL {
  return sql`
    SELECT l.id, l.material_version, l.title_ar, l.title_en, l.description_ar, l.description_en, l.shot_list,
           l.listed_at, l.listed_at::text AS listed_at_raw,
           m.material_types, m.governorate,
           to_char((m.shot_at AT TIME ZONE ${SHOT_ZONE})::date, 'YYYY-MM-DD') AS shot_on,
           f.duration_ms, f.width, f.height,
           to_char((f.verified_at AT TIME ZONE ${SHOT_ZONE})::date, 'YYYY-MM-DD') AS verified_on,
           to_char((publication.occurred_at AT TIME ZONE ${SHOT_ZONE})::date, 'YYYY-MM-DD') AS editorial_approved_on,
           (SELECT r.role FROM user_roles r WHERE r.user_id = publication.actor_id
             AND r.role IN ('system_admin','editor_in_chief','supervisor','producer','rights_officer')
             ORDER BY CASE r.role WHEN 'system_admin' THEN 1 WHEN 'editor_in_chief' THEN 2 WHEN 'supervisor' THEN 3 WHEN 'producer' THEN 4 ELSE 5 END LIMIT 1) AS editorial_approver_role,
           (SELECT max(h.active_until) FROM exclusive_holds h WHERE h.material_id = m.id AND h.state = 'active' AND h.active_until > now()) AS exclusive_unavailable_until,
           ${exclusiveBlocked()} AS exclusive_blocked
      FROM catalog_listings l
      JOIN materials m ON m.id = l.material_id
      LEFT JOIN LATERAL (
        SELECT duration_ms, width, height, verified_at FROM material_files
         WHERE material_id = m.id AND kind = 'original' AND state = 'verified'
         ORDER BY verified_at DESC, id DESC LIMIT 1) f ON true
      LEFT JOIN LATERAL (SELECT occurred_at, actor_id FROM outbox_events e WHERE e.aggregate_type = 'material' AND e.aggregate_id = m.id
        AND e.type = 'material.published' AND e.payload->>'material_version' = l.material_version::text
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) publication ON true`;
}

/** عرض لهذا الإدراج بقالب مفعّل في إصداره الحالي يحقق الشرط. */
function offerExists(condition: SQL): SQL {
  return sql`
    SELECT 1 FROM listing_offers o
      JOIN LATERAL (SELECT type, enabled FROM license_template_versions v WHERE v.template_id = o.license_template_id
                     ORDER BY v.version DESC LIMIT 1) t ON true
     WHERE o.listing_id = l.id AND t.enabled AND ${condition}`;
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof at === 'string' && validTimestamp(at) && typeof id === 'string' && UUID.test(id)) return { at, id };
  } catch {
    // يقع إلى 400 أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}

/** يطابق حارس الحجز في القاعدة: الحجز الجاري أو حصرية نشطة أو ترخيص لم يُبطَل يمنع حصرية جديدة. */
function exclusiveBlocked(): SQL<boolean> {
  return sql<boolean>`(EXISTS (SELECT 1 FROM exclusive_holds h WHERE h.material_id = m.id
    AND ((h.state = 'held' AND h.held_until > now()) OR (h.state = 'active' AND h.active_until > now())))
    OR EXISTS (SELECT 1 FROM licenses x WHERE x.material_id = m.id AND x.status <> 'revoked'))`;
}
