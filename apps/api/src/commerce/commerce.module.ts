import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { IdentityModule } from '../identity/identity.module';
import { OrdersController, PaymentWebhooksController, SandboxCheckoutController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PAYMENT_PROVIDER, SandboxPaymentProvider } from './payment-provider';
import { BuyersController } from './buyers.controller';
import { BuyersService } from './buyers.service';
import { LicenseTemplatesController } from './license-templates.controller';
import { LicenseTemplatesService } from './license-templates.service';

/** المرحلة التجارية (v0.3، ADR 0025) بمزوّد دفع تجريبي فقط: قوالب التراخيص الآن، والكتالوج والإدراج تباعًا. */
@Module({ imports: [IdentityModule], controllers: [LicenseTemplatesController, BuyersController, OrdersController, PaymentWebhooksController, SandboxCheckoutController],
  providers: [
    LicenseTemplatesService, BuyersService,
    OrdersService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [APP_CONFIG],
      // ADR 0032: المزوّد التجريبي خارج الإنتاج وحده (فحص الإعداد)، وبلا مزوّد لا دفع
      useFactory: (c: AppConfig) => (c.PAYMENT_PROVIDER === 'sandbox' ? new SandboxPaymentProvider(c.SANDBOX_WEBHOOK_SECRET!, c.SANDBOX_CHECKOUT_BASE_URL) : null),
    },
  ] })
export class CommerceModule {}
