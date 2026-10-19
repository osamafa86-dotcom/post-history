import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '../common/errors';
import { SessionService } from './session.service';

const PUBLIC_KEY = 'auth:public';
/** مسار بلا جلسة (الدخول، التحديث، الصحة، خطّاف tusd ذو الرمز الخاص). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare module 'express' {
  interface Request {
    auth?: AuthContext;
  }
}

// حارس عام: كل مسار يتطلب جلسة صالحة ما لم يُعلَّم Public. الإبطال يُفحص عند كل طلب (SEC-02).
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/.exec(header) : null;
    if (!match) throw ApiError.unauthorized();
    const auth = await this.sessions.authenticate(match[1]!);
    if (!auth) throw ApiError.unauthorized();
    req.auth = auth;
    return true;
  }
}
