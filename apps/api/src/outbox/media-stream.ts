import type Redis from 'ioredis';
import { type OutboxEventType, serializeOutboxEvent } from './outbox';
import type { OutboxRow } from './outbox.dispatcher';

/** طابور عامل الوسائط (ADR 0006): Redis Stream بمجموعة مستهلكين `media` يديرها العامل. */
export const MEDIA_STREAM = 'media:events';
// export.requested (v0.2): عامل الوسائط يبني حزمة التصدير عند الطلب ويسجّلها مشتقًا export
const MEDIA_EVENT_TYPES: ReadonlySet<OutboxEventType> = new Set(['upload.original_received', 'upload.proxy_received', 'export.requested']);

export class MediaQueueUnavailableError extends Error {
  override name = 'MediaQueueUnavailableError';
}

export function isMediaEvent(event: OutboxRow): boolean {
  return MEDIA_EVENT_TYPES.has(event.type as OutboxEventType);
}

/**
 * يضيف الحدث إلى الطابور بحقلين: `event_id` و`event` (JSON الحدث بصيغة العقد؛ الحمولة قائمة بيضاء بلا كاشف).
 * الطول مقصوص تقريبيًا (`MAXLEN ~`). يُستدعى داخل نشر Outbox: الفشل يرمي فيُعاد الحدث لاحقًا، والتسليم «مرة على
 * الأقل» لأن الإضافة قد تنجح ثم تفشل المعاملة؛ نقاط العامل متساوية الأثر لذلك.
 */
export async function appendMediaEvent(redis: Redis | null, event: OutboxRow, maxLen: number): Promise<void> {
  if (!redis) throw new MediaQueueUnavailableError('REDIS_URL is required to feed the media worker');
  await redis.xadd(MEDIA_STREAM, 'MAXLEN', '~', String(maxLen), '*', 'event_id', String(event.id), 'event', JSON.stringify(serializeOutboxEvent(event)));
}
