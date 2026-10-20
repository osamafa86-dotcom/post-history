import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import type { components } from '../generated/api';
import { RehydrateOnReplay } from '../idempotency/replay';
import { Roles } from '../identity/principal';
import { DeviceAttestationService } from './device-attestation.service';

/** SEC-07 (ADR 0011): كل الثلاثة كتابة بـ Idempotency-Key، وATTESTATION_MODE=off يجعلها 404. */
@Controller()
export class DeviceAttestationController {
  constructor(private readonly attestation: DeviceAttestationService) {}

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
}
