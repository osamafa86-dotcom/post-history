import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateQuery } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { type CatalogQuery, CatalogService } from './catalog.service';

const READERS = ['system_admin', 'rights_officer', 'editor_in_chief', 'finance', 'buyer_admin', 'buyer_member'] as const;

/** أدوار القراءة كما في x-roles بالعقد؛ المشتري بشرط أن تكون مؤسسته فعّالة. */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @Roles(...READERS)
  async search(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<components['schemas']['CatalogPage']> {
    await this.catalog.assertReader(req.principal!);
    // material_type يتكرر في العقد (explode)؛ القيمة الواحدة تصل نصًّا من Express فتُلفّ مصفوفة قبل التحقق
    const q = typeof query.material_type === 'string' ? { ...query, material_type: [query.material_type] } : query;
    return this.catalog.search(validateQuery<CatalogQuery>('/catalog', 'get', q));
  }

  @Get(':listingId')
  @Roles(...READERS)
  async item(@Param('listingId') id: string, @Req() req: Request): Promise<components['schemas']['CatalogItem']> {
    await this.catalog.assertReader(req.principal!);
    return this.catalog.item(id);
  }

  @Get(':listingId/preview-url')
  @Roles(...READERS)
  async preview(@Param('listingId') id: string, @Req() req: Request): Promise<components['schemas']['FileDownloadUrl']> {
    await this.catalog.assertReader(req.principal!);
    return this.catalog.previewUrl(id);
  }
}
