import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { materialFiles, materials, offices } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { findScoped, iso, scopeCondition } from './material-store';

type Candidate = components['schemas']['DuplicateCandidate'];
const RANK = { sha256: 0, cheap_hash: 1, perceptual: 2 } as const;
/** متوسط مسافة هامنغ لبصمات الإطارات المتقابلة الذي يُعد عنده الأصلان متشابهين (ADR 0018). */
const PERCEPTUAL_MAX = 10;

/**
 * مرشّحو التكرار (عقد v0.2) من نطاق المستدعي وحده: الأصل نفسه (sha256)، أو الحجم وأول وآخر MiB (البصمة الرخيصة)،
 * أو تقارب بصمات الإطارات. ترشيح لا حكم: لا يغيّر حالة ولا حقًا، ولا يعيد إلا معرّفات وحالات.
 */
@Injectable()
export class DuplicatesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(p: Principal, materialId: string, limit = 20): Promise<{ items: Candidate[] }> {
    if (!(await findScoped(this.db, p, materialId))) throw ApiError.notFound();
    const sources = await this.db
      .select({
        sha256: materialFiles.sha256,
        size: materialFiles.sizeBytes,
        head: materialFiles.headSha256,
        tail: materialFiles.tailSha256,
        phash: sql<string | null>`${materialFiles.perceptualHash}::text`,
      })
      .from(materialFiles)
      .where(and(eq(materialFiles.materialId, materialId), eq(materialFiles.kind, 'original'), eq(materialFiles.state, 'verified')));
    const best = new Map<string, Candidate>();
    for (const s of sources) {
      const matches = [
        s.sha256 ? sql`${materialFiles.sha256} = ${s.sha256}` : sql`false`,
        s.size && s.head && s.tail
          ? sql`(${materialFiles.sizeBytes} = ${s.size} AND ${materialFiles.headSha256} = ${s.head} AND ${materialFiles.tailSha256} = ${s.tail})`
          : sql`false`,
      ];
      const distance = s.phash
        ? sql<number | null>`(SELECT avg(bit_count((a.h # b.h)::bit(64)))::float8
              FROM unnest(${materialFiles.perceptualHash}) WITH ORDINALITY a(h, i)
              JOIN unnest(${s.phash}::bigint[]) WITH ORDINALITY b(h, i) USING (i))`
        : sql<number | null>`NULL::float8`;
      const rows = await this.db
        .select({
          materialId: materials.id,
          fileId: materialFiles.id,
          sameSha: sql<boolean>`${matches[0]}`,
          sameCheap: sql<boolean>`${matches[1]}`,
          distance,
          editorialState: materials.editorialState,
          priority: materials.priority,
          createdAt: materials.createdAt,
        })
        .from(materialFiles)
        .innerJoin(materials, eq(materials.id, materialFiles.materialId))
        .leftJoin(offices, eq(offices.id, materials.officeId))
        .where(
          and(
            ne(materials.id, materialId),
            eq(materialFiles.kind, 'original'),
            eq(materialFiles.state, 'verified'),
            scopeCondition(p),
            s.phash
              ? sql`(${matches[0]} OR ${matches[1]} OR ${materialFiles.perceptualHash} IS NOT NULL)`
              : sql`(${matches[0]} OR ${matches[1]})`,
          ),
        );
      for (const r of rows) {
        const match = r.sameSha ? 'sha256' : r.sameCheap ? 'cheap_hash' : r.distance !== null && r.distance <= PERCEPTUAL_MAX ? 'perceptual' : null;
        if (!match) continue;
        const c: Candidate = {
          material_id: r.materialId,
          file_id: r.fileId,
          match,
          distance: match === 'perceptual' ? r.distance : null,
          editorial_state: r.editorialState as Candidate['editorial_state'],
          priority: r.priority as Candidate['priority'],
          created_at: iso(r.createdAt)!,
        };
        const prev = best.get(r.materialId);
        if (!prev || stronger(c, prev)) best.set(r.materialId, c);
      }
    }
    return { items: [...best.values()].sort((a, b) => (stronger(a, b) ? -1 : stronger(b, a) ? 1 : 0)).slice(0, limit) };
  }
}

function stronger(a: Candidate, b: Candidate): boolean {
  if (RANK[a.match] !== RANK[b.match]) return RANK[a.match] < RANK[b.match];
  return (a.distance ?? 0) < (b.distance ?? 0);
}

