import { Controller, Get, Inject, Query } from '@nestjs/common';
import { and, asc, eq, gt, type SQL } from 'drizzle-orm';
import { validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { outboxEvents } from '../database/schema/schema';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { iso } from '../materials/material-store';

type OutboxEvent = components['schemas']['OutboxEvent'];

/** قراءة أحداث Outbox بترتيبها التسلسلي (لوحة الإدارة والمراقبة) لمدير النظام فقط (ADR SEC-03). */
@Controller('events')
export class EventsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  @Roles('system_admin')
  async list(@Query() query: Record<string, unknown>): Promise<components['schemas']['EventPage']> {
    const q = validateQuery<{ after?: string; type?: string; limit?: number }>('/events', 'get', query);
    if (q.after !== undefined && !/^[0-9]{1,19}$/.test(q.after)) {
      throw new ApiError(400, 'bad_request', 'Invalid query parameters.', { params: ['after'] });
    }
    const where: SQL[] = [];
    if (q.after !== undefined) where.push(gt(outboxEvents.id, Number(q.after)));
    if (q.type) where.push(eq(outboxEvents.type, q.type));
    const rows = await this.db
      .select()
      .from(outboxEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(outboxEvents.id))
      .limit(q.limit ?? 50);
    const items: OutboxEvent[] = rows.map((e) => ({
      id: String(e.id),
      type: e.type as OutboxEvent['type'],
      aggregate_type: e.aggregateType as OutboxEvent['aggregate_type'],
      aggregate_id: e.aggregateId,
      occurred_at: iso(e.occurredAt)!,
      idempotency_key: e.idempotencyKey,
      actor_id: e.actorId,
      payload: e.payload as OutboxEvent['payload'],
      published_at: iso(e.publishedAt),
      attempts: e.attempts,
    })) as OutboxEvent[];
    // المؤشر التالي آخر حدث مقروء؛ صفحة فارغة تعيد المؤشر نفسه ليستأنف المراقِب منه
    return { items, next_after: items.length ? items[items.length - 1]!.id : (q.after ?? null) };
  }
}
