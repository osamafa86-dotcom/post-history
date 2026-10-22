import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { validateBody } from '../common/contract';
import { constantTimeEqual } from '../common/crypto';
import { ApiError } from '../common/errors';
import { Public } from '../identity/auth.guard';
import type { components } from '../generated/api';
import { type MediaDerivativeBody, MediaService, type MediaSessionView, type MediaVerificationBody, type MediaVerificationResult } from './media.service';

/**
 * نقاط عامل الوسائط (ADR 0006، x-internal في العقد v0.1): خارج /v1 وخارج حارس الجلسات، ومقصورة على INTERNAL_ALLOWED_CIDRS.
 * المصادقة بترويسة `Authorization: Bearer <MEDIA_WORKER_TOKEN>` (منفصل عن رمز tusd)، مقارنة ثابتة الزمن، والترويسة
 * لا تُسجَّل (السجل يحمل المسار والحالة فقط). أي فشل في المصادقة، أو رمز غير مضبوط، = 404 كبقية /internal/*.
 * `AI_WORKER_TOKEN` (عامل التفريغ) يُقبل على نقطة المشتقات وحدها ولنوعي AI_DERIVATIVE_KINDS وحدهما؛ غيرها = 404.
 */
const AI_DERIVATIVE_KINDS: ReadonlySet<unknown> = new Set(['transcript', 'captions']);

@Controller('internal/media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('sessions/:id')
  session(@Headers('authorization') auth: string | undefined, @Param('id') id: string): Promise<MediaSessionView> {
    this.authorize(auth);
    return this.media.session(id);
  }

  @Public()
  @Post('sessions/:id/verification')
  @HttpCode(200)
  verify(@Headers('authorization') auth: string | undefined, @Param('id') id: string, @Body() body: unknown): Promise<MediaVerificationResult> {
    this.authorize(auth);
    return this.media.verify(id, validateBody<MediaVerificationBody>('/internal/media/sessions/{upload_session_id}/verification', 'post', body));
  }

  @Public()
  @Get('files/:file_id')
  file(@Headers('authorization') auth: string | undefined, @Param('file_id') fileId: string): Promise<components['schemas']['MediaSourceFile']> {
    this.authorize(auth);
    return this.media.file(fileId);
  }

  @Public()
  @Post('files/:file_id/derivatives')
  @HttpCode(200)
  derive(@Headers('authorization') auth: string | undefined, @Param('file_id') fileId: string, @Body() body: unknown): Promise<{ file_id: string }> {
    const kind = (body as { kind?: unknown } | null)?.kind;
    this.authorize(auth, AI_DERIVATIVE_KINDS.has(kind) ? this.config.AI_WORKER_TOKEN : undefined);
    return this.media.derive(fileId, validateBody<MediaDerivativeBody>('/internal/media/files/{file_id}/derivatives', 'post', body));
  }

  private authorize(header: string | undefined, alternate?: string): void {
    const expected = this.config.MEDIA_WORKER_TOKEN;
    const presented = /^Bearer (\S+)$/.exec(header ?? '')?.[1] ?? '';
    // المقارنتان تُحسبان دائمًا (حتى بلا رمز مضبوط) فلا يكشف الزمن شيئًا
    const ok = constantTimeEqual(presented, expected ?? '');
    const okAlternate = constantTimeEqual(presented, alternate ?? '');
    if (!((expected && ok) || (alternate && okAlternate))) throw ApiError.notFound();
  }
}
