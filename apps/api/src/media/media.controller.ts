import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { constantTimeEqual } from '../common/crypto';
import { ApiError } from '../common/errors';
import { Public } from '../identity/auth.guard';
import { type MediaDerivativeBody, type MediaVerificationBody, validateMediaBody } from './media-schemas';
import { MediaService, type MediaSessionView, type MediaVerificationResult } from './media.service';

/**
 * نقاط عامل الوسائط (ADR 0006، x-internal): خارج /v1 وخارج حارس الجلسات، ومقصورة على INTERNAL_ALLOWED_CIDRS.
 * المصادقة بترويسة `Authorization: Bearer <MEDIA_WORKER_TOKEN>` (منفصل عن رمز tusd)، مقارنة ثابتة الزمن، والترويسة
 * لا تُسجَّل (السجل يحمل المسار والحالة فقط). أي فشل في المصادقة، أو رمز غير مضبوط، = 404 كبقية /internal/*.
 */
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
    return this.media.verify(id, validateMediaBody<MediaVerificationBody>('verification', body));
  }

  @Public()
  @Post('files/:file_id/derivatives')
  @HttpCode(200)
  derive(@Headers('authorization') auth: string | undefined, @Param('file_id') fileId: string, @Body() body: unknown): Promise<{ file_id: string }> {
    this.authorize(auth);
    return this.media.derive(fileId, validateMediaBody<MediaDerivativeBody>('derivative', body));
  }

  private authorize(header: string | undefined): void {
    const expected = this.config.MEDIA_WORKER_TOKEN;
    const presented = /^Bearer (\S+)$/.exec(header ?? '')?.[1] ?? '';
    // المقارنة تُحسب دائمًا (حتى بلا رمز مضبوط) فلا يكشف الزمن شيئًا
    const ok = constantTimeEqual(presented, expected ?? '');
    if (!expected || !ok) throw ApiError.notFound();
  }
}
