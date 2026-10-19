import { Module } from '@nestjs/common';
import { LogOutboxPublisher, OUTBOX_PUBLISHER, OutboxDispatcher } from './outbox.dispatcher';

@Module({
  providers: [{ provide: OUTBOX_PUBLISHER, useClass: LogOutboxPublisher }, OutboxDispatcher],
  exports: [OutboxDispatcher],
})
export class OutboxModule {}
