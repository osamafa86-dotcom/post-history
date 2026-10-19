import { Controller, Get, Inject, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DB, type Database } from '../database/database.module';
import { Public } from '../identity/auth.guard';

// فحص تشغيلي خارج /v1 وخارج العقد؛ لا يكشف إصدارات ولا تفاصيل أخطاء.
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Public()
  @Get()
  async health(@Res() res: Response): Promise<void> {
    try {
      await this.db.execute(sql`SELECT 1`);
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  }
}
