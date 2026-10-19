import { Module } from '@nestjs/common';
import { TusdHooksController } from './tusd-hooks.controller';
import { TusdHooksService } from './tusd-hooks.service';

@Module({
  controllers: [TusdHooksController],
  providers: [TusdHooksService],
})
export class UploadsModule {}
