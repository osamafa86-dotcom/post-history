import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { BlockList } from 'node:net';
import type { Request } from 'express';
import { clientAddress } from '../common/client-address';
import { validateBody } from '../common/contract';
import { APP_CONFIG, type AppConfig, blockListOf } from '../config/config';
import type { components } from '../generated/api';
import { Public } from './auth.guard';
import { PasskeysService } from './passkeys.service';
import { Roles } from './principal';

type PasskeyChallenge = components['schemas']['PasskeyChallenge'];

// خيارات الإنشاء والطلب والدخول تحت /auth/* بلا Idempotency-Key (العقد): ردودها تحمل تحديًا أو رموز جلسة لا تُحفظ في جدول المفاتيح.
@Controller('auth/passkeys')
export class PasskeyAuthController {
  private readonly bff: BlockList;

  constructor(
    private readonly passkeys: PasskeysService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.bff = blockListOf(config.BFF_SOURCE_ADDRESSES);
  }

  @Post('registration-options')
  @HttpCode(200)
  @Roles('authenticated')
  registrationOptions(@Body() body: unknown, @Req() req: Request): Promise<PasskeyChallenge> {
    const input = validateBody<components['schemas']['PasskeyStepUp']>('/auth/passkeys/registration-options', 'post', body);
    return this.passkeys.registrationOptions(req.auth!.userId, input);
  }

  @Public()
  @Post('login-options')
  @HttpCode(200)
  loginOptions(@Req() req: Request): Promise<PasskeyChallenge> {
    return this.passkeys.loginOptions(clientAddress(req, this.bff));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['Session']> {
    const input = validateBody<components['schemas']['PasskeyAssertion']>('/auth/passkeys/login', 'post', body);
    return this.passkeys.login(input, clientAddress(req, this.bff));
  }
}

// إدارة مفاتيح المستدعي: كتابات بـ Idempotency-Key وردودها بلا تحدٍّ ولا معرّف اعتماد.
@Controller('me/passkeys')
export class MyPasskeysController {
  constructor(private readonly passkeys: PasskeysService) {}

  @Get()
  @Roles('authenticated')
  async list(@Req() req: Request): Promise<components['schemas']['PasskeyList']> {
    return { items: await this.passkeys.list(req.auth!.userId) };
  }

  @Post()
  @HttpCode(201)
  @Roles('authenticated')
  register(@Body() body: unknown, @Req() req: Request): Promise<components['schemas']['Passkey']> {
    const input = validateBody<components['schemas']['PasskeyRegistration']>('/me/passkeys', 'post', body);
    return this.passkeys.register(req.auth!.userId, input);
  }

  @Delete(':passkey_id')
  @HttpCode(204)
  @Roles('authenticated')
  async revoke(@Param('passkey_id') id: string, @Req() req: Request): Promise<void> {
    await this.passkeys.revoke(req.auth!.userId, id);
  }
}
