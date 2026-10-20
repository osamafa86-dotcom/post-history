import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import { Roles } from '../identity/principal';
import { type NotificationRule, type NotificationRuleInput, NotificationRulesService } from './notification-rules.service';

// الأدوار كما في x-roles بالعقد: القراءة للإدارة ورئيس التحرير، والكتابة لمدير النظام وحده
@Controller('notification-rules')
export class NotificationRulesController {
  constructor(private readonly rules: NotificationRulesService) {}

  @Get()
  @Roles('system_admin', 'editor_in_chief')
  list(): Promise<{ items: NotificationRule[] }> {
    return this.rules.list();
  }

  @Post()
  @Roles('system_admin')
  create(@Body() body: unknown, @Req() req: Request): Promise<NotificationRule> {
    return this.rules.create(req.principal!.userId, validateBody<NotificationRuleInput>('/notification-rules', 'post', body));
  }

  @Get(':ruleId')
  @Roles('system_admin', 'editor_in_chief')
  get(@Param('ruleId') id: string): Promise<NotificationRule> {
    return this.rules.get(id);
  }

  @Put(':ruleId')
  @Roles('system_admin')
  replace(@Param('ruleId') id: string, @Body() body: unknown, @Req() req: Request, @Headers('if-match') ifMatch?: string): Promise<NotificationRule> {
    const input = validateBody<NotificationRuleInput>('/notification-rules/{rule_id}', 'put', body);
    return this.rules.replace(req.principal!.userId, id, input, ifMatch);
  }

  @Delete(':ruleId')
  @HttpCode(204)
  @Roles('system_admin')
  async remove(@Param('ruleId') id: string, @Req() req: Request, @Headers('if-match') ifMatch?: string): Promise<void> {
    await this.rules.remove(req.principal!.userId, id, ifMatch);
  }
}
