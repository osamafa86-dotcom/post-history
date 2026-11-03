import { Body, Controller, Get, Headers, HttpCode, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { TagsService } from './tags.service';

type TagSuggestions = components['schemas']['TagSuggestions'];

/**
 * إدارة الوسوم (ADR 0098). الأدوار كما في x-roles بالعقد: القائمة المقترحة يقرؤها من يكتب وسوم المواد، والكتابة والاستعمال
 * والدمج لمدير النظام وحده.
 */
@Controller()
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get('tag-suggestions')
  @Roles('reporter', 'supervisor', 'editor_in_chief', 'system_admin')
  async suggestions(@Res({ passthrough: true }) res: Response): Promise<TagSuggestions> {
    return etag(res, await this.tags.suggestions());
  }

  @Put('tag-suggestions')
  @Roles('system_admin')
  async replace(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ): Promise<TagSuggestions> {
    const input = validateBody<components['schemas']['TagSuggestionsUpdate']>('/tag-suggestions', 'put', body);
    return etag(res, await this.tags.replaceSuggestions(req.principal!.userId, input, ifMatch));
  }

  @Get('tags')
  @Roles('system_admin')
  usage(@Query() query: Record<string, unknown>): Promise<components['schemas']['TagUsagePage']> {
    return this.tags.usage(validateQuery<{ q?: string; suggested?: boolean; cursor?: string; limit?: number }>('/tags', 'get', query));
  }

  @Post('tag-rewrites')
  @HttpCode(201)
  @Roles('system_admin')
  rewrite(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['TagRewrite']> {
    return this.tags.rewrite(req.principal!.userId, validateBody('/tag-rewrites', 'post', body));
  }
}

/** ETag هو إصدار القائمة. */
function etag(res: Response, list: TagSuggestions): TagSuggestions {
  res.setHeader('ETag', `"${list.version}"`);
  return list;
}
