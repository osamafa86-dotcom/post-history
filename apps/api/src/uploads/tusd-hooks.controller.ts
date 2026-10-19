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
  async handle(@Param('hook_token') token: string, @Body() body: unknown): Promise<TusdHookResponse> {
    // الرمز أولًا وقبل أي قراءة للجسم: رمز خاطئ = 401 دون أثر
    if (!this.validToken(token)) throw ApiError.unauthorized();
    let hook: TusdHookRequest;
    try {
      hook = validateBody<TusdHookRequest>('/internal/tusd-hooks/{hook_token}', 'post', body);
    } catch (err) {
      // pre-create حقيقي من tusd (فيه Event.Upload) بلا upload_session_id صالح طلبُ عميل خاطئ لا عطل خادم:
      // رفض بصيغة tusd (400 للعميل)، لأن 422 هنا يحوّله tusd إلى 500 فيعيد العملاء المحاولة بلا نهاية.
      // الجسم الذي ليس بصيغة tusd أصلًا يبقى 422 كما في العقد.
      const b = body as { Type?: unknown; Event?: { Upload?: unknown } } | null;
      if (b?.Type === 'pre-create' && b.Event?.Upload && typeof b.Event.Upload === 'object') {
        return { RejectUpload: true, HTTPResponse: { StatusCode: 400, Body: 'upload_session_id metadata is required' } };
      }
      throw err;
    }
    return this.hooks.handle(hook);
  }

  /** الرمز الحالي، أو السابق في فترة التدوير الانتقالية. المقارنتان تُحسبان دائمًا (زمن ثابت). */
  private validToken(token: string): boolean {
    const current = constantTimeEqual(token, this.config.TUSD_HOOK_SECRET);
    const { TUSD_HOOK_SECRET_PREVIOUS: previous, TUSD_HOOK_SECRET_PREVIOUS_UNTIL: until } = this.config;
    const previousOk = previous ? constantTimeEqual(token, previous) : false;
    return current || (previousOk && Date.now() < Date.parse(until!));
  }
}
