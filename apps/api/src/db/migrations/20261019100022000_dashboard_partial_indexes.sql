-- Up Migration
-- لوحة غرفة الأخبار بحجم سنة (#153 البند 5، p95 ≤ 300 ms): الشرطان مطابقان لاستعلام dashboard.service.ts.
-- آخر الإيصالات: بدل فرز كل الملفات المتحققة لإعادة 20.
CREATE INDEX material_files_recent_receipts_idx ON material_files (verified_at DESC)
  WHERE receipt_number IS NOT NULL AND verified_at IS NOT NULL;
-- المتأخر عن الإقرار: المهام المسندة غير المُقرّة وحدها، بدل مسح الإشعارات كلها.
CREATE INDEX notifications_overdue_assignment_idx ON notifications (escalate_at)
  WHERE assignment_state = 'assigned' AND acknowledged_at IS NULL;

-- Down Migration
DROP INDEX notifications_overdue_assignment_idx;
DROP INDEX material_files_recent_receipts_idx;
