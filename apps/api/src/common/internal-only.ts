import type { NextFunction, Request, Response } from 'express';
import type { BlockList } from 'node:net';
import { addressAllowed } from '../config/config';

/**
 * /internal/* لا يُخدم إلا لعناوين المقبس في INTERNAL_ALLOWED_CIDRS (شبكة compose الداخلية).
 * عنوان المقبس لا X-Forwarded-For: الوكيل العام لا يستطيع انتحاله. الرفض 404 حتى لا تُكشف النقطة.
 */
export function internalOnly(allowed: BlockList) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (addressAllowed(allowed, req.socket.remoteAddress)) return next();
    res.status(404).json({ code: 'not_found', message: 'Not found.', request_id: req.id ?? '' });
  };
}
