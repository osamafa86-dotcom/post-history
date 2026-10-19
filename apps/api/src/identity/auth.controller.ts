import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import type { components } from '../generated/api';
import { Public } from './auth.guard';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { Roles } from './principal';

type Session = components['schemas']['Session'];
type Me = components['schemas']['Me'];

// مسارات /auth/* مستثناة من Idempotency-Key (العقد): استجاباتها تحمل رموزًا ولا تُحفظ.
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly account: AccountService,
  ) {}

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

  @Get('sessions')
  @Roles('authenticated')
  async sessions(@Req() req: Request): Promise<{ items: components['schemas']['UserSession'][] }> {
    return { items: await this.account.listSessions(req.auth!.userId, req.auth!.sessionId) };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @Roles('authenticated')
  async revokeSession(@Param('id') id: string, @Req() req: Request): Promise<void> {
    await this.account.revokeSession(req.principal!, id);
  }

  @Public()
  @Post('recovery')
  @HttpCode(202)
  async startRecovery(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['RecoveryAccepted']> {
    const input = validateBody<{ email: string; backup_code: string }>('/auth/recovery', 'post', body);
    await this.account.startRecovery(input.email, input.backup_code, req.ip ?? 'unknown');
    return { accepted: true };
  }

  @Post('recovery/:id/approve')
  @HttpCode(200)
  @Roles('supervisor', 'system_admin')
  approveRecovery(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<components['schemas']['RecoveryRequest']> {
    const input = validateBody<{ verification_note: string }>('/auth/recovery/{id}/approve', 'post', body);
    return this.account.approveRecovery(req.principal!, id, input.verification_note);
  }
}
