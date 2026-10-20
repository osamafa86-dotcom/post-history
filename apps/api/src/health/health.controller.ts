import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BlockList } from 'node:net';
import type { Request, Response } from 'express';
import { addressAllowed, APP_CONFIG, type AppConfig, blockListOf } from '../config/config';
import { DB, type Database } from '../database/database.module';
import { Public } from '../identity/auth.guard';
import { RateLimitsService } from '../identity/rate-limits.service';

// فحص تشغيلي خارج /v1 (داخلي في العقد v0.1)؛ لا يكشف إصدارات ولا تفاصيل أخطاء. يبقى متاحًا لفحوص الحافة والحاويات
// بجسم {status} وحده؛ حال حد المعدل (الحقل وترويسة X-Rate-Limiter) لعناوين المقبس في INTERNAL_ALLOWED_CIDRS فقط،
// لأنه يخبر المهاجم أن توزيع المحاولات عبر النسخ يتجاوز الحد (مراجعة الأمن على #69).
@Controller('health')
export class HealthController {
  private readonly internal: BlockList;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly limits: RateLimitsService,
  ) {
    this.internal = blockListOf(config.INTERNAL_ALLOWED_CIDRS);
  }

  @Public()
  @Get()
  async health(@Req() req: Request, @Res() res: Response): Promise<void> {
    const internal = addressAllowed(this.internal, req.socket.remoteAddress);
    const rateLimiter = internal ? { rate_limiter: this.limits.mode() } : {};
    if (rateLimiter.rate_limiter === 'degraded') res.setHeader('X-Rate-Limiter', 'degraded');
    try {
      await this.db.execute(sql`SELECT 1`);
      res.status(200).json({ status: 'ok', ...rateLimiter });
    } catch {
      res.status(503).json({ status: 'unavailable', ...rateLimiter });
    }
  }
}
