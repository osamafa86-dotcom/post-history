import { Module } from '@nestjs/common';
import { TusdHooksController } from './tusd-hooks.controller';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { TusdHooksService } from './tusd-hooks.service';

@Module({
  controllers: [TusdHooksController, UploadsController],
  providers: [TusdHooksService, UploadsService],
})
export class UploadsModule {}
