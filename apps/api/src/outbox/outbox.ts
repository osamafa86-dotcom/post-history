import { outboxEvents } from '../database/schema/schema';
import type { Tx } from '../database/database.module';
import type { components } from '../generated/api';

type ContractEvent = components['schemas']['outbox-event'];
export type OutboxEventType = ContractEvent['type'];
export type OutboxAggregateType = ContractEvent['aggregate_type'];

export interface NewOutboxEvent {
  type: OutboxEventType;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  /** مشتق تحديدًا من (النوع، المجمّع، السبب) فيتكرر الاستدعاء دون أن يتكرر الحدث. */
  idempotencyKey: string;
  actorId?: string | null;
  /** مفاتيح القائمة البيضاء لنوع الحدث فقط (قيد outbox_events_payload_whitelisted، ADR SEC-03). */
  payload: Record<string, string | number | boolean | null>;
}

/**
 * يكتب حدثًا في Outbox. يقبل معاملة فقط (Tx) عمدًا: الحدث يُحفظ مع تغيير الحالة في المعاملة نفسها أو لا يُحفظ.
 * التكرار بالمفتاح نفسه لا يُنشئ حدثًا ثانيًا؛ يعيد true إن كُتب حدث جديد.
 */
export async function writeOutboxEvent(tx: Tx, event: NewOutboxEvent): Promise<boolean> {
  const rows = await tx
    .insert(outboxEvents)
    .values({
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      idempotencyKey: event.idempotencyKey,
      actorId: event.actorId ?? null,
      payload: event.payload,
    })
    .onConflictDoNothing({ target: outboxEvents.idempotencyKey })
    .returning({ id: outboxEvents.id });
  return rows.length > 0;
}
