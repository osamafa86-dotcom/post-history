import type Redis from 'ioredis';
import { type OutboxEventType, serializeOutboxEvent } from './outbox';
import type { OutboxRow } from './outbox.dispatcher';

/**
 * طابور عامل الوسائط (ADR 0006): Redis Stream بمجموعة مستهلكين `media` يديرها العامل. `upload.verified` لعامل التفريغ
 * المحلي (مجموعته الخاصة على الطابور نفسه)؛ عامل الوسائط يتجاوز ما لا يخصه.
 */
export const MEDIA_STREAM = 'media:events';
/** نسخ قالب «مواد متداولة» (ADR 0091): طابور مستقل لحاوية media-render، فلا تؤخّر النسخة معاينات المواد الجديدة. */
export const RENDER_STREAM = 'media:renders';
const MEDIA_EVENT_TYPES: ReadonlySet<OutboxEventType> = new Set([
  'upload.original_received',
  'upload.proxy_received',
  'upload.verified',
  // export.requested (v0.2): عامل الوسائط يبني حزمة التصدير عند الطلب ويسجّلها مشتقًا export
  'export.requested',
  // catalog.listing_changed (v0.3): عامل الوسائط يبني watermarked_preview من source_file_id عند الإدراج
  'catalog.listing_changed',
  // license.delivery_requested (v0.3): عامل الوسائط يبني حزمة تسليم الترخيص ويسجّلها مشتقًا delivery
  'license.delivery_requested',
]);
const RENDER_EVENT_TYPES: ReadonlySet<OutboxEventType> = new Set(['render.requested']);

export class MediaQueueUnavailableError extends Error {
  override name = 'MediaQueueUnavailableError';
}

/** الطابور الذي يُنشر إليه الحدث، أو null لما لا يخص عاملًا. */
export function mediaStreamFor(event: OutboxRow): string | null {
  const type = event.type as OutboxEventType;
  if (MEDIA_EVENT_TYPES.has(type)) return MEDIA_STREAM;
  if (RENDER_EVENT_TYPES.has(type)) return RENDER_STREAM;
  return null;
}

export function isMediaEvent(event: OutboxRow): boolean {
  return mediaStreamFor(event) !== null;
}

/**
 * يضيف الحدث إلى طابوره بحقلين: `event_id` و`event` (JSON الحدث بصيغة العقد؛ الحمولة قائمة بيضاء بلا كاشف).
 * الطول مقصوص تقريبيًا (`MAXLEN ~`). يُستدعى داخل نشر Outbox: الفشل يرمي فيُعاد الحدث لاحقًا، والتسليم «مرة على
 * الأقل» لأن الإضافة قد تنجح ثم تفشل المعاملة؛ نقاط العامل متساوية الأثر لذلك.
 */
export async function appendMediaEvent(redis: Redis | null, event: OutboxRow, maxLen: number): Promise<void> {
  const stream = mediaStreamFor(event);
  if (!stream) return;
  if (!redis) throw new MediaQueueUnavailableError('REDIS_URL is required to feed the media worker');
  await redis.xadd(stream, 'MAXLEN', '~', String(maxLen), '*', 'event_id', String(event.id), 'event', JSON.stringify(serializeOutboxEvent(event)));
}
