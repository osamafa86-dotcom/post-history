import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { auditLog, catalogListings, licenseTemplates, licenseTemplateVersions, listingOffers } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { iso, lockMaterial } from '../materials/material-store';
import { materials } from '../database/schema/schema';
import { writeListingEvent } from './listing-store';

export type CatalogListing = components['schemas']['CatalogListing'];
export type CatalogListingInput = components['schemas']['CatalogListingInput'];
type ListingRow = typeof catalogListings.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** الإدراج بقيمة ETag: وقت آخر تحديث بالميكروثانية (لا عمود row_version في الجدول). */
export interface ListingWithTag {
  listing: CatalogListing;
  etag: string;
}

/**
 * إدراج المادة في الكتالوج (v0.3، ADR 0025): واحد لكل مادة، يثبّت إصدارها الحالي، وحالته مستقلة عن الحالات الثلاث.
 * `listed` يلزمه `rights_state = sellable` (409 rights_not_sellable). الإذن التجاري وعروضه لمدير النظام وحده.
 */
@Injectable()
export class ListingsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(p: Principal, materialId: string): Promise<ListingWithTag> {
    // أدوار الإدراج (الإدارة والحقوق ورئيس التحرير والمالية) على مستوى المؤسسة كلها؛ المالية لا تُرى لها المواد في
    // نطاق التحرير، فالبحث هنا بالمعرّف بعد حارس الدور
    if (!UUID.test(materialId)) throw ApiError.notFound();
    const [material] = await this.db.select({ id: materials.id }).from(materials).where(eq(materials.id, materialId));
    if (!material) throw ApiError.notFound();
    const [row] = await this.db.select().from(catalogListings).where(eq(catalogListings.materialId, materialId));
    if (!row) throw ApiError.notFound();
    return read(this.db, row);
  }

  async create(p: Principal, materialId: string, input: CatalogListingInput): Promise<ListingWithTag> {
    return this.db.transaction(async (tx) => {
      const material = UUID.test(materialId) ? await lockMaterial(tx, materialId) : undefined;
      if (!material) throw ApiError.notFound();
      const [existing] = await tx.select({ id: catalogListings.id }).from(catalogListings).where(eq(catalogListings.materialId, materialId));
      if (existing) throw new ApiError(409, 'listing_exists', 'This material is already listed; replace its listing instead.');
      const commercial = await checkOffers(tx, input);
      if (!hasRole(p, 'system_admin') && (input.commercial_allowed || commercial.size > 0)) throw forbiddenCommercial();
      if (input.state === 'listed' && material.rightsState !== 'sellable') throw notSellable();
      const [row] = await tx
        .insert(catalogListings)
        .values({
          materialId,
          materialVersion: material.version,
          ...stateColumns(input.state, null),
          ...textColumns(input),
          commercialAllowed: input.commercial_allowed ?? false,
          updatedBy: p.userId,
        })
        .returning();
      await writeOffers(tx, row!.id, input);
      await audited(tx, p.userId, 'catalog_listing.created', row!);
      await writeListingEvent(tx, row!, p.userId);
      return read(tx, row!);
    });
  }

  async replace(p: Principal, materialId: string, input: CatalogListingInput, ifMatch: string | undefined): Promise<ListingWithTag> {
    return this.db.transaction(async (tx) => {
      const material = UUID.test(materialId) ? await lockMaterial(tx, materialId) : undefined;
      if (!material) throw ApiError.notFound();
      const [current] = await tx.select().from(catalogListings).where(eq(catalogListings.materialId, materialId)).for('update');
      if (!current) throw ApiError.notFound();
      if (ifMatch !== undefined && ifMatch.trim() !== `"${await etagOf(tx, current)}"`) {
        throw new ApiError(412, 'precondition_failed', 'The resource has changed; read it again and retry.');
      }
      const commercial = await checkOffers(tx, input);
      if (!hasRole(p, 'system_admin')) {
        // مسؤول الحقوق يحرر الإدراج دون أن يغيّر الإذن التجاري أو مجموعة العروض التجارية
        const before = await commercialOffers(tx, current.id);
        const same = before.size === commercial.size && [...before].every((t) => commercial.has(t));
        if ((input.commercial_allowed ?? false) !== current.commercialAllowed || !same) throw forbiddenCommercial();
      }
      if (input.state === 'listed' && material.rightsState !== 'sellable') throw notSellable();
      // حذف العروض قبل سحب الإذن، وإعادة الكتابة بعد منحه، فلا يرى محفّز العرض التجاري حالة وسطى
      await tx.delete(listingOffers).where(eq(listingOffers.listingId, current.id));
      const [row] = await tx
        .update(catalogListings)
        .set({
          materialVersion: material.version,
          ...stateColumns(input.state, current),
          ...textColumns(input),
          commercialAllowed: input.commercial_allowed ?? false,
          updatedBy: p.userId,
        })
        .where(eq(catalogListings.id, current.id))
        .returning();
      await writeOffers(tx, row!.id, input);
      await audited(tx, p.userId, 'catalog_listing.replaced', row!);
      await writeListingEvent(tx, row!, p.userId);
      return read(tx, row!);
    });
  }
}

/**
 * القالب مرة واحدة على الأكثر، وموجود ومفعّل في إصداره الحالي، والعرض التجاري يلزمه الإذن: كلها 422 على /offers. يعيد
 * قوالب العروض التجارية.
 */
async function checkOffers(tx: Tx, input: CatalogListingInput): Promise<Set<string>> {
  const ids = input.offers.map((o) => o.license_template_id);
  if (new Set(ids).size !== ids.length) throw ApiError.validation({ fields: ['/offers'] });
  const current = await tx
    .selectDistinctOn([licenseTemplateVersions.templateId], { id: licenseTemplateVersions.templateId, type: licenseTemplateVersions.type, enabled: licenseTemplateVersions.enabled })
    .from(licenseTemplateVersions)
    .where(inArray(licenseTemplateVersions.templateId, ids))
    .orderBy(licenseTemplateVersions.templateId, sql`${licenseTemplateVersions.version} DESC`);
  if (current.length !== ids.length || current.some((t) => !t.enabled)) throw ApiError.validation({ fields: ['/offers'] });
  const commercial = new Set(current.filter((t) => t.type === 'commercial').map((t) => t.id));
  if (commercial.size > 0 && !input.commercial_allowed) throw ApiError.validation({ fields: ['/offers'] });
  return commercial;
}

async function commercialOffers(tx: Tx, listingId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ id: listingOffers.licenseTemplateId })
    .from(listingOffers)
    .innerJoin(licenseTemplates, eq(licenseTemplates.id, listingOffers.licenseTemplateId))
    .where(sql`${listingOffers.listingId} = ${listingId} AND ${licenseTemplates.type} = 'commercial'`);
  return new Set(rows.map((r) => r.id));
}

async function writeOffers(tx: Tx, listingId: string, input: CatalogListingInput): Promise<void> {
  await tx.insert(listingOffers).values(
    input.offers.map((o) => ({
      listingId,
      licenseTemplateId: o.license_template_id,
      priceOverrideMinor: o.price_override?.amount_minor ?? null,
      priceOverrideCurrency: o.price_override?.currency ?? null,
    })),
  );
}

/** suspended بطلب = manual، إلا إن كان معلّقًا بسبب الحقوق فيبقى سببه. listed_at أول انتقال إلى listed ولا يتغير بعده. */
function stateColumns(state: CatalogListingInput['state'], current: ListingRow | null): Pick<typeof catalogListings.$inferInsert, 'state' | 'suspendedReason' | 'listedAt'> {
  const reason = state !== 'suspended' ? null : current?.state === 'suspended' ? current.suspendedReason : 'manual';
  const listedAt = current?.listedAt ?? (state === 'listed' ? (sql`now()` as never) : null);
  return { state, suspendedReason: reason, listedAt };
}

function textColumns(input: CatalogListingInput): Pick<typeof catalogListings.$inferInsert, 'titleAr' | 'titleEn' | 'descriptionAr' | 'descriptionEn' | 'shotList'> {
  return {
    titleAr: input.title.ar,
    titleEn: input.title.en,
    descriptionAr: input.description.ar,
    descriptionEn: input.description.en,
    shotList: input.shot_list ?? [],
  };
}

async function etagOf(executor: Executor, row: ListingRow): Promise<string> {
  const { rows } = await executor.execute<{ tag: string }>(
    sql`SELECT (extract(epoch FROM ${catalogListings.updatedAt}) * 1000000)::bigint::text AS tag FROM ${catalogListings} WHERE ${catalogListings.id} = ${row.id}`,
  );
  return rows[0]!.tag;
}

async function read(executor: Executor, row: ListingRow): Promise<ListingWithTag> {
  const offers = await executor.select().from(listingOffers).where(eq(listingOffers.listingId, row.id));
  const listing: CatalogListing = {
    id: row.id,
    material_id: row.materialId,
    material_version: row.materialVersion,
    title: { ar: row.titleAr, en: row.titleEn },
    description: { ar: row.descriptionAr, en: row.descriptionEn },
    shot_list: row.shotList as CatalogListing['shot_list'],
    offers: offers
      .sort((a, b) => (a.licenseTemplateId < b.licenseTemplateId ? -1 : 1))
      .map((o) => ({
        license_template_id: o.licenseTemplateId,
        price_override: o.priceOverrideMinor === null ? null : { amount_minor: Number(o.priceOverrideMinor), currency: o.priceOverrideCurrency as 'USD' | 'ILS' },
      })),
    commercial_allowed: row.commercialAllowed,
    state: row.state as CatalogListing['state'],
    suspended_reason: row.suspendedReason as CatalogListing['suspended_reason'],
    listed_at: iso(row.listedAt),
    created_at: iso(row.createdAt)!,
    updated_at: iso(row.updatedAt)!,
    updated_by: row.updatedBy,
  };
  return { listing, etag: await etagOf(executor, row) };
}

async function audited(tx: Tx, actorId: string, action: string, row: ListingRow): Promise<void> {
  await tx.insert(auditLog).values({
    actorId,
    action,
    targetType: 'catalog_listing',
    targetId: row.id,
    details: { listing_id: row.id, material_id: row.materialId },
    hash: Buffer.alloc(32),
  });
}

const notSellable = () => new ApiError(409, 'rights_not_sellable', 'A listed material must have sellable rights.');
const forbiddenCommercial = () => new ApiError(403, 'forbidden_role', 'Only a system admin may set commercial permission or commercial offers.');
