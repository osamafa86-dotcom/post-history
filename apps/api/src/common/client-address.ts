import { type BlockList, isIP } from 'node:net';
import type { Request } from 'express';
import { addressAllowed } from '../config/config';

/** الترويسة التي يمرر بها الـBFF عنوان العميل الذي خدمه (apps/web، server/auth.ts). */
export const CLIENT_ADDRESS_HEADER = 'x-client-address';

/**
 * عنوان العميل لحدود المعدل: من CLIENT_ADDRESS_HEADER حين يأتي الاتصال نفسه (عنوان المقبس، لا X-Forwarded-For) من
 * عنوان الـBFF الثابت المضبوط في BFF_SOURCE_ADDRESSES وحده، وكانت القيمة عنوانًا صالحًا؛ وإلا req.ip كما هو. من أي
 * مصدر آخر تُتجاهل الترويسة كليًا.
 */
export function clientAddress(req: Request, bff: BlockList): string {
  if (addressAllowed(bff, req.socket.remoteAddress)) {
    const forwarded = req.headers[CLIENT_ADDRESS_HEADER];
    const value = typeof forwarded === 'string' ? forwarded.trim() : '';
    if (isIP(value)) return value;
  }
  return req.ip ?? 'unknown';
}
