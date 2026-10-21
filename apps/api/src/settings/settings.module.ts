import { Global, Module } from '@nestjs/common';
import { ReporterIdentityController } from './reporter-identity.controller';
import { ReporterIdentitySettings } from './reporter-identity.service';

@Global()
@Module({ controllers: [ReporterIdentityController], providers: [ReporterIdentitySettings], exports: [ReporterIdentitySettings] })
export class SettingsModule {}
