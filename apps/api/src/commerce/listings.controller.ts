import { Body, Controller, Get, Headers, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { validateBody } from '../common/contract';
import { Roles } from '../identity/principal';
import { type CatalogListing, type CatalogListingInput, type ListingWithTag, ListingsService } from './listings.service';

/** الأدوار كما في x-roles بالعقد: القراءة للإدارة والحقوق ورئيس التحرير والمالية، والكتابة للإدارة والحقوق. */
@Controller('materials/:id/listing')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Get()
  @Roles('system_admin', 'rights_officer', 'editor_in_chief', 'finance')
  async get(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<CatalogListing> {
    return tagged(res, await this.listings.get(req.principal!, id));
  }

  @Post()
  @Roles('system_admin', 'rights_officer')
  async create(@Param('id') id: string, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<CatalogListing> {
    const input = validateBody<CatalogListingInput>('/materials/{id}/listing', 'post', body);
    return tagged(res, await this.listings.create(req.principal!, id, input));
  }

  @Put()
  @Roles('system_admin', 'rights_officer')
  async replace(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ): Promise<CatalogListing> {
    const input = validateBody<CatalogListingInput>('/materials/{id}/listing', 'put', body);
    return tagged(res, await this.listings.replace(req.principal!, id, input, ifMatch));
  }
}

function tagged(res: Response, r: ListingWithTag): CatalogListing {
  res.setHeader('ETag', `"${r.etag}"`);
  return r.listing;
}
