import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { FileDownloadService } from './file-download.service';
import { type ListQuery, MaterialsService } from './materials.service';

type Material = components['schemas']['Material'];

// الأدوار كما في x-roles بالعقد لكل عملية؛ النطاق يُطبَّق في طبقة الاستعلام (material-store.scopeCondition).
const READERS = ['reporter', 'supervisor', 'producer', 'editor_in_chief', 'rights_officer', 'system_admin'] as const;

@Controller('materials')
export class MaterialsController {
  constructor(
    private readonly materials: MaterialsService,
    private readonly downloads: FileDownloadService,
  ) {}

  @Get(':id/files/:fileId/download-url')
  @Roles(...READERS)
  @Header('Cache-Control', 'no-store')
  downloadUrl(@Param('id') id: string, @Param('fileId') fileId: string, @Req() req: Request): Promise<components['schemas']['FileDownloadUrl']> {
    return this.downloads.downloadUrl(req.principal!, id, fileId);
  }

  @Get()
  @Roles(...READERS)
  list(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<components['schemas']['MaterialPage']> {
    return this.materials.list(req.principal!, validateQuery<ListQuery>('/materials', 'get', query));
  }

  @Post()
  @Roles('reporter')
  create(@Body() body: unknown, @Req() req: Request): Promise<Material> {
    return this.materials.create(req.principal!, validateBody('/materials', 'post', body));
  }

  @Get(':id')
  @Roles(...READERS)
  get(@Param('id') id: string, @Req() req: Request): Promise<Material> {
    return this.materials.get(req.principal!, id);
  }

  @Patch(':id')
  @Roles('reporter', 'supervisor', 'editor_in_chief', 'system_admin')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request, @Headers('if-match') ifMatch?: string): Promise<Material> {
    return this.materials.update(req.principal!, id, validateBody('/materials/{id}', 'patch', body), ifMatch);
  }

  @Get(':id/transitions')
  @Roles(...READERS)
  async transitions(@Param('id') id: string, @Req() req: Request): Promise<{ items: components['schemas']['TransitionRecord'][] }> {
    return { items: await this.materials.transitions(req.principal!, id) };
  }

  @Post(':id/transitions')
  @HttpCode(200)
  @Roles(...READERS)
  transition(@Param('id') id: string, @Body() body: unknown, @Req() req: Request, @Headers('if-match') ifMatch?: string): Promise<Material> {
    return this.materials.transition(req.principal!, id, validateBody('/materials/{id}/transitions', 'post', body), ifMatch);
  }

  @Put(':id/contributors')
  @Roles('rights_officer', 'system_admin')
  contributors(@Param('id') id: string, @Body() body: unknown, @Req() req: Request, @Headers('if-match') ifMatch?: string): Promise<Material> {
    const input = validateBody<components['schemas']['ContributorsSet']>('/materials/{id}/contributors', 'put', body);
    return this.materials.setContributors(req.principal!, id, input.contributors, ifMatch);
  }

  @Post(':id/reservation')
  @HttpCode(200)
  @Roles('producer', 'editor_in_chief')
  reserve(@Param('id') id: string, @Req() req: Request, @Headers('if-match') ifMatch?: string): Promise<components['schemas']['Reservation']> {
    return this.materials.reserve(req.principal!, id, ifMatch);
  }

  @Delete(':id/reservation')
  @HttpCode(204)
  @Roles('producer', 'supervisor', 'editor_in_chief', 'system_admin')
  async release(@Param('id') id: string, @Req() req: Request): Promise<void> {
    await this.materials.release(req.principal!, id);
  }
}
