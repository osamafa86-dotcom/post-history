import { Module } from '@nestjs/common';
import { TusdHooksController } from './tusd-hooks.controller';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { TusdHooksService } from './tusd-hooks.service';
import { UploadReconciler } from './upload-reconciler';
import { VerificationModule } from '../verification/verification.module';

@Module({
  imports: [VerificationModule],
  controllers: [TusdHooksController, UploadsController],
  providers: [TusdHooksService, UploadsService, UploadReconciler],
})
export class UploadsModule {}
