import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AccountService } from './account.service';
import { AuthController, UserStatusController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { JWT_OPTIONS, SessionService } from './session.service';
import { RateLimitsService } from './rate-limits.service';
import { InlineResetTokenDelivery, RESET_TOKEN_DELIVERY } from './reset-token-delivery';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.JWT_SECRET,
        signOptions: { algorithm: JWT_OPTIONS.algorithm, issuer: JWT_OPTIONS.issuer },
        verifyOptions: { algorithms: [JWT_OPTIONS.algorithm], issuer: JWT_OPTIONS.issuer },
      }),
    }),
  ],
  controllers: [AuthController, UserStatusController],
  providers: [
    SessionService,
    AuthService,
    AccountService,
    RateLimitsService,
    { provide: RESET_TOKEN_DELIVERY, useClass: InlineResetTokenDelivery },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, RateLimitsService],
})
export class IdentityModule {}
