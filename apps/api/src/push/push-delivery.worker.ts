import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig, fieldKeyring } from '../config/config';
import type { FieldKeyring } from '../common/crypto';
import { LOGGER } from '../common/logger';
import { DB, type Database, type Tx } from '../database/database.module';
import { notificationDeliveries, notifications, pushDevices } from '../database/schema/schema';
import { schemaFileValidator } from '../common/contract';
import { APNS_SENDER, FCM_SENDER, type PushPayload, type PushSender } from './push-senders';

const PLATFORM_OF: Record<string, string> = { apns: 'ios', fcm: 'android' };

/**
 * يضع تسليم الدفع لإشعارات أُنشئت للتو في المعاملة نفسها التي أنشأتها: صف لكل قناة لها جهاز نشط لدى المستلم
 * (apns لـ iOS وfcm لأندرويد؛ دفع الويب لم يُنفَّذ). الإشعار يبقى في صندوق الوارد أيًّا كان مصير التسليم.
 * channels يحصر القنوات (قاعدة التنبيه)، وnotBeforeSeconds يؤجل أول محاولة (تأخير القاعدة وساعات الهدوء): العامل
 * لا يأخذ صفًا قبل updated_at.
 */
export async function enqueuePush(
  tx: Tx,
  notificationIds: string[],
  opts: { channels?: readonly string[]; notBeforeSeconds?: number } = {},
): Promise<void> {
  if (notificationIds.length === 0) return;
  const channels = (opts.channels ?? ['apns', 'fcm']).filter((c) => c === 'apns' || c === 'fcm');
  if (channels.length === 0) return;
  const platforms = channels.map((c) => (c === 'apns' ? 'ios' : 'android'));
  await tx.execute(sql`
    INSERT INTO notification_deliveries (notification_id, channel, updated_at)
    SELECT DISTINCT n.id, CASE d.platform WHEN 'ios' THEN 'apns' ELSE 'fcm' END,
           now() + make_interval(secs => ${opts.notBeforeSeconds ?? 0})
      FROM notifications n JOIN push_devices d ON d.user_id = n.user_id AND d.revoked_at IS NULL
       AND d.platform IN (${sql.join(platforms.map((p) => sql`${p}`), sql`, `)})
     WHERE n.id IN (${sql.join(notificationIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ON CONFLICT DO NOTHING`);
}

/**
 * يرسل التسليمات المعلّقة بـ FOR UPDATE SKIP LOCKED (عدة نسخ دون إرسال مزدوج)، بتراجع أسي حتى PUSH_MAX_ATTEMPTS. نجاح
 * جهاز واحد = sent؛ رمز غير صالح يُبطل جهازه؛ لا جهاز صالحًا = failed نهائيًا. السجل بمعرّف الإشعار والقناة والنتيجة
 * وحدها: لا رمز جهاز ولا عنوان.
 */
@Injectable()
export class PushDeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private readonly fieldKeys: FieldKeyring;
  private readonly senders: Record<string, PushSender | null>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APNS_SENDER) apns: PushSender | null,
    @Inject(FCM_SENDER) fcm: PushSender | null,
  ) {
    this.fieldKeys = fieldKeyring(config);
    this.senders = { apns, fcm };
  }

  onApplicationBootstrap(): void {
    if (!this.config.PUSH_DELIVERY_ENABLED || !this.config.OUTBOX_DISPATCHER_ENABLED) return;
    this.timer = setInterval(() => {
      this.deliverBatch().catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'push delivery failed'));
    }, this.config.PUSH_POLL_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** دفعة واحدة؛ يعيد عدد التسليمات التي عولجت. */
  async deliverBatch(limit = 50): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({
          notificationId: notificationDeliveries.notificationId,
          channel: notificationDeliveries.channel,
          attempts: notificationDeliveries.attempts,
          userId: notifications.userId,
          type: notifications.type,
          materialId: notifications.materialId,
          priority: notifications.priority,
          title: notifications.title,
          escalationLevel: notifications.escalationLevel,
        })
        .from(notificationDeliveries)
        .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
        .where(
          sql`${notificationDeliveries.status} IN ('pending', 'failed') AND ${notificationDeliveries.attempts} < ${this.config.PUSH_MAX_ATTEMPTS}
              AND ${notificationDeliveries.updatedAt} <= now() - make_interval(secs => least(300, power(2, ${notificationDeliveries.attempts})::int - 1))`,
        )
        .orderBy(notificationDeliveries.updatedAt)
        .limit(limit)
        .for('update', { of: notificationDeliveries, skipLocked: true });
      for (const d of due) await this.deliver(tx, d);
      return due.length;
    });
  }

  private async deliver(
    tx: Tx,
    d: {
      notificationId: string;
      channel: string;
      attempts: number;
      userId: string;
      type: string;
      materialId: string | null;
      priority: string;
      title: string;
      escalationLevel: number;
    },
  ): Promise<void> {
    const sender = this.senders[d.channel];
    const devices = await tx
      .select({ installationId: pushDevices.installationId, tokenEnc: pushDevices.tokenEnc })
      .from(pushDevices)
      .where(and(eq(pushDevices.userId, d.userId), eq(pushDevices.platform, PLATFORM_OF[d.channel] ?? ''), isNull(pushDevices.revokedAt)));
    const finish = (status: 'sent' | 'failed', error: string | null, terminal = false) =>
      tx
        .update(notificationDeliveries)
        .set({
          status,
          attempts: terminal ? this.config.PUSH_MAX_ATTEMPTS : d.attempts + 1,
          lastError: error,
          ...(status === 'sent' ? { sentAt: sql`now()` } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(notificationDeliveries.notificationId, d.notificationId), eq(notificationDeliveries.channel, d.channel)));

    if (!sender) return void (await finish('failed', 'channel_not_configured', true));
    if (devices.length === 0) return void (await finish('failed', 'no_device', true));

    const payload: PushPayload = {
      channel: d.channel as PushPayload['channel'],
      notification_id: d.notificationId,
      type: d.type,
      material_id: d.materialId,
      priority: d.priority as PushPayload['priority'],
      title: d.title,
      ...(d.type === 'notification.escalated' ? { escalation_level: d.escalationLevel } : {}),
    };
    // القائمة البيضاء للعقد قبل أن يغادر شيء الخادم: ما لا يطابقها لا يُرسل أبدًا (فشل نهائي)
    if (!schemaFileValidator('notification-channel-payload.json')(payload)) return void (await finish('failed', 'payload_rejected', true));
    const results = await Promise.all(
      devices.map(async (dev) => {
        let token: string;
        try {
          token = this.fieldKeys.decrypt(dev.tokenEnc).toString('utf8');
        } catch {
          // رمز لا يُفك بمفاتيح الحلقة (مفتاح دُوِّر وأُسقط): كرمز غير صالح، يُبطل جهازه ولا يوقف الدفعة
          return { dev, result: 'invalid_token' as const };
        }
        return { dev, result: await sender.send(token, payload) };
      }),
    );
    const invalid = results.filter((r) => r.result === 'invalid_token').map((r) => r.dev.installationId);
    if (invalid.length > 0) {
      await tx.update(pushDevices).set({ revokedAt: sql`now()` }).where(inArray(pushDevices.installationId, invalid));
    }
    const outcome = results.some((r) => r.result === 'ok') ? 'sent' : results.some((r) => r.result === 'retry') ? 'retry' : 'invalid';
    if (outcome === 'sent') await finish('sent', null);
    else if (outcome === 'retry') await finish('failed', 'provider_unavailable');
    else await finish('failed', 'invalid_token', true);
    this.logger.info({ notification_id: d.notificationId, channel: d.channel, outcome, devices: devices.length }, 'push delivery');
  }
}

