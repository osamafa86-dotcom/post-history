import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { assertIfMatch } from '../common/preconditions';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { auditLog, licenseTemplates, licenseTemplateVersions } from '../database/schema/schema';
import type { components } from '../generated/api';
import { iso } from '../materials/material-store';

export type LicenseTemplate = components['schemas']['LicenseTemplate'];
export type LicenseTemplateInput = components['schemas']['LicenseTemplateInput'];
type VersionRow = typeof licenseTemplateVersions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** المدة إلزامية لهذين؛ والحصرية لـ exclusive_temporary وحده (قيود القاعدة نفسها، تُرد هنا 422 بمسار الحقل). */
const TERM_REQUIRED: ReadonlySet<string> = new Set(['editorial_term', 'exclusive_temporary']);

/**
 * قوالب التراخيص (v0.3، ADR 0025): كل إصدار سجل لا يُعدَّل، والاستبدال يكتب إصدارًا يليه، والنوع ثابت. البيعة تجمّد
 * الإصدار الذي وافق عليه المشتري، والكتالوج يتبع الإصدار الحالي. ETag هو رقم الإصدار الحالي.
 */
@Injectable()
export class LicenseTemplatesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(includeDisabled: boolean): Promise<{ items: LicenseTemplate[] }> {
    // الإصدار الحالي لكل قالب في مسح واحد، بترتيب إنشاء القالب
    const current = await this.db
      .selectDistinctOn([licenseTemplateVersions.templateId], { v: licenseTemplateVersions, createdAt: licenseTemplates.createdAt })
      .from(licenseTemplateVersions)
      .innerJoin(licenseTemplates, eq(licenseTemplates.id, licenseTemplateVersions.templateId))
      .orderBy(licenseTemplateVersions.templateId, desc(licenseTemplateVersions.version));
    const items = current
      .filter((r) => includeDisabled || r.v.enabled)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.v.templateId < b.v.templateId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .map((r) => toDto(r.v));
    return { items };
  }

  async get(id: string, version?: number): Promise<LicenseTemplate> {
    if (!UUID.test(id)) throw ApiError.notFound();
    return read(this.db, id, version);
  }

  async create(actorId: string, input: LicenseTemplateInput): Promise<LicenseTemplate> {
    check(input);
    return this.db.transaction(async (tx) => {
      const [template] = await tx.insert(licenseTemplates).values({ type: input.type, createdBy: actorId }).returning({ id: licenseTemplates.id });
      await tx.insert(licenseTemplateVersions).values(columns(template!.id, 1, input, actorId));
      await audited(tx, actorId, 'license_template.created', template!.id, 1);
      return read(tx, template!.id);
    });
  }

  async replace(actorId: string, id: string, input: LicenseTemplateInput, ifMatch: string | undefined): Promise<LicenseTemplate> {
    if (!UUID.test(id)) throw ApiError.notFound();
    check(input);
    return this.db.transaction(async (tx) => {
      // القفل على القالب يسلسل الإصدارات: إصداران متزامنان لا يأخذان الرقم نفسه
      const [template] = await tx.select().from(licenseTemplates).where(eq(licenseTemplates.id, id)).for('update');
      if (!template) throw ApiError.notFound();
      const [last] = await tx
        .select({ version: licenseTemplateVersions.version })
        .from(licenseTemplateVersions)
        .where(eq(licenseTemplateVersions.templateId, id))
        .orderBy(desc(licenseTemplateVersions.version))
        .limit(1);
      assertIfMatch(ifMatch, last!.version);
      if (input.type !== template.type) throw ApiError.validation({ fields: ['/type'] });
      const next = last!.version + 1;
      await tx.insert(licenseTemplateVersions).values(columns(id, next, input, actorId));
      await audited(tx, actorId, 'license_template.version_created', id, next);
      return read(tx, id);
    });
  }
}

/** ما يقوله المخطط شرطًا بين الحقول ولا تقوله JSON Schema: الإقليم، والمدة، والحصرية. */
function check(input: LicenseTemplateInput): void {
  const fields: string[] = [];
  const countries = input.territory.countries;
  if (input.territory.kind === 'countries' ? !countries?.length : countries !== undefined) fields.push('/territory/countries');
  if (TERM_REQUIRED.has(input.type) && (input.term_days === undefined || input.term_days === null)) fields.push('/term_days');
  const exclusive = input.type === 'exclusive_temporary';
  const hours = input.exclusivity_hours ?? null;
  if (exclusive ? hours === null : hours !== null) fields.push('/exclusivity_hours');
  if (fields.length > 0) throw ApiError.validation({ fields });
}

function columns(templateId: string, version: number, input: LicenseTemplateInput, actorId: string): typeof licenseTemplateVersions.$inferInsert {
  return {
    templateId,
    version,
    type: input.type,
    nameAr: input.name.ar,
    nameEn: input.name.en,
    termsAr: input.terms.ar,
    termsEn: input.terms.en,
    usageMedia: input.usage_media,
    territoryKind: input.territory.kind,
    territoryCountries: input.territory.kind === 'countries' ? input.territory.countries! : null,
    termDays: input.term_days ?? null,
    exclusivityHours: input.exclusivity_hours ?? null,
    deliverables: input.deliverables,
    attributionAr: input.attribution.ar,
    attributionEn: input.attribution.en,
    prohibitions: input.prohibitions,
    basePriceMinor: input.base_price.amount_minor,
    currency: input.base_price.currency,
    enabled: input.enabled,
    createdBy: actorId,
  };
}

async function read(executor: Executor, id: string, version?: number): Promise<LicenseTemplate> {
  const [row] = await executor
    .select()
    .from(licenseTemplateVersions)
    .where(version === undefined ? eq(licenseTemplateVersions.templateId, id) : and(eq(licenseTemplateVersions.templateId, id), eq(licenseTemplateVersions.version, version)))
    .orderBy(desc(licenseTemplateVersions.version))
    .limit(1);
  if (!row) throw ApiError.notFound();
  return toDto(row);
}

export function toDto(v: VersionRow): LicenseTemplate {
  return {
    id: v.templateId,
    version: v.version,
    type: v.type as LicenseTemplate['type'],
    name: { ar: v.nameAr, en: v.nameEn },
    terms: { ar: v.termsAr, en: v.termsEn },
    usage_media: v.usageMedia as LicenseTemplate['usage_media'],
    territory: v.territoryKind === 'countries' ? { kind: 'countries', countries: v.territoryCountries ?? [] } : { kind: 'worldwide' },
    term_days: v.termDays,
    exclusivity_hours: v.exclusivityHours,
    deliverables: v.deliverables as LicenseTemplate['deliverables'],
    attribution: { ar: v.attributionAr, en: v.attributionEn },
    prohibitions: v.prohibitions as LicenseTemplate['prohibitions'],
    base_price: { amount_minor: Number(v.basePriceMinor), currency: v.currency as LicenseTemplate['base_price']['currency'] },
    enabled: v.enabled,
    created_at: iso(v.createdAt)!,
    created_by: v.createdBy,
  };
}

async function audited(tx: Tx, actorId: string, action: string, templateId: string, version: number): Promise<void> {
  await tx.insert(auditLog).values({
    actorId,
    action,
    targetType: 'license_template',
    targetId: templateId,
    details: { license_template_id: templateId, license_version: version },
    hash: Buffer.alloc(32),
  });
}

/** قائمة شروط بيضاء مشتركة قبل الشراء وبعده؛ بلا معرّفات داخلية أو أسماء عمل. */
export function licenseTerms(v: VersionRow): components['schemas']['LicenseTerms'] {
  const t = toDto(v);
  return { type: t.type, name: t.name, terms: t.terms, usage_media: t.usage_media, territory: t.territory,
    term_days: t.term_days ?? null, exclusivity_hours: t.exclusivity_hours ?? null,
    deliverables: t.deliverables, attribution: t.attribution, prohibitions: t.prohibitions };
}
