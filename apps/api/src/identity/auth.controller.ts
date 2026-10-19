import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import type { components } from '../generated/api';
import { Public } from './auth.guard';
import { AuthService } from './auth.service';

type Session = components['schemas']['Session'];
type Me = components['schemas']['Me'];

// مسارات /auth/* مستثناة من Idempotency-Key (العقد): استجاباتها تحمل رموزًا ولا تُحفظ.
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request): Promise<Session> {
    const input = validateBody<components['schemas']['LoginRequest']>('/auth/login', 'post', body);
    return this.auth.login(input, req.ip ?? 'unknown');
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown): Promise<Session> {
    const input = validateBody<{ refresh_token: string }>('/auth/refresh', 'post', body);
    return this.auth.refresh(input.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = validateBody<{ all_sessions?: boolean }>('/auth/logout', 'post', body ?? {});
    await this.auth.logout(req.auth!.userId, req.auth!.sessionId, input.all_sessions ?? false);
  }

  @Get('me')
  me(@Req() req: Request): Promise<Me> {
    return this.auth.me(req.auth!.userId);
  }
}
