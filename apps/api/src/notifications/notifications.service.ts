import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { notifications } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { applyTransition, iso, lockMaterial, roleCovers } from '../materials/material-store';

type Notification = components['schemas']['Notification'];
type NotificationPage = components['schemas']['NotificationPage'];

const INCOMING = ['material.created', 'material.urgent_received'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** صندوق الوارد: الإشعار يبقى فيه مهما حدث لقنوات الهاتف. كل مستخدم يرى إشعاراته فقط (غيرها 404). */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(userId: string, q: { unread_only?: boolean; cursor?: string; limit?: number }): Promise<NotificationPage> {
    const limit = q.limit ?? 50;
    const where: SQL[] = [eq(notifications.userId, userId)];
    if (q.unread_only) where.push(isNull(notifications.readAt));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push(sql`(${notifications.createdAt}, ${notifications.id}) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(...where))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);
    const [unread] = await this.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null,
      unread_count: unread?.n ?? 0,
    };
  }

  /** «قُرئ»: ذاتي التكرار؛ لا يتراجع عن «أقرّ الاستلام». */
  async read(userId: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [row] = await this.db
      .update(notifications)
      .set({
        readAt: sql`COALESCE(${notifications.readAt}, now())`,
        state: sql`CASE WHEN ${notifications.state} = 'acknowledged' THEN 'acknowledged' ELSE 'read' END`,
      })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (!row) throw ApiError.notFound();
  }

  /**
   * «اطّلعت»/«أقرّ الاستلام»: يوقف التصعيد. «اطّلعت» على «مادة واردة» من مشرف يغطي المادة ينقلها من inbox إلى
   * acknowledged (حدث material.acknowledged يُعلم المراسل). ذاتي التكرار.
   */
  async ack(p: Principal, id: string): Promise<void> {
    if (!UUID.test(id)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const [n] = await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.userId, p.userId)))
        .for('update');
      if (!n) throw ApiError.notFound();
      if (n.state === 'acknowledged') return;
      await tx
        .update(notifications)
        .set({
          state: 'acknowledged',
          readAt: sql`COALESCE(${notifications.readAt}, now())`,
          acknowledgedAt: sql`now()`,
          assignmentState: n.assignmentState ? 'acknowledged' : null,
          escalateAt: null,
        })
        .where(eq(notifications.id, n.id));
      if (!INCOMING.includes(n.type) || !n.materialId) return;
      const m = await lockMaterial(tx, n.materialId);
      if (m && m.editorialState === 'inbox' && roleCovers(p, 'supervisor', m)) {
        await applyTransition(tx, m, { track: 'editorial', to: 'acknowledged', reason: 'acknowledged from notification', actorId: p.userId });
      }
    });
  }
}

function toDto(n: typeof notifications.$inferSelect): Notification {
  return {
    id: n.id,
    type: n.type,
    material_id: n.materialId,
    title: n.title,
    priority: n.priority as Notification['priority'],
    state: n.state as Notification['state'],
    assignment_state: n.assignmentState as Notification['assignment_state'],
    escalation_level: n.escalationLevel,
    created_at: iso(n.createdAt)!,
    read_at: iso(n.readAt),
    acknowledged_at: iso(n.acknowledgedAt),
  };
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at)) && typeof id === 'string' && UUID.test(id)) return { at, id };
  } catch {
    // يقع إلى 400 أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}
