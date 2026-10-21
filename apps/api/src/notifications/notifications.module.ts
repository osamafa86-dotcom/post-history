import { Module } from '@nestjs/common';
import { EscalationWorker } from './escalation.worker';
import { NotificationRulesController } from './notification-rules.controller';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController, NotificationRulesController],
  providers: [NotificationsService, NotificationRulesService, EscalationWorker],
})
export class NotificationsModule {}
