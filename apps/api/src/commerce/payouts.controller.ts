import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import type { PayableState } from './ledger';
import type { Currency } from './money';
import { PayoutWorker } from './payout.worker';
import { PayoutsService } from './payouts';

type EarningsSummary = components['schemas']['EarningsSummary'];
type EarningsEntryPage = components['schemas']['EarningsEntryPage'];
type PayoutRequest = components['schemas']['PayoutRequest'];
type PayoutRequestPage = components['schemas']['PayoutRequestPage'];
type PayoutPolicy = components['schemas']['PayoutPolicy'];
type PayoutState = components['schemas']['PayoutState'];

/** أرباح المراسل وطلبات صرفه (ADR 0033). */
@Controller('me')
export class MyEarningsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('earnings')
  @Roles('reporter')
  summary(@Req() req: Request): Promise<EarningsSummary> {
    return this.payouts.summary(req.principal!.userId);
  }

  @Get('earnings/entries')
  @Roles('reporter')
  entries(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<EarningsEntryPage> {
    const q = validateQuery<{ currency?: Currency; state?: PayableState; cursor?: string; limit?: number }>('/me/earnings/entries', 'get', query);
    return this.payouts.entries(req.principal!.userId, q);
  }

  @Get('payout-requests')
  @Roles('reporter')
  list(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<PayoutRequestPage> {
    return this.payouts.listMine(req.principal!.userId, validateQuery<{ cursor?: string; limit?: number }>('/me/payout-requests', 'get', query));
  }

  @Post('payout-requests')
  @Roles('reporter')
  create(@Body() body: unknown, @Req() req: Request): Promise<PayoutRequest> {
    return this.payouts.create(req.principal!.userId, validateBody('/me/payout-requests', 'post', body));
  }
}

@Controller('users/:id/earnings')
export class UserEarningsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @Roles('system_admin', 'finance')
  summary(@Param('id') id: string): Promise<EarningsSummary> {
    return this.payouts.summaryOf(id);
  }
}

@Controller('payout-requests')
export class PayoutRequestsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly worker: PayoutWorker,
  ) {}

  @Get()
  @Roles('system_admin', 'finance')
  list(@Query() query: Record<string, unknown>): Promise<PayoutRequestPage> {
    return this.payouts.list(validateQuery<{ state?: PayoutState; user_id?: string; cursor?: string; limit?: number }>('/payout-requests', 'get', query));
  }

  @Get(':payoutRequestId')
  @Roles('system_admin', 'finance', 'reporter')
  get(@Param('payoutRequestId') id: string, @Req() req: Request): Promise<PayoutRequest> {
    return this.payouts.get(req.principal!, id);
  }

  /** باكتمال الاعتماد تكمله القناة التجريبية فورًا بعد المعاملة (والعامل الدوري احتياط). */
  @Post(':payoutRequestId/approve')
  @HttpCode(200)
  @Roles('system_admin', 'finance')
  async approve(@Param('payoutRequestId') id: string, @Req() req: Request): Promise<PayoutRequest> {
    const out = await this.payouts.approve(req.principal!.userId, id);
    if (out.state === 'approved') void this.worker.tick();
    return out;
  }

  @Post(':payoutRequestId/reject')
  @HttpCode(200)
  @Roles('system_admin', 'finance')
  reject(@Param('payoutRequestId') id: string, @Body() body: unknown, @Req() req: Request): Promise<PayoutRequest> {
    const input = validateBody<{ reason_code: components['schemas']['PayoutReason'] }>('/payout-requests/{payout_request_id}/reject', 'post', body);
    return this.payouts.reject(req.principal!.userId, id, input.reason_code);
  }

  @Post(':payoutRequestId/cancel')
  @HttpCode(200)
  @Roles('reporter')
  cancel(@Param('payoutRequestId') id: string, @Req() req: Request): Promise<PayoutRequest> {
    return this.payouts.cancel(req.principal!.userId, id);
  }
}

@Controller('payout-policies')
export class PayoutPoliciesController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @Roles('system_admin', 'finance')
  list(): Promise<{ items: PayoutPolicy[] }> {
    return this.payouts.policies();
  }

  @Post()
  @Roles('system_admin')
  create(@Body() body: unknown, @Req() req: Request): Promise<PayoutPolicy> {
    return this.payouts.createPolicy(req.principal!.userId, validateBody('/payout-policies', 'post', body));
  }
}
