import { isMediaEvent, MEDIA_STREAM, mediaStreamFor, RENDER_STREAM } from '../../src/outbox/media-stream';
import type { OutboxRow } from '../../src/outbox/outbox.dispatcher';

describe('media:events selection', () => {
  const row = (type: string) => ({ type }) as OutboxRow;

  it('queues the received events for the media worker and upload.verified for the transcription worker', () => {
    for (const type of ['upload.original_received', 'upload.proxy_received', 'upload.verified']) expect(isMediaEvent(row(type))).toBe(true);
  });

  it('queues on-request work: export packages and the buyer watermarked preview on listing', () => {
    for (const type of ['export.requested', 'catalog.listing_changed']) expect(isMediaEvent(row(type))).toBe(true);
  });

  it('keeps every other event off the stream', () => {
    for (const type of ['upload.failed', 'upload.started', 'material.created', 'auth.recovery_approved']) expect(isMediaEvent(row(type))).toBe(false);
  });

  it('routes render requests to their own media:renders stream and keeps the other render events off both (ADR 0091)', () => {
    expect(mediaStreamFor(row('render.requested'))).toBe(RENDER_STREAM);
    expect(mediaStreamFor(row('export.requested'))).toBe(MEDIA_STREAM);
    for (const type of ['render.started', 'render.completed', 'render.failed']) expect(mediaStreamFor(row(type))).toBeNull();
  });
});
