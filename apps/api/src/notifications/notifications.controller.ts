import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles('authenticated')
  list(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<components['schemas']['NotificationPage']> {
    const q = validateQuery<{ unread_only?: boolean; cursor?: string; limit?: number }>('/notifications', 'get', query);
    return this.notifications.list(req.auth!.userId, q);
  }

  @Post('read-all')
  @HttpCode(200)
  @Roles('authenticated')
  readAll(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['NotificationReadAllResult']> {
    const input = validateBody<components['schemas']['NotificationReadAll']>('/notifications/read-all', 'post', body ?? {});
    return this.notifications.readAll(req.auth!.userId, input.before);
  }

  @Post(':id/read')
  @HttpCode(204)
  @Roles('authenticated')
  async read(@Param('id') id: string, @Req() req: Request): Promise<void> {
    await this.notifications.read(req.auth!.userId, id);
  }

  @Post(':id/ack')
  @HttpCode(204)
  @Roles('authenticated')
  async ack(@Param('id') id: string, @Req() req: Request): Promise<void> {
    await this.notifications.ack(req.principal!, id);
  }
}
