import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { JWT_OPTIONS, SessionService } from './session.service';

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
  controllers: [AuthController],
  providers: [SessionService, AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionService],
})
export class IdentityModule {}
