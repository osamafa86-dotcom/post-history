import { Module } from '@nestjs/common';
import { PushDevicesController } from './push-devices.controller';

@Module({ controllers: [PushDevicesController] })
export class PushDevicesModule {}
