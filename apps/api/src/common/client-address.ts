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

/**
 * مفتاح حد المعدل من العنوان: IPv6 يُجمَّع على /64 (العميل الواحد يملك الشبكة كلها فيدور عليها)، وIPv4 والمعيَّن
 * عليه (::ffff:a.b.c.d) كما هو. ما ليس عنوانًا يُعاد كما هو.
 */
export function rateLimitBucket(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  const bare = address.split('%')[0]!.toLowerCase();
  const [head, tail = ''] = bare.split('::');
  const left = head ? head.split(':') : [];
  const right = bare.includes('::') && tail ? tail.split(':') : [];
  const groups = bare.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
