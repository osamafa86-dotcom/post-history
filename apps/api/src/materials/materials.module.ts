import { Module } from '@nestjs/common';
import { FormsModule } from '../forms/forms.module';
import { VerificationModule } from '../verification/verification.module';
import { FileDownloadService } from './file-download.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

@Module({
  imports: [FormsModule, VerificationModule],
  controllers: [MaterialsController],
  providers: [MaterialsService, FileDownloadService],
})
export class MaterialsModule {}
