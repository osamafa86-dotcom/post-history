import { Module } from '@nestjs/common';
import { InboxOutboxPublisher, OUTBOX_PUBLISHER, OutboxDispatcher } from './outbox.dispatcher';

@Module({
  providers: [{ provide: OUTBOX_PUBLISHER, useClass: InboxOutboxPublisher }, OutboxDispatcher],
  exports: [OutboxDispatcher],
})
export class OutboxModule {}
