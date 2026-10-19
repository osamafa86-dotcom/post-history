import { Module } from '@nestjs/common';
import { VerificationModule } from '../verification/verification.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [VerificationModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
