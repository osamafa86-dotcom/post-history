import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { schemaValidator } from '../common/contract';
import { sha256 } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { uploadForms } from '../database/schema/schema';
import type { components } from '../generated/api';
import { writeOutboxEvent } from '../outbox/outbox';
import type { UploadForm } from './dynamic-fields';

type FormVersionSummary = components['schemas']['FormVersionSummary'];

/** معرّف مجمّع ثابت للنموذج بإصداره (outbox_events.aggregate_id من نوع uuid والنموذج يُعرَّف برقم). */
export function formAggregateId(version: number): string {
  const h = sha256(`upload_form:${version}`).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** النماذج الديناميكية (ADR 0003): إصدار عام متزايد، كل إصدار لقطة كاملة غير قابلة للتعديل. */
@Injectable()
export class FormsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(): Promise<FormVersionSummary[]> {
    const rows = await this.db.select().from(uploadForms).orderBy(desc(uploadForms.version));
    return rows.map((r, i) => ({
      version: r.version,
      published_at: new Date(r.publishedAt).toISOString(),
      published_by: r.publishedBy,
      field_count: ((r.schema as UploadForm).fields ?? []).length,
      is_current: i === 0,
    }));
  }

  async publish(body: unknown, actorId: string): Promise<UploadForm> {
    // بوابة v0 أولًا برمزها الخاص، قبل مخطط العقد الذي يرفض الحقلين أيضًا برمز عام
    const fields = (body as { fields?: unknown })?.fields;
    if (Array.isArray(fields) && fields.some((f) => f?.sensitive === true || f?.type === 'location')) {
      throw new ApiError(422, 'sensitive_fields_not_supported_v0', 'Sensitive and location fields are not supported in v0.');
    }
    const validate = schemaValidator('UploadForm');
    if (!validate(body)) {
      throw ApiError.validation({ fields: [...new Set((validate.errors ?? []).map((e) => e.instancePath || '/'))] });
    }
    const form = body as UploadForm;
    const problems = structuralProblems(form);
    if (problems.length > 0) throw ApiError.validation({ fields: problems });

    return this.db.transaction(async (tx) => {
      // نشران متزامنان: الثاني ينتظر ثم يرى الإصدار الجديد فيُرفض بـ 409
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('upload_forms_publish'))`);
      const [current] = await tx
        .select({ version: uploadForms.version })
        .from(uploadForms)
        .orderBy(desc(uploadForms.version))
        .limit(1);
      const expected = (current?.version ?? 0) + 1;
      if (form.version !== expected) {
        throw new ApiError(409, 'form_version_conflict', 'Form version must be the current version + 1.', {
          expected_version: expected,
        });
      }
      const { published_at: _a, published_by: _b, ...snapshot } = form;
      const [row] = await tx
        .insert(uploadForms)
        .values({
          version: form.version,
          materialTypes: form.material_types ?? [],
          schema: snapshot,
          publishedBy: actorId,
        })
        .returning();
      await writeOutboxEvent(tx, {
        type: 'form.published',
        aggregateType: 'form',
        aggregateId: formAggregateId(form.version),
        idempotencyKey: `form.published:${form.version}`,
        actorId,
        payload: { version: form.version },
      });
      return toUploadForm(row!);
    });
  }

  async current(materialType?: string): Promise<UploadForm> {
    const [row] = await this.db.select().from(uploadForms).orderBy(desc(uploadForms.version)).limit(1);
    if (!row) throw ApiError.notFound();
    const form = toUploadForm(row);
    if (!materialType) return form;
    return { ...form, fields: form.fields.filter((f) => !f.material_types?.length || f.material_types.includes(materialType as never)) };
  }

  async byVersion(version: number, executor: Executor = this.db): Promise<UploadForm | undefined> {
    const [row] = await executor.select().from(uploadForms).where(eq(uploadForms.version, version));
    return row ? toUploadForm(row) : undefined;
  }
}

function toUploadForm(row: typeof uploadForms.$inferSelect): UploadForm {
  return {
    ...(row.schema as UploadForm),
    published_at: new Date(row.publishedAt).toISOString(),
    published_by: row.publishedBy,
  };
}

/** ما لا يعبّر عنه المخطط: مفاتيح فريدة، و`condition.field` يشير إلى حقل آخر موجود. */
export function structuralProblems(form: UploadForm): string[] {
  const problems: string[] = [];
  const keys = form.fields.map((f) => f.key);
  form.fields.forEach((f, i) => {
    if (keys.indexOf(f.key) !== i) problems.push(`/fields/${i}/key`);
    if (f.condition && (f.condition.field === f.key || !keys.includes(f.condition.field))) {
      problems.push(`/fields/${i}/condition/field`);
    }
  });
  return problems;
}
