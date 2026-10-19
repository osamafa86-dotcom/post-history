import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import type { components } from '../generated/api';
import { RehydrateOnReplay } from '../idempotency/replay';
import { Roles } from '../identity/principal';
import { UploadsService } from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * ينشئ جلسة رفع برمز يظهر مرة واحدة. الرمز يُقبل في خطّاف pre-create ما دامت الجلسة `created` فقط، ويفتح إنشاء رفع
   * واحد؛ الاستئناف (HEAD/PATCH) لا يحتاجه. إعادة الطلب بالمفتاح نفسه تصدر رمزًا جديدًا ما دامت `created`، وبعدها 409
   * `upload_state_conflict` وتلزم جلسة جديدة.
   * - TUSD_POST_CREATE_HOOK=false: الجلسة تصير `in_progress` عند قبول pre-create، فإن فشل الإنشاء لدى tusd بعده لزمت
   *   جلسة جديدة.
   * - TUSD_POST_CREATE_HOOK=true: تبقى `created` حتى post-create (نجاح الإنشاء)، ففشل الإنشاء يُعاد بالرمز نفسه.
   *   قبول pre-create يحجز الجلسة (TUSD_PRE_CREATE_RESERVATION_SECONDS، افتراضي 60 ث)، وأي pre-create آخر يُرفض حتى
   *   post-create أو انقضاء الحجز؛ لأن tusd لا يرفض المعرّف المكرّر فيتشارك إنشاءان الكائن نفسه. إعادة المحاولة
   *   بعد فشل الإنشاء تنتظر انقضاء الحجز.
   */
  @Post()
  @Roles('reporter')
  @RehydrateOnReplay(UploadsService)
  create(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['UploadSessionCreated']> {
    return this.uploads.create(req.principal!, validateBody('/uploads', 'post', body));
  }

  @Get(':id')
  @Roles('reporter', 'supervisor', 'editor_in_chief', 'system_admin')
  get(@Param('id') id: string, @Req() req: Request): Promise<components['schemas']['UploadSession']> {
    return this.uploads.get(req.principal!, id);
  }

  @Post(':id/complete')
  @HttpCode(202)
  @Roles('reporter')
  async complete(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = validateBody<components['schemas']['UploadComplete']>('/uploads/{id}/complete', 'post', body ?? {});
    await this.uploads.complete(req.principal!, id, input.reported_sha256);
  }
}
