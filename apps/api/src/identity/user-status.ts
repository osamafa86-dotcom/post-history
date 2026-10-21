import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { users } from '../database/schema/schema';
import { writeOutboxEvent } from '../outbox/outbox';
import { audit } from './recovery-approval';
import { revokeAllAccess } from './session.service';

/**
 * يطبّق تغيير حالة حساب داخل المعاملة (الواجهة وأمر CLI): الحالة، وإبطال كل الوصول عند التعليق، والتدقيق بـ
 * reason_code وحده (لا نص حر، SEC-03)، وحدث user.status_changed. محفّز القاعدة يمنع النزول عن مديرَين فاعلَين.
 */
export async function recordStatusChange(tx: Tx, actorId: string, userId: string, status: 'active' | 'suspended'): Promise<void> {
  const [changed] = await tx.update(users).set({ status }).where(eq(users.id, userId)).returning({ at: sql<string>`now()` });
  if (status === 'suspended') await revokeAllAccess(tx, userId);
  const reasonCode = status === 'suspended' ? 'suspended' : 'reactivated';
  await audit(tx, actorId, `user.${reasonCode}`, userId, { target_user_id: userId, reason_code: reasonCode });
  const occurredAt = new Date(changed!.at).toISOString();
  await writeOutboxEvent(tx, {
    type: 'user.status_changed',
    aggregateType: 'user',
    aggregateId: userId,
    // كل تغيير حالة حدث مستقل؛ لحظة المعاملة تميّزه
    idempotencyKey: `user.status_changed:${userId}:${occurredAt}`,
    actorId,
    payload: { user_id: userId, status, reason_code: reasonCode, actor_id: actorId, occurred_at: occurredAt },
  });
}
