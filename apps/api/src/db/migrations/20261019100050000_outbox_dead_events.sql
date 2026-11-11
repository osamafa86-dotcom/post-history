-- Up Migration
-- مُرسل Outbox (ADR 0005، تعديل 2026-11-11): الحدث الذي يفشل نشره حتى حدّ المحاولات يُعلَّم ميتًا ويخرج من طابور المُرسل، بدل أن يُعاد
-- بلا نهاية. يبقى صفّه بسببه (last_error) ليُفحص ويُحيا يدويًا بتصفير dead_at وattempts.
ALTER TABLE outbox_events ADD COLUMN dead_at timestamptz;
-- طابور المُرسل بترتيب مطالبته (id): عند تراكم المعلّق لا يُمسح ما نُشر. الفهرس القائم (next_attempt_at, id) لا يحمل هذا الترتيب.
CREATE INDEX outbox_events_claim_idx ON outbox_events (id) WHERE published_at IS NULL AND dead_at IS NULL;

-- Down Migration
DROP INDEX outbox_events_claim_idx;
ALTER TABLE outbox_events DROP COLUMN dead_at;
