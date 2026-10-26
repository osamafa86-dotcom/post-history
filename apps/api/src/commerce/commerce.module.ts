import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { IdentityModule } from '../identity/identity.module';
import { VerificationModule } from '../verification/verification.module';
import { BuyersController } from './buyers.controller';
import { BuyersService } from './buyers.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { LicenseTemplatesController } from './license-templates.controller';
import { LicensesController, LicensesService } from './licenses';
import { LicenseTemplatesService } from './license-templates.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';
import { CommissionRulesController, CommissionRulesService } from './commission-rules';
import { OrdersController, PaymentWebhooksController, SandboxCheckoutController, SandboxRefundsController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PAYMENT_PROVIDER, SandboxPaymentProvider } from './payment-provider';
import { StripeTestProvider } from './stripe-provider';
import { RefundsController, RefundsService } from './refunds';

/** المرحلة التجارية (v0.3، ADR 0025) بمزوّد دفع تجريبي فقط: قوالب التراخيص، والإدراج، والكتالوج، والمشترون، والطلبات. */
@Module({
  imports: [VerificationModule, IdentityModule],
  controllers: [
    LicenseTemplatesController, ListingsController, CatalogController, BuyersController,
    OrdersController, PaymentWebhooksController, SandboxCheckoutController, SandboxRefundsController, LicensesController,
    RefundsController, CommissionRulesController,
  ],
  providers: [
    LicenseTemplatesService, ListingsService, CatalogService, BuyersService,
    OrdersService, RefundsService, CommissionRulesService, LicensesService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [APP_CONFIG],
      // ADR 0032: المزوّد التجريبي خارج الإنتاج وحده (فحص الإعداد)، وبلا مزوّد لا دفع
      useFactory: (c: AppConfig) =>
        c.PAYMENT_PROVIDER === 'sandbox'
          ? new SandboxPaymentProvider(c.SANDBOX_WEBHOOK_SECRET!, c.SANDBOX_CHECKOUT_BASE_URL)
          : c.PAYMENT_PROVIDER === 'stripe'
            ? new StripeTestProvider(c.STRIPE_TEST_SECRET_KEY!, c.STRIPE_WEBHOOK_SECRET!, c.STRIPE_API_BASE)
            : null,
    },
  ],
})
export class CommerceModule {}
