import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import { Roles } from '../identity/principal';
import {
  type BuyerMember,
  type BuyerMemberInvite,
  type BuyerMemberUpdate,
  type BuyerOrganization,
  type BuyerOrganizationCreate,
  type BuyerOrganizationInput,
  BuyersService,
} from './buyers.service';

/** الأدوار كما في x-roles بالعقد (v0.3، الجزء 3). عزل المؤسسات في الخدمة: المشتري يرى مؤسسته وحدها. */
@Controller('buyer-organizations')
export class BuyersController {
  constructor(private readonly buyers: BuyersService) {}

  @Get()
  @Roles('system_admin', 'finance')
  list(@Query() query: Record<string, unknown>): Promise<{ items: BuyerOrganization[]; next_cursor: string | null }> {
    return this.buyers.list(validateQuery<{ status?: BuyerOrganization['status']; cursor?: string; limit?: number }>('/buyer-organizations', 'get', query));
  }

  @Post()
  @Roles('system_admin')
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<BuyerOrganization & { invite_token?: string }> {
    const { org, etag } = await this.buyers.create(req.principal!.userId, validateBody<BuyerOrganizationCreate>('/buyer-organizations', 'post', body));
    res.setHeader('ETag', etag);
    return org;
  }

  @Get(':orgId')
  @Roles('system_admin', 'finance', 'buyer_admin', 'buyer_member')
  async get(@Param('orgId') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<BuyerOrganization> {
    const { org, etag } = await this.buyers.get(req.principal!, id);
    res.setHeader('ETag', etag);
    return org;
  }

  @Put(':orgId')
  @Roles('system_admin', 'buyer_admin')
  async replace(
    @Param('orgId') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ): Promise<BuyerOrganization> {
    const input = validateBody<BuyerOrganizationInput>('/buyer-organizations/{org_id}', 'put', body);
    const { org, etag } = await this.buyers.replace(req.principal!, id, input, ifMatch);
    res.setHeader('ETag', etag);
    return org;
  }

  @Get(':orgId/members')
  @Roles('system_admin', 'buyer_admin')
  members(@Param('orgId') id: string, @Req() req: Request): Promise<{ items: BuyerMember[] }> {
    return this.buyers.members(req.principal!, id);
  }

  @Post(':orgId/members')
  @Roles('system_admin', 'buyer_admin')
  invite(@Param('orgId') id: string, @Body() body: unknown, @Req() req: Request): Promise<BuyerMember & { invite_token?: string }> {
    return this.buyers.invite(req.principal!, id, validateBody<BuyerMemberInvite>('/buyer-organizations/{org_id}/members', 'post', body));
  }

  @Put(':orgId/members/:userId')
  @Roles('system_admin', 'buyer_admin')
  @HttpCode(200)
  updateMember(@Param('orgId') id: string, @Param('userId') userId: string, @Body() body: unknown, @Req() req: Request): Promise<BuyerMember> {
    return this.buyers.updateMember(req.principal!, id, userId, validateBody<BuyerMemberUpdate>('/buyer-organizations/{org_id}/members/{user_id}', 'put', body));
  }
}
