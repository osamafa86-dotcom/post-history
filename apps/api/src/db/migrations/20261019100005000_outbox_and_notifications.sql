-- Up Migration
-- Outbox: الحدث يُكتب في معاملة الحفظ نفسها؛ المُرسل يقرأ بـ FOR UPDATE SKIP LOCKED ويعلّم published_at.
-- الإشعارات تبقى في صندوق الوارد حتى لو فشلت قناة الهاتف؛ حالة التسليم لكل قناة في جدول مستقل.

CREATE TABLE outbox_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type            text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL,
  actor_id        uuid REFERENCES users (id),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  CONSTRAINT outbox_events_type_check CHECK (type IN (
    'material.created', 'material.urgent_received', 'material.updated', 'material.version_created',
    'material.technical_transition', 'material.editorial_transition', 'material.rights_transition',
    'material.acknowledged', 'material.change_requested', 'material.accepted_for_production',
    'material.reserved', 'material.released', 'material.contributors_set', 'material.published',
    'upload.started', 'upload.proxy_received', 'upload.original_received', 'upload.verified',
    'upload.deduplicated', 'upload.failed',
    'form.published', 'ai.draft_ready', 'notification.escalated',
    'auth.recovery_requested', 'auth.recovery_approved')),
  CONSTRAINT outbox_events_aggregate_type_check CHECK (aggregate_type IN ('material', 'upload', 'notification', 'form', 'user')),
  CONSTRAINT outbox_events_idempotency_key_len CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT outbox_events_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT outbox_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  -- الحمولة قد تصل إلى قنوات خارجية: لا إحداثيات ولا معرّفات أجهزة ولا رموز دفع
  CONSTRAINT outbox_events_payload_no_pii CHECK (NOT (payload ?| ARRAY['gps', 'lat', 'lng', 'device_id', 'push_token'])),
  CONSTRAINT outbox_events_attempts_nonneg CHECK (attempts >= 0)
);
-- طابور المُرسل: ما لم يُنشر بعد، بترتيب الوصول
CREATE INDEX outbox_events_pending_idx ON outbox_events (next_attempt_at, id) WHERE published_at IS NULL;
-- تاريخ المجمّع (مادة أو رفع)
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id, id);
-- GET /events?type=&after=
CREATE INDEX outbox_events_type_idx ON outbox_events (type, id);

CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_id         bigint NOT NULL REFERENCES outbox_events (id),
  type             text NOT NULL,
  material_id      uuid REFERENCES materials (id) ON DELETE SET NULL,
  title            text NOT NULL,                      -- رقم المادة وحالتها فقط؛ لا أسماء محمية ولا موقع دقيق
  priority         text NOT NULL DEFAULT 'normal',
  state            text NOT NULL DEFAULT 'sent',
  assignment_state text,
  escalation_level integer NOT NULL DEFAULT 0,
  escalate_at      timestamptz,                        -- متى يُصعَّد إن لم يُقرّ الاستلام؛ NULL = لا تصعيد
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz,
  acknowledged_at  timestamptz,
  CONSTRAINT notifications_priority_check CHECK (priority IN ('urgent', 'important', 'normal')),
  CONSTRAINT notifications_state_check CHECK (state IN ('sent', 'delivered', 'read', 'acknowledged')),
  CONSTRAINT notifications_assignment_state_check CHECK (assignment_state IS NULL OR assignment_state IN ('assigned', 'acknowledged')),
  CONSTRAINT notifications_escalation_nonneg CHECK (escalation_level >= 0),
  CONSTRAINT notifications_read_consistent CHECK ((state IN ('read', 'acknowledged')) = (read_at IS NOT NULL)),
  CONSTRAINT notifications_ack_consistent CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL)),
  -- حدث واحد لا ينتج إشعارين للمستخدم نفسه مهما تكرر الاستدعاء
  CONSTRAINT notifications_user_event_key UNIQUE (user_id, event_id)
);
CREATE INDEX notifications_inbox_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
-- كنس التصعيد: ما لم يُقرّ وحان موعد تصعيده
CREATE INDEX notifications_escalation_idx ON notifications (escalate_at) WHERE acknowledged_at IS NULL AND escalate_at IS NOT NULL;
CREATE INDEX notifications_material_idx ON notifications (material_id) WHERE material_id IS NOT NULL;

CREATE TABLE notification_deliveries (
  notification_id uuid NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  channel         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, channel),
  CONSTRAINT notification_deliveries_channel_check CHECK (channel IN (
    'in_app', 'websocket', 'apns', 'fcm', 'web_push', 'email', 'telegram', 'whatsapp', 'sms')),
  CONSTRAINT notification_deliveries_status_check CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  CONSTRAINT notification_deliveries_attempts_nonneg CHECK (attempts >= 0)
);
CREATE INDEX notification_deliveries_retry_idx ON notification_deliveries (updated_at) WHERE status IN ('pending', 'failed');
CREATE TRIGGER notification_deliveries_set_updated_at BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE notification_deliveries;
DROP TABLE notifications;
DROP TABLE outbox_events;
