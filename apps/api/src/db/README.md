# apps/api/src/db — مخطط Postgres والترحيلات

المالك: وكيل العقود والبيانات. وكيل الخادم يبني ضد هذا المخطط ولا يعدّله إلا بـ PR مستقل.

## الهيكل

| المسار | المحتوى |
| --- | --- |
| `migrations/*.sql` | ملفات SQL خام، كل ملف قسمان `-- Up Migration` و`-- Down Migration` (ADR 0001) |
| `migrate.sh` | غلاف `node-pg-migrate`: `up`، `down [n]`، `redo`، `create <name>` |
| `tests/smoke.sql` | اختبار دخاني يثبت كل قيد ومحفّز؛ يعمل داخل معاملة تُرجَع |
| `scripts/check.sh` | up → اختبار → down كامل (يجب أن يفرغ المخطط) → up → اختبار؛ يعمل محليًا وفي CI |

## التشغيل محليًا

```bash
docker compose -f infra/compose/docker-compose.yml up -d postgres
export DATABASE_URL=postgres://posthistory:<POSTGRES_PASSWORD>@localhost:5432/posthistory
apps/api/src/db/migrate.sh up
# فحص كامل على قاعدة اختبار فارغة (لا تشغّله على قاعدة فيها بيانات: down يحذف الجداول)
DATABASE_URL=postgres://posthistory:<password>@localhost:5432/posthistory_test apps/api/src/db/scripts/check.sh
```

المصادقة من `DATABASE_URL` في البيئة فقط؛ لا كلمات مرور هنا.

## الاتفاقيات

1. **SQL هو الحقيقة.** لا نماذج بيانات يدوية في الخادم: وكيل الخادم يولّد أنواع Drizzle بـ `drizzle-kit pull` بعد كل ترحيل (ADR 0001).
2. **كل ترحيل له Down يعمل.** `scripts/check.sh` يفشل إن ترك `down` جدولًا أو دالة.
3. **لا ENUM.** القيم المغلقة نصوص بقيود `CHECK` مسماة (`<table>_<column>_check`) حتى يكون توسيعها `ALTER TABLE … DROP/ADD CONSTRAINT` صريحًا.
4. **الحالات الثلاث أعمدة مستقلة** (`technical_state`، `editorial_state`، `rights_state`) بقيود CHECK، وجدول الانتقالات المسموحة في كود الخادم (العقد يوثّقه). ما ليس فيه يُرفض بـ 409.
5. **الفهرسة** (ADR 0002): الحقول عالية التردد أعمدة صريحة بفهارس B-Tree مركبة؛ `dynamic_fields` JSONB **بلا GIN** (الاختبار الدخاني يفشل إن ظهر GIN). الحقل الموسوم «مرشّح بحث» يُرقَّى بترحيل يضيف فهرسًا تعبيريًا على `dynamic_fields ->> 'key'`.
6. **Outbox داخل المعاملة.** كل تغيير حالة يكتب صفًا في `outbox_events` في معاملة الحفظ نفسها، و`idempotency_key` فريد. المُرسل يقرأ: `SELECT … FROM outbox_events WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED`.
7. **مفاتيح منع التكرار** في `idempotency_keys` بمفتاح `(user_id, key)` وبصمة الطلب؛ تُكنس بعد `expires_at`.
8. **حصص المساهمين = 100.00** قيد مؤجل (`DEFERRABLE INITIALLY DEFERRED`) حتى يمر الاستبدال الكامل داخل معاملة واحدة. الخادم يحوّل `23514` باسم القيد `material_contributors_sum_100` إلى `422 shares_not_100`.
9. **رقم الإيصال** `R-YYYYMM-NNNNNN` يسنده محفّز عند تحوّل ملف `original` إلى `verified` ولا يتغير بعدها.
10. **سجل التدقيق** إلحاقي بسلسلة تجزئة: لا UPDATE ولا DELETE ولا TRUNCATE (محفّزات ترفع `42501`).
11. **لا بيانات كاشفة في الحمولات:** قيد `outbox_events_payload_no_pii` يرفض مفاتيح `gps`/`lat`/`lng`/`device_id`/`push_token`؛ الإحداثيات في `materials.gps_enc` مشفرة على مستوى الحقل بمفتاح التطبيق.
12. **الأسرار** مُجزَّأة (`*_hash`، sha256 أو argon2id) أو مشفرة (`*_enc`) ولا تُخزَّن خامًا.

## ترحيل جديد

```bash
apps/api/src/db/migrate.sh create add_material_comments   # ينشئ migrations/<utc-timestamp>_add_material_comments.sql
```

اكتب القسمين، ثم شغّل `scripts/check.sh` على قاعدة اختبار، وأضف إلى `tests/smoke.sql` ما يثبت القيد الجديد.

## ما يُؤجَّل إلى المرحلة التجارية

التراخيص والطلبات ودفتر الأستاذ والصرف، والفهرس الفريد الجزئي للحصرية (ملحق القرارات 19؛ مذكور في تعليق داخل ترحيل المواد)، والتعليقات بالتوقيت، وعلاقة المشتق بمصادره خارج `material_files.derived_from_id`.
