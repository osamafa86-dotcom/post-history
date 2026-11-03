import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { assertIfMatch } from '../common/preconditions';
import { DB, type Database, type Tx } from '../database/database.module';
import { auditLog, tagRewrites, tagSuggestions } from '../database/schema/schema';
import type { components } from '../generated/api';
import { writeOutboxEvent } from '../outbox/outbox';
import { decodeUsageCursor, encodeUsageCursor, rewriteMode, rewriteSuggestions, sameList } from './tag-rules';

type TagSuggestions = components['schemas']['TagSuggestions'];
type TagSuggestionsUpdate = components['schemas']['TagSuggestionsUpdate'];
type TagUsagePage = components['schemas']['TagUsagePage'];
type TagRewriteCreate = components['schemas']['TagRewriteCreate'];
type TagRewrite = components['schemas']['TagRewrite'];
type SuggestionsRow = typeof tagSuggestions.$inferSelect;

/**
 * إدارة الوسوم (ADR 0098): القائمة المقترحة للمراسلين، واستعمال كل وسم، والدمج وإعادة التسمية. كل كتابة في معاملة واحدة
 * مع حدثها في Outbox وسطر تدقيقها، وكلاهما معرّفات وأرقام بلا نص وسم (ADR 0086). قفل صف القائمة يسلسل الكتابات كلها.
 */
@Injectable()
export class TagsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async suggestions(): Promise<TagSuggestions> {
    const [row] = await this.db.select().from(tagSuggestions).where(eq(tagSuggestions.id, true));
    // الترحيل يبذر الصف؛ غيابه قائمة فارغة بالإصدار الأول
    return row ? toSuggestions(row) : { tags: [], version: 1, updated_at: new Date(0).toISOString() };
  }

  async replaceSuggestions(actorId: string, input: TagSuggestionsUpdate, ifMatch?: string): Promise<TagSuggestions> {
    return this.db.transaction(async (tx) => {
      const current = await lockSuggestions(tx);
      assertIfMatch(ifMatch, current.version);
      // القائمة نفسها لا تكتب شيئًا ولا ترفع الإصدار
      if (sameList(current.tags, input.tags)) return toSuggestions(current);
      const saved = await saveSuggestions(tx, actorId, current, input.tags);
      await tx.insert(auditLog).values({
        actorId,
        action: 'tag.suggestions_changed',
        targetType: 'tag_suggestions',
        targetId: 'tag_suggestions',
        details: { suggestions_version: saved.version },
        hash: Buffer.alloc(32), // يحسبه محفّز سلسلة التجزئة
      });
      return toSuggestions(saved);
    });
  }

  async usage(q: { q?: string; suggested?: boolean; cursor?: string; limit?: number }): Promise<TagUsagePage> {
    const limit = q.limit ?? 50;
    const conds: SQL[] = [];
    if (q.q !== undefined) conds.push(sql`strpos(lower(tag), lower(${q.q}::text)) > 0`);
    if (q.suggested === true) conds.push(sql`suggested_position IS NOT NULL`);
    if (q.suggested === false) conds.push(sql`suggested_position IS NULL`);
    if (q.cursor !== undefined) {
      const c = decodeUsageCursor(q.cursor);
      conds.push(sql`(material_count < ${c.count}::int OR (material_count = ${c.count}::int AND tag COLLATE "C" > ${c.tag}::text COLLATE "C"))`);
    }
    const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
    // العدّ على كل المواد: مدير النظام يراها كلها (scopeCondition)، فلا نطاق هنا
    const { rows } = await this.db.execute<{ tag: string; material_count: number; last_used_at: string | null; suggested_position: number | null }>(sql`
      WITH used AS (
        SELECT t AS tag, count(*)::int AS material_count, max(m.created_at) AS last_used_at
        FROM materials m CROSS JOIN LATERAL unnest(m.tags) AS t
        GROUP BY t
      ), suggested AS (
        SELECT u.t AS tag, u.ord::int AS suggested_position
        FROM tag_suggestions s CROSS JOIN LATERAL unnest(s.tags) WITH ORDINALITY AS u(t, ord)
      ), merged AS (
        SELECT coalesce(used.tag, suggested.tag) AS tag, coalesce(used.material_count, 0) AS material_count,
               used.last_used_at, suggested.suggested_position
        FROM used FULL JOIN suggested ON suggested.tag = used.tag
      )
      SELECT tag, material_count, last_used_at, suggested_position FROM merged ${where}
      ORDER BY material_count DESC, tag COLLATE "C" ASC
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        tag: r.tag,
        material_count: Number(r.material_count),
        last_used_at: r.last_used_at === null ? null : new Date(r.last_used_at).toISOString(),
        suggested_position: r.suggested_position === null ? null : Number(r.suggested_position),
      })),
      next_cursor: rows.length > limit && last ? encodeUsageCursor(Number(last.material_count), last.tag) : null,
    };
  }

  async rewrite(actorId: string, body: TagRewriteCreate): Promise<TagRewrite> {
    const { source, target } = body;
    if (source === target) throw ApiError.validation({ fields: ['/target'] });
    return this.db.transaction(async (tx) => {
      // قفل القائمة أولًا يسلسل الدمجين المتزامنين واستبدال القائمة، ثم صفوف المواد في استعلام واحد
      const list = await lockSuggestions(tx);
      const [{ used }] = (await tx.execute<{ used: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM materials WHERE tags @> ARRAY[${target}::text]) AS used`,
      )).rows as [{ used: boolean }];
      const mode = rewriteMode(used, list.tags, target);
      // target مكان source، وما تكرّر بعدها يُحذف مع إبقاء أول ظهور (rewriteTags)
      const { rows: updated } = await tx.execute<{ id: string }>(sql`
        UPDATE materials m SET tags = ARRAY(
          SELECT d.t FROM (
            SELECT DISTINCT ON (u.t) u.t, u.ord
            FROM unnest(array_replace(m.tags, ${source}::text, ${target}::text)) WITH ORDINALITY AS u(t, ord)
            ORDER BY u.t, u.ord
          ) d ORDER BY d.ord)
        WHERE m.tags @> ARRAY[${source}::text]
        RETURNING m.id`);
      const nextList = rewriteSuggestions(list.tags, source, target);
      if (updated.length === 0 && !nextList) throw ApiError.notFound();
      if (nextList) await saveSuggestions(tx, actorId, list, nextList);

      const [row] = await tx
        .insert(tagRewrites)
        .values({ source, target, mode, materialsUpdated: updated.length, createdBy: actorId })
        .returning();
      const id = row!.id;
      if (updated.length > 0) {
        await tx.execute(sql`
          INSERT INTO tag_rewrite_materials (tag_rewrite_id, material_id)
          SELECT ${id}::uuid, unnest(${`{${updated.map((r) => r.id).join(',')}}`}::uuid[])`);
      }
      await writeOutboxEvent(tx, {
        type: 'tag.rewritten',
        aggregateType: 'user',
        aggregateId: actorId,
        idempotencyKey: `tag.rewritten:${id}`,
        actorId,
        payload: { tag_rewrite_id: id, mode, materials_updated: updated.length },
      });
      await tx.insert(auditLog).values({
        actorId,
        action: 'tag.rewritten',
        targetType: 'tag_rewrite',
        targetId: id,
        details: { tag_rewrite_id: id, mode, materials_updated: updated.length },
        hash: Buffer.alloc(32),
      });
      return {
        id,
        source: row!.source,
        target: row!.target,
        mode,
        materials_updated: row!.materialsUpdated,
        created_at: new Date(row!.createdAt).toISOString(),
        created_by: row!.createdBy,
      };
    });
  }
}

async function lockSuggestions(tx: Tx): Promise<SuggestionsRow> {
  await tx.insert(tagSuggestions).values({ id: true }).onConflictDoNothing();
  const [row] = await tx.select().from(tagSuggestions).where(eq(tagSuggestions.id, true)).for('update');
  return row!;
}

/** يحفظ القائمة بإصدار جديد ويكتب حدثها (الإصدار وحده). */
async function saveSuggestions(tx: Tx, actorId: string, current: SuggestionsRow, tags: string[]): Promise<SuggestionsRow> {
  const [saved] = await tx
    .update(tagSuggestions)
    .set({ tags, version: current.version + 1, updatedBy: actorId })
    .where(eq(tagSuggestions.id, true))
    .returning();
  await writeOutboxEvent(tx, {
    type: 'tag.suggestions_changed',
    aggregateType: 'user',
    aggregateId: actorId,
    idempotencyKey: `tag.suggestions_changed:${saved!.version}`,
    actorId,
    payload: { suggestions_version: saved!.version },
  });
  return saved!;
}

function toSuggestions(row: SuggestionsRow): TagSuggestions {
  return { tags: row.tags, version: row.version, updated_at: new Date(row.updatedAt).toISOString() };
}
