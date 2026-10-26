import { Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, type RawBodyRequest, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import { Public } from '../identity/auth.guard';
import { Roles } from '../identity/principal';
import { type Order, type OrderCreate, OrdersService } from './orders.service';
import { PAYMENT_PROVIDER, type PaymentProvider, SandboxPaymentProvider } from './payment-provider';

/** الطلبات (v0.3، الجزء 4) بأدوار x-roles في العقد؛ النطاق في الخدمة. */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Roles('system_admin', 'finance', 'buyer_admin', 'buyer_member')
  list(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<{ items: Order[]; next_cursor: string | null }> {
    return this.orders.list(req.principal!, validateQuery('/orders', 'get', query));
  }

  @Post()
  @Roles('buyer_admin', 'buyer_member')
  create(@Body() body: unknown, @Req() req: Request): Promise<Order> {
    return this.orders.create(req.principal!, validateBody<OrderCreate>('/orders', 'post', body));
  }

  @Get(':orderId')
  @Roles('system_admin', 'finance', 'buyer_admin', 'buyer_member')
  get(@Param('orderId') id: string, @Req() req: Request): Promise<Order> {
    return this.orders.get(req.principal!, id);
  }

  @Post(':orderId/checkout')
  @Roles('buyer_admin', 'buyer_member')
  @HttpCode(200)
  checkout(@Param('orderId') id: string, @Req() req: Request) {
    return this.orders.checkout(req.principal!, id);
  }

  @Post(':orderId/cancel')
  @Roles('buyer_admin', 'buyer_member')
  @HttpCode(200)
  cancel(@Param('orderId') id: string, @Req() req: Request): Promise<Order> {
    return this.orders.cancel(req.principal!, id);
  }
}

/** إشعار المزوّد الموقّع خارج /v1 بلا جلسة (ADR 0032)؛ التوقيع على الجسم الخام (req.rawBody، rawBody: true في التطبيق). */
@Controller('payments/webhooks')
export class PaymentWebhooksController {
  constructor(private readonly orders: OrdersService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string | undefined>): Promise<{ received: true }> {
    if (!req.rawBody) throw new ApiError(400, 'webhook_signature_invalid', 'The webhook body must be JSON.');
    return this.orders.webhook(provider, req.rawBody, headers);
  }
}

/**
 * صفحة الدفع المستضافة للمزوّد التجريبي (ADR 0032): لا تطلب بطاقة، وأزرارها ترسل الإشعار الموقّع نفسه الذي يرسله المزوّد إلى
 * معالج الإشعار. بلا المزوّد التجريبي كل مساراتها 404. لا شرط هنا على NODE_ENV: وجود المزوّد التجريبي نفسه تحرسه الإعدادات عند
 * الإقلاع (ممنوع مع DEPLOY_STAGE=production، ولا يُقبل في NODE_ENV=production إلا للتجربة بعلمين)، والتجربة الميدانية تعمل بـ
 * NODE_ENV=production فشرطه كان يعطّل الدفع التجريبي فيها.
 */
@Controller('sandbox/checkout')
export class SandboxCheckoutController {
  constructor(
    private readonly orders: OrdersService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  private sandbox(): SandboxPaymentProvider {
    if (!(this.provider instanceof SandboxPaymentProvider)) throw new NotFoundException();
    return this.provider;
  }

  @Public()
  @Get(':ref')
  page(@Param('ref') ref: string, @Res() res: Response): void {
    const amount = this.sandbox().amountOf(ref);
    if (!amount) throw ApiError.notFound();
    const shown = `${(Number(amount.amountMinor) / 100).toFixed(2)} ${amount.currency}`;
    const buttons = ['succeeded', 'failed', 'delayed', 'duplicate', 'out_of_order']
      // من المتصفح ?return=1: بعد النتيجة يعود المشتري إلى صفحة الويب المعدّة (303)
      .map((o) => `<form method="post" action="${encodeURIComponent(ref)}/${o}?return=1"><button>${o}</button></form>`)
      .join('');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Sandbox checkout</title><p>${shown}</p>${buttons}`);
  }

  @Public()
  @Post(':ref/:outcome')
  @HttpCode(202)
  async complete(
    @Param('ref') ref: string,
    @Param('outcome') outcome: string,
    @Query('return') back: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const sandbox = this.sandbox();
    if (!sandbox.amountOf(ref)) throw ApiError.notFound();
    const send = (n: { body: Buffer; headers: Record<string, string> }) => this.orders.webhook(sandbox.name, n.body, n.headers);
    switch (outcome) {
      case 'succeeded':
      case 'failed':
        await send(sandbox.settle(ref, outcome));
        break;
      case 'duplicate': {
        const n = sandbox.settle(ref, 'succeeded');
        for (let i = 0; i < 10; i++) await send(n);
        break;
      }
      case 'out_of_order':
        await send(sandbox.settle(ref, 'succeeded'));
        await send(sandbox.settle(ref, 'failed'));
        break;
      case 'delayed': {
        const n = sandbox.settle(ref, 'succeeded');
        setTimeout(() => void send(n).catch(() => undefined), 2000).unref();
        break;
      }
      default:
        throw ApiError.notFound();
    }
    // العودة إلى صفحة الويب من إعداد الخادم وحده (SANDBOX_RETURN_URL)؛ النتيجة تلميح للعرض، والدفع يُقرأ من الطلب
    const target = back === '1' ? sandbox.returnUrlOf(ref) : undefined;
    if (target) {
      const url = new URL(target);
      url.searchParams.set('outcome', outcome === 'failed' ? 'failed' : 'succeeded');
      res.status(303).location(url.toString());
    }
  }
}

/**
 * تأكيد الاسترداد في المزوّد التجريبي: يرسل إشعار `refund.succeeded` الموقّع نفسه إلى معالج الإشعار. بلا المزوّد التجريبي
 * 404، ووجوده نفسه تحرسه الإعدادات عند الإقلاع (كصفحة الدفع، #341).
 */
@Controller('sandbox/refunds')
export class SandboxRefundsController {
  constructor(
    private readonly orders: OrdersService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  @Public()
  @Post(':ref/succeeded')
  @HttpCode(202)
  async succeed(@Param('ref') ref: string): Promise<void> {
    if (!(this.provider instanceof SandboxPaymentProvider)) throw new NotFoundException();
    const n = this.provider.settleRefund(ref);
    if (!n) throw ApiError.notFound();
    await this.orders.webhook(this.provider.name, n.body, n.headers);
  }
}
