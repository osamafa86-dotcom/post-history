import { Global, Module } from '@nestjs/common';
import { PlatformSettingsController, PlatformSettingsService } from './platform-settings.controller';
import { ReporterIdentityController } from './reporter-identity.controller';
import { ReporterIdentitySettings } from './reporter-identity.service';

@Global()
@Module({
  controllers: [ReporterIdentityController, PlatformSettingsController],
  providers: [ReporterIdentitySettings, PlatformSettingsService],
  exports: [ReporterIdentitySettings],
})
export class SettingsModule {}
