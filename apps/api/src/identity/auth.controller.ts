import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { BlockList } from 'node:net';
import type { Request } from 'express';
import { clientAddress } from '../common/client-address';
import { validateBody } from '../common/contract';
import { APP_CONFIG, type AppConfig, blockListOf } from '../config/config';
import type { components } from '../generated/api';
import { AllowDuringCredentialReset, Public } from './auth.guard';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { Roles } from './principal';

type Session = components['schemas']['Session'];
type Me = components['schemas']['Me'];

// مسارات /auth/* مستثناة من Idempotency-Key (العقد): استجاباتها تحمل رموزًا ولا تُحفظ، ومنها رمز إعادة التعيين في
// استجابة اعتماد الاستعادة (إعادة الاعتماد 409 ولا تعيده).
@Controller('auth')
export class AuthController {
  private readonly bff: BlockList;

  constructor(
    private readonly auth: AuthService,
    private readonly account: AccountService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.bff = blockListOf(config.BFF_SOURCE_ADDRESSES);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request): Promise<Session> {
    const input = validateBody<components['schemas']['LoginRequest']>('/auth/login', 'post', body);
    return this.auth.login(input, clientAddress(req, this.bff));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown): Promise<Session> {
    const input = validateBody<{ refresh_token: string }>('/auth/refresh', 'post', body);
    return this.auth.refresh(input.refresh_token);
  }

  @Post('logout')
  @AllowDuringCredentialReset()
  @HttpCode(204)
  async logout(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = validateBody<{ all_sessions?: boolean }>('/auth/logout', 'post', body ?? {});
    await this.auth.logout(req.auth!.userId, req.auth!.sessionId, input.all_sessions ?? false);
  }

  @Get('me')
  @AllowDuringCredentialReset()
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
    await this.account.startRecovery(input.email, input.backup_code, clientAddress(req, this.bff));
    return { accepted: true };
  }

  @Post('recovery/:id/approve')
  @HttpCode(200)
  @Roles('supervisor', 'system_admin')
  approveRecovery(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<components['schemas']['RecoveryApproval']> {
    const input = validateBody<{ verification_note: string }>('/auth/recovery/{id}/approve', 'post', body);
    return this.account.approveRecovery(req.principal!, id, input.verification_note);
  }

  @Public()
  @Post('recovery/complete')
  @HttpCode(200)
  completeRecovery(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['RecoveryCompletion']> {
    const input = validateBody<{ reset_token: string; new_password: string }>('/auth/recovery/complete', 'post', body);
    return this.auth.completeRecovery(input.reset_token, input.new_password, clientAddress(req, this.bff));
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @Roles('authenticated')
  @AllowDuringCredentialReset()
  confirmTotp(@Body() body: unknown, @Req() req: Request): Promise<Session> {
    const input = validateBody<{ totp_code: string }>('/auth/totp/confirm', 'post', body);
    return this.auth.confirmTotp(req.auth!.userId, input.totp_code);
  }
}

@Controller('users/:id/work-name')
export class UserWorkNameController {
  constructor(private readonly account: AccountService) {}
  @Put()
  @HttpCode(204)
  @Roles('system_admin')
  async set(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = validateBody<{ work_name: string | null }>('/users/{id}/work-name', 'put', body);
    await this.account.setWorkName(req.principal!, id, input.work_name);
  }
}

@Controller('users/:id/status')
export class UserStatusController {
  constructor(private readonly account: AccountService) {}

  @Put()
  @HttpCode(204)
  @Roles('system_admin')
  async setStatus(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = validateBody<{ status: 'active' | 'suspended' }>('/users/{id}/status', 'put', body);
    await this.account.setUserStatus(req.principal!, id, input.status);
  }
}
