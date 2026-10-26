import { Controller, Get, Header, HttpCode, Inject, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Database, type Executor } from '../database/database.module';
import { buyerOrganizations, licenseDownloadGrants, licenseTemplateVersions, licenses, materialFiles, orderItems } from '../database/schema/schema';
import type { components } from '../generated/api';
import { type Principal, Roles } from '../identity/principal';
import { iso } from '../materials/material-store';
import { validTimestamp } from '../uploads/uploads.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { toDto as templateDto } from './license-templates.service';
import type { Currency } from './money';

type License = components['schemas']['License'];
type LicenseDownloadUrl = components['schemas']['LicenseDownloadUrl'];
type LicenseStatus = components['schemas']['LicenseStatus'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUYER_ROLES = ['buyer_admin', 'buyer_member'] as const;

const isBuyer = (p: Principal) => p.roles.some((r) => (BUYER_ROLES as readonly string[]).includes(r.role));
/** المشتري يرى تراخيص مؤسسته وحدها (العضو والمدير سواء)؛ الطاقم الكل. */
const scope = (p: Principal) => (isBuyer(p) ? eq(licenses.organizationId, p.organizationId ?? '00000000-0000-0000-0000-000000000000') : undefined);

/**
 * التراخيص الصادرة ورابط تنزيل حزمتها (العقد #303، ADR 0025 الجزءان 4 و9). الرابط موقّع قصير العمر
 * (LICENSE_DOWNLOAD_URL_SECONDS)، لا يُخزَّن في القاعدة (المنحة وحدها سجل) ولا في جدول منع التكرار (withoutTokens يحذف
 * `url`) ولا يُسجَّل. كل منحة تُحصى بقفل صف الترخيص حتى LICENSE_DOWNLOAD_LIMIT.
 */
@Injectable()
export class LicensesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async list(p: Principal, q: { status?: LicenseStatus; organization_id?: string; cursor?: string; limit?: number }): Promise<components['schemas']['LicensePage']> {
    const limit = q.limit ?? 50;
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db
      .select({ id: licenses.id, at: sql<string>`${licenses.issuedAt}::text` })
      .from(licenses)
      .where(
        and(
          scope(p),
          !isBuyer(p) && q.organization_id ? eq(licenses.organizationId, q.organization_id) : undefined,
          q.status ? eq(licenses.status, q.status) : undefined,
          after ? sql`(${licenses.issuedAt}, ${licenses.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(licenses.issuedAt), desc(licenses.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await Promise.all(page.map((r) => read(this.db, r.id))),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.at, last.id])).toString('base64url') : null,
    };
  }

  async get(p: Principal, id: string): Promise<License> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [l] = await this.db.select({ id: licenses.id }).from(licenses).where(and(eq(licenses.id, id), scope(p)));
    if (!l) throw ApiError.notFound();
    return read(this.db, id);
  }

  async downloadUrl(p: Principal, id: string): Promise<LicenseDownloadUrl> {
    if (!UUID.test(id) || !this.storage.presignGet) throw ApiError.notFound();
    const ttl = this.config.LICENSE_DOWNLOAD_URL_SECONDS;
    const max = this.config.LICENSE_DOWNLOAD_LIMIT;
    const granted = await this.db.transaction(async (tx) => {
      // قفل صف الترخيص يسلسل المنح، فلا يتجاوز طلبان متزامنان الحد
      const [l] = await tx.select().from(licenses).where(and(eq(licenses.id, id), scope(p))).for('update');
      if (!l) throw ApiError.notFound();
      const [org] = await tx.select({ status: buyerOrganizations.status }).from(buyerOrganizations).where(eq(buyerOrganizations.id, l.organizationId));
      if (org?.status !== 'active') throw new ApiError(403, 'forbidden_scope', 'The organization cannot download until it is active.');
      const lapsed = l.validUntil !== null && Date.parse(iso(l.validUntil)!) <= Date.now();
      if (l.status !== 'active' || lapsed) throw new ApiError(409, 'license_not_active', 'The license is not active.');
      const [file] = await tx
        .select({ storageKey: materialFiles.storageKey })
        .from(materialFiles)
        .where(and(eq(materialFiles.licenseId, l.id), eq(materialFiles.kind, 'delivery'), eq(materialFiles.state, 'verified')))
        .orderBy(desc(materialFiles.verifiedAt))
        .limit(1);
      if (!file?.storageKey) throw new ApiError(409, 'delivery_not_ready', 'The delivery package is not ready yet.');
      const [{ n }] = (await tx.select({ n: count() }).from(licenseDownloadGrants).where(eq(licenseDownloadGrants.licenseId, l.id))) as [{ n: number }];
      if (Number(n) >= max) throw new ApiError(409, 'download_limit_reached', 'The download limit of this license is reached.');
      const [grant] = await tx
        .insert(licenseDownloadGrants)
        .values({ licenseId: l.id, issuedTo: p.userId, expiresAt: sql`now() + make_interval(secs => ${ttl})` })
        .returning({ expiresAt: licenseDownloadGrants.expiresAt });
      return { storageKey: file.storageKey, expiresAt: iso(grant!.expiresAt)!, remaining: max - Number(n) - 1 };
    });
    const url = this.storage.presignGet(this.config.S3_BUCKET_MEDIA, granted.storageKey, ttl);
    return { url, expires_at: granted.expiresAt, downloads_remaining: granted.remaining };
  }
}

async function read(executor: Executor, id: string): Promise<License> {
  const [r] = await executor
    .select({ l: licenses, item: orderItems, v: licenseTemplateVersions })
    .from(licenses)
    .innerJoin(orderItems, eq(orderItems.id, licenses.orderItemId))
    .innerJoin(licenseTemplateVersions, and(eq(licenseTemplateVersions.templateId, orderItems.licenseTemplateId), eq(licenseTemplateVersions.version, orderItems.licenseVersion)))
    .where(eq(licenses.id, id));
  const { l, item, v } = r!;
  const [ready] = await executor
    .select({ id: materialFiles.id })
    .from(materialFiles)
    .where(and(eq(materialFiles.licenseId, l.id), eq(materialFiles.kind, 'delivery'), eq(materialFiles.state, 'verified')))
    .limit(1);
  const t = templateDto(v);
  return {
    id: l.id,
    license_number: l.licenseNumber,
    order_id: item.orderId,
    order_item_id: item.id,
    organization_id: l.organizationId,
    listing_id: item.listingId,
    material_version: item.materialVersion,
    title: { ar: item.titleAr, en: item.titleEn },
    license_template_id: item.licenseTemplateId,
    license_version: item.licenseVersion,
    terms: {
      type: t.type,
      name: t.name,
      terms: t.terms,
      usage_media: t.usage_media,
      territory: t.territory,
      term_days: t.term_days ?? null,
      exclusivity_hours: t.exclusivity_hours ?? null,
      deliverables: t.deliverables,
      attribution: t.attribution,
      prohibitions: t.prohibitions,
    },
    price: { amount_minor: item.priceMinor, currency: item.currency as Currency },
    status: l.status as LicenseStatus,
    revoked_reason: l.revokedReason as License['revoked_reason'],
    valid_from: iso(l.validFrom)!,
    valid_until: iso(l.validUntil),
    exclusive_until: iso(l.exclusiveUntil),
    issued_at: iso(l.issuedAt)!,
    delivery_ready: !!ready,
  };
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

@Controller('licenses')
export class LicensesController {
  constructor(private readonly licensesService: LicensesService) {}

  @Get()
  @Roles('system_admin', 'finance', 'rights_officer', 'buyer_admin', 'buyer_member')
  list(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<components['schemas']['LicensePage']> {
    return this.licensesService.list(req.principal!, validateQuery('/licenses', 'get', query));
  }

  @Get(':licenseId')
  @Roles('system_admin', 'finance', 'rights_officer', 'buyer_admin', 'buyer_member')
  get(@Param('licenseId') id: string, @Req() req: Request): Promise<License> {
    return this.licensesService.get(req.principal!, id);
  }

  @Post(':licenseId/download-url')
  @Roles('buyer_admin', 'buyer_member')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  downloadUrl(@Param('licenseId') id: string, @Req() req: Request): Promise<LicenseDownloadUrl> {
    return this.licensesService.downloadUrl(req.principal!, id);
  }
}
