import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { validateBody } from '../common/contract';
import { constantTimeEqual } from '../common/crypto';
import { ApiError } from '../common/errors';
import { Public } from '../identity/auth.guard';
import { type TusdHookRequest, type TusdHookResponse, TusdHooksService } from './tusd-hooks.service';

// خارج /v1 وخارج حارس الجلسات: المصادقة برمز المسار (TUSD_HOOK_SECRET) + العزل الشبكي (ADR SEC-06).
// المسار يُسجَّل بعد حجب الرمز (common/logger.ts)، وترويسة Authorization المُمرَّرة لا تُسجَّل أبدًا.
@Controller('internal/tusd-hooks')
export class TusdHooksController {
  constructor(
    private readonly hooks: TusdHooksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post(':hook_token')
  @HttpCode(200)
  handle(@Param('hook_token') token: string, @Body() body: unknown): Promise<TusdHookResponse> {
    // الرمز أولًا وقبل أي قراءة للجسم: رمز خاطئ = 401 دون أثر
    if (!constantTimeEqual(token, this.config.TUSD_HOOK_SECRET)) throw ApiError.unauthorized();
    const hook = validateBody<TusdHookRequest>('/internal/tusd-hooks/{hook_token}', 'post', body);
    return this.hooks.handle(hook);
  }
}
