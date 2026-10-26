import { Controller, Get, Param, Query } from '@nestjs/common';
import { validateQuery } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { type CatalogQuery, CatalogService } from './catalog.service';

/** أدوار القراءة كما في x-roles بالعقد؛ أدوار المشترين تُضاف مع حسابات المؤسسات (الجزء 3). */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @Roles('system_admin', 'rights_officer', 'editor_in_chief', 'finance')
  search(@Query() query: Record<string, unknown>): Promise<components['schemas']['CatalogPage']> {
    // material_type يتكرر في العقد (explode)؛ القيمة الواحدة تصل نصًّا من Express فتُلفّ مصفوفة قبل التحقق
    const q = typeof query.material_type === 'string' ? { ...query, material_type: [query.material_type] } : query;
    return this.catalog.search(validateQuery<CatalogQuery>('/catalog', 'get', q));
  }

  @Get(':listingId')
  @Roles('system_admin', 'rights_officer', 'editor_in_chief', 'finance')
  item(@Param('listingId') id: string): Promise<components['schemas']['CatalogItem']> {
    return this.catalog.item(id);
  }

  @Get(':listingId/preview-url')
  @Roles('system_admin', 'rights_officer', 'editor_in_chief', 'finance')
  preview(@Param('listingId') id: string): Promise<components['schemas']['FileDownloadUrl']> {
    return this.catalog.previewUrl(id);
  }
}
