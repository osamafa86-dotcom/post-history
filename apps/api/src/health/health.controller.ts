import { Controller, Get, Inject, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DB, type Database } from '../database/database.module';
import { Public } from '../identity/auth.guard';
import { RateLimitsService } from '../identity/rate-limits.service';

// فحص تشغيلي خارج /v1 (داخلي في العقد v0.1)؛ لا يكشف إصدارات ولا تفاصيل أخطاء. حال حد المعدل هنا وحده: ترويسة
// X-Rate-Limiter لا تُرسل على أي مسار عام لأنها تخبر المهاجم أن توزيع المحاولات عبر النسخ يتجاوز الحد.
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly limits: RateLimitsService,
  ) {}

  @Public()
  @Get()
  async health(@Res() res: Response): Promise<void> {
    const rateLimiter = this.limits.mode();
    if (rateLimiter === 'degraded') res.setHeader('X-Rate-Limiter', 'degraded');
    try {
      await this.db.execute(sql`SELECT 1`);
      res.status(200).json({ status: 'ok', rate_limiter: rateLimiter });
    } catch {
      res.status(503).json({ status: 'unavailable', rate_limiter: rateLimiter });
    }
  }
}
