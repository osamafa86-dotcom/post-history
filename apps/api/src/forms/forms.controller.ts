import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import type { UploadForm } from './dynamic-fields';
import { FormsService } from './forms.service';

@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @Roles('system_admin', 'editor_in_chief')
  async list(): Promise<{ items: components['schemas']['FormVersionSummary'][] }> {
    return { items: await this.forms.list() };
  }

  @Post()
  @Roles('system_admin')
  publish(@Body() body: unknown, @Req() req: Request): Promise<UploadForm> {
    return this.forms.publish(body, req.auth!.userId);
  }

  @Get('current')
  @Roles('authenticated')
  current(@Query() query: Record<string, unknown>): Promise<UploadForm> {
    const { material_type } = validateQuery<{ material_type?: string }>('/forms/current', 'get', query);
    return this.forms.current(material_type);
  }

  @Get(':version')
  @Roles('authenticated')
  async byVersion(@Param('version') raw: string): Promise<UploadForm> {
    // العقد لا يعرّف 400 هنا: الإصدار غير الصالح غير موجود
    if (!/^[1-9][0-9]{0,8}$/.test(raw)) throw ApiError.notFound();
    const form = await this.forms.byVersion(Number(raw));
    if (!form) throw ApiError.notFound();
    return form;
  }
}
