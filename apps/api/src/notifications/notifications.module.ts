import { Module } from '@nestjs/common';
import { EscalationWorker } from './escalation.worker';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, EscalationWorker],
})
export class NotificationsModule {}
