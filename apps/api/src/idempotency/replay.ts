import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

/**
 * مسار يحمل رده رمزًا لا يُحفظ (مثل upload_token): الرمز يُحذف من الرد المحفوظ، وعند الإعادة بالمفتاح نفسه
 * يبني هذا المعالج الرد من جديد (رمز جديد يبطل السابق) بدل إعادة رد بلا رمز.
 */
export interface ReplayRehydrator {
  rehydrate(stored: unknown, req: Request): Promise<unknown>;
}

export const REPLAY_KEY = 'idempotency:replay';
export const RehydrateOnReplay = (provider: new (...args: never[]) => ReplayRehydrator) => SetMetadata(REPLAY_KEY, provider);
