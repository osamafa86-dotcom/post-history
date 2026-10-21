import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { ReporterIdentitySettings } from './reporter-identity.service';

/** ADR 0021: من يرى الاسم الحقيقي للمراسل، لمدير النظام وحده. */
@Controller('admin/settings/reporter-identity')
export class ReporterIdentityController {
  constructor(private readonly settings: ReporterIdentitySettings) {}

  @Get()
  @Roles('system_admin')
  get(): Promise<components['schemas']['ReporterIdentitySetting']> {
    return this.settings.get();
  }

  @Put()
  @Roles('system_admin')
  update(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['ReporterIdentitySetting']> {
    const input = validateBody<components['schemas']['ReporterIdentitySettingUpdate']>('/admin/settings/reporter-identity', 'put', body);
    return this.settings.update(req.auth!.userId, input);
  }
}
