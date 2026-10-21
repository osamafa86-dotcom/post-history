import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PushDeliveryWorker } from './push-delivery.worker';
import { APNS_SENDER, ApnsSender, FCM_SENDER, FcmSender } from './push-senders';

/** المرسِلون حقيقيون حين يكتمل إعداد قناتهم؛ قناة بلا إعداد = تسليماتها تفشل نهائيًا بـ channel_not_configured. */
@Module({
  providers: [
    {
      provide: APNS_SENDER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        c.APNS_TEAM_ID && c.APNS_KEY_ID && c.APNS_PRIVATE_KEY && c.APNS_TOPIC
          ? new ApnsSender({
              teamId: c.APNS_TEAM_ID,
              keyId: c.APNS_KEY_ID,
              privateKeyPem: Buffer.from(c.APNS_PRIVATE_KEY, 'base64').toString('utf8'),
              topic: c.APNS_TOPIC,
              host: c.APNS_ENVIRONMENT === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com',
            })
          : null,
    },
    {
      provide: FCM_SENDER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => (c.FCM_PROJECT_ID && c.FCM_SERVICE_ACCOUNT ? new FcmSender(c.FCM_PROJECT_ID, c.FCM_SERVICE_ACCOUNT) : null),
    },
    PushDeliveryWorker,
  ],
  exports: [PushDeliveryWorker],
})
export class PushModule {}
