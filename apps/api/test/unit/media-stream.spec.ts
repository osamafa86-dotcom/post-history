import { isMediaEvent } from '../../src/outbox/media-stream';
import type { OutboxRow } from '../../src/outbox/outbox.dispatcher';

describe('media:events selection', () => {
  const row = (type: string) => ({ type }) as OutboxRow;

  it('queues the received events for the media worker and upload.verified for the transcription worker', () => {
    for (const type of ['upload.original_received', 'upload.proxy_received', 'upload.verified']) expect(isMediaEvent(row(type))).toBe(true);
  });

  it('keeps every other event off the stream', () => {
    for (const type of ['upload.failed', 'upload.started', 'material.created', 'auth.recovery_approved']) expect(isMediaEvent(row(type))).toBe(false);
  });
});
