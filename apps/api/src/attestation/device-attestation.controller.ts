import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { BlockList } from 'node:net';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig, addressAllowed, blockListOf } from '../config/config';
import { ApiError } from '../common/errors';
import { validateBody } from '../common/contract';
import type { components } from '../generated/api';
import { RehydrateOnReplay } from '../idempotency/replay';
import { Public } from '../identity/auth.guard';
import { Roles } from '../identity/principal';
import { DeviceAttestationService } from './device-attestation.service';

/** SEC-07 (ADR 0011): كل الثلاثة كتابة بـ Idempotency-Key، وATTESTATION_MODE=off يجعلها 404. */
@Controller()
export class DeviceAttestationController {
  private readonly bff: BlockList;

  constructor(
    private readonly attestation: DeviceAttestationService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.bff = blockListOf(config.BFF_SOURCE_ADDRESSES);
  }

  @Post('device-attestations/challenge')
  @HttpCode(200)
  @Roles('reporter')
  challenge(@Req() req: Request): Promise<components['schemas']['AttestationChallenge']> {
    return this.attestation.challenge(req.principal!);
  }

  @Post('device-attestations')
  @Roles('reporter')
  register(@Body() body: unknown, @Req() req: Request): Promise<{ key_ref: string }> {
    return this.attestation.register(req.principal!, validateBody('/device-attestations', 'post', body));
  }

  @Post('uploads/:id/ingest-token')
  @HttpCode(200)
  @Roles('reporter')
  @RehydrateOnReplay(DeviceAttestationService)
  ingestToken(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<components['schemas']['IngestToken']> {
    return this.attestation.ingestToken(req.principal!, id, validateBody('/uploads/{id}/ingest-token', 'post', body));
  }

  /** رمز ingest لرفع الويب: من الـBFF وحده (عنوان المقبس في BFF_SOURCE_ADDRESSES)، وغيره 404 كأنه غير موجود. */
  @Post('uploads/:id/web-ingest-token')
  @HttpCode(200)
  @Roles('reporter')
  @RehydrateOnReplay(DeviceAttestationService)
  webIngestToken(@Param('id') id: string, @Req() req: Request): Promise<components['schemas']['IngestToken']> {
    if (!addressAllowed(this.bff, req.socket.remoteAddress)) throw ApiError.notFound();
    return this.attestation.webIngestToken(req.principal!, req.auth!.sessionId, id);
  }

  /**
   * فحص بوابة ingest قبل PATCH (داخلي: /internal/* لعناوين INTERNAL_ALLOWED_CIDRS وحدها). 204 = اقبل، 403 بلا جسم =
   * ارفض. sid جلسة الرفع وses جلسة الدخول من مطالبات الرمز.
   */
  @Public()
  @Get('internal/ingest/session-status')
  async sessionStatus(@Query('sid') sid: unknown, @Query('ses') ses: unknown, @Res() res: Response): Promise<void> {
    const ok =
      typeof sid === 'string' &&
      (ses === undefined || typeof ses === 'string') &&
      (await this.attestation.sessionAccepts(sid, ses as string | undefined));
    res.status(ok ? 204 : 403).end();
  }
}
