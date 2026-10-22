import { Body, Controller, Get, Headers, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import { Roles } from '../identity/principal';
import { type LicenseTemplate, type LicenseTemplateInput, LicenseTemplatesService } from './license-templates.service';

/** الأدوار كما في x-roles بالعقد: القراءة للإدارة والحقوق ورئيس التحرير والمالية، والكتابة للإدارة والحقوق. */
@Controller('license-templates')
export class LicenseTemplatesController {
  constructor(private readonly templates: LicenseTemplatesService) {}

  @Get()
  @Roles('system_admin', 'rights_officer', 'editor_in_chief', 'finance')
  list(@Query() query: Record<string, unknown>): Promise<{ items: LicenseTemplate[] }> {
    const q = validateQuery<{ include_disabled?: boolean }>('/license-templates', 'get', query);
    return this.templates.list(q.include_disabled ?? false);
  }

  @Post()
  @Roles('system_admin', 'rights_officer')
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LicenseTemplate> {
    return etag(res, await this.templates.create(req.principal!.userId, validateBody<LicenseTemplateInput>('/license-templates', 'post', body)));
  }

  @Get(':templateId')
  @Roles('system_admin', 'rights_officer', 'editor_in_chief', 'finance')
  async get(@Param('templateId') id: string, @Query() query: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<LicenseTemplate> {
    const q = validateQuery<{ version?: number }>('/license-templates/{template_id}', 'get', query);
    return etag(res, await this.templates.get(id, q.version));
  }

  @Put(':templateId')
  @Roles('system_admin', 'rights_officer')
  async replace(
    @Param('templateId') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ): Promise<LicenseTemplate> {
    const input = validateBody<LicenseTemplateInput>('/license-templates/{template_id}', 'put', body);
    return etag(res, await this.templates.replace(req.principal!.userId, id, input, ifMatch));
  }
}

/** ETag هو رقم الإصدار المعاد (للقراءة بإصدار سابق: ذلك الإصدار). */
function etag(res: Response, template: LicenseTemplate): LicenseTemplate {
  res.setHeader('ETag', `"${template.version}"`);
  return template;
}
