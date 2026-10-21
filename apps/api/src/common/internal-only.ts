import type { NextFunction, Request, Response } from 'express';
import type { BlockList } from 'node:net';
import { addressAllowed, blockListOf, type InternalSource } from '../config/config';

/**
 * /internal/* لا يُخدم إلا لعناوين المقبس في INTERNAL_ALLOWED_CIDRS (شبكة compose الداخلية) أو في INTERNAL_SOURCE_PATHS.
 * عنوان المقبس لا X-Forwarded-For: الوكيل العام لا يستطيع انتحاله. الرفض 404 حتى لا تُكشف النقطة.
 * العنوان المطابق لمصدر مقيّد يصل إلى بادئات مساراته وحدها، وما سواها 403 بلا جسم مهما حمل من أسرار؛ المسار الخام
 * يُفحص قبل التوجيه، وأي مقطع نقطي أو ترميز نسبي فيه رفض.
 */
export function internalOnly(allowed: BlockList, sources: InternalSource[] = []) {
  const restricted = sources.map((s) => ({ list: blockListOf([s.cidr]), prefixes: s.prefixes }));
  return (req: Request, res: Response, next: NextFunction): void => {
    const address = req.socket.remoteAddress;
    const matching = restricted.filter((r) => addressAllowed(r.list, address));
    if (matching.length > 0) {
      const path = req.originalUrl.split('?')[0] ?? '';
      const plain = !/%|\\|\/\.{1,2}(\/|$)|\/\//.test(path);
      if (plain && matching.some((r) => r.prefixes.some((p) => path.startsWith(p)))) return next();
      res.status(403).end();
      return;
    }
    if (addressAllowed(allowed, address)) return next();
    res.status(404).json({ code: 'not_found', message: 'Not found.', request_id: req.id ?? '' });
  };
}
