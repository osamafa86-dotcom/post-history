import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { IdentityModule } from '../identity/identity.module';
import { ChallengeStore } from './challenge-store';
import { DeviceAttestationController } from './device-attestation.controller';
import { DeviceAttestationService, PLAY_INTEGRITY_DECODER, playIntegrityDecoderFor } from './device-attestation.service';

@Module({
  imports: [IdentityModule],
  controllers: [DeviceAttestationController],
  providers: [
    ChallengeStore,
    DeviceAttestationService,
    { provide: PLAY_INTEGRITY_DECODER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => playIntegrityDecoderFor(config) },
  ],
})
export class AttestationModule {}
