-- Up Migration
-- قواعد التنبيه تقبل كل صلاحيات Permission في العقد، ومنها reporter_identity:read (ADR 0021)؛
-- القيد كان بالصلاحيتين الأقدم فيرفض ما يقبله العقد.
ALTER TABLE notification_rules DROP CONSTRAINT notification_rules_permissions_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_permissions_check CHECK (
  recipient_permissions <@ ARRAY['sensitive_location:read', 'protected_source:read', 'reporter_identity:read']);

-- Down Migration
ALTER TABLE notification_rules DROP CONSTRAINT notification_rules_permissions_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_permissions_check CHECK (
  recipient_permissions <@ ARRAY['sensitive_location:read', 'protected_source:read']) NOT VALID;
