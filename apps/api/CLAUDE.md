# apps/api — الخادم الرئيسي

المالك: وكيل الخادم. `src/db/` (المخطط والترحيلات) يملكه وكيل العقود والبيانات.

## التقنية

- TypeScript + NestJS، خادم واحد بوحدات: `identity`، `materials`، `uploads`، `workflow`، `notifications`، `integrations`.
- PostgreSQL: الترحيلات SQL خام عبر node-pg-migrate والوصول عبر Drizzle بأنواع مستبطَنة من المخطط (ADR 0001). Redis للطابور.
- يُبنى ضد `contracts/openapi.yaml`؛ أنواع الطلبات والاستجابات تُولَّد منه ولا تُكتب يدويًا.

## قواعد الحزمة

1. كل كتابة تمر بـ `Idempotency-Key`؛ التكرار يعيد الاستجابة الأولى نفسها.
2. كل تغيير حالة يكتب حدثًا في جدول Outbox **داخل المعاملة نفسها**، ومُرسل مستقل يقرأ الجدول.
3. الحالات الثلاث مستقلة؛ انتقالات كل مسار جدول صريح في الكود، وما ليس فيه يُرفض بـ 409.
4. نطاقات الأدوار تُطبَّق في طبقة الاستعلام لا في الواجهة.
5. الإشعار يبقى في صندوق الوارد حتى لو فشلت قناة الهاتف؛ التمييز بين «أُسند» و«أقرّ الاستلام».
6. لا إحداثيات دقيقة ولا أسماء مصادر محمية في أي استجابة لغير الأدوار المخوّلة، ولا في أي حمولة إشعار.
7. الأسرار من البيئة فقط؛ `.env.example` يوثّق المتغيرات بلا قيم.
8. كل دالة SQL تُستدعى من قيد أو محفّز تستدعي غيرها باسم مؤهَّل بـ `public.`، وتُعرَّف بـ `SET search_path = public, pg_temp` (لا تعتمد على مسار بحث الجلسة أو الاستعادة). كل ترحيل يضيف دالة كهذه يرافقه اختبار استعادة (`pg_restore`/إدراج) بمسار بحث فارغ.

## التشغيل

```bash
cd apps/api && npm ci
export DATABASE_URL=postgres://posthistory:<password>@localhost:5432/posthistory_test
export REDIS_URL=redis://localhost:6379   # الاختبارات تحتاج Redis أيضًا
src/db/migrate.sh up
npm run typecheck            # يولّد src/generated/api.d.ts من contracts/openapi.yaml (لا يُلتزم)
npm test                     # وحدات
npm run test:integration     # تكامل على Postgres (أسرار الاختبار تُولَّد عشوائيًا في test/integration/env.ts)
npm run contract:coverage    # بعد build: عمليات العقد غير المنفَّذة (تحذير في CI)
npm run db:pull              # بعد كل ترحيل مدمج: يعيد استبطان src/database/schema (CI يفشل إن اختلف)
# أداء بحجم سنة من الخطة (البند 18): قاعدة فارغة مُرحَّلة باسم فيه perf تُنشأ من جديد قبل كل تشغيل
PERF_DATABASE_URL=postgres://…/posthistory_perf npm run perf:production-scale   # PERF_SCALE=1، النتيجة في docs/measurements/api/
```

المتغيرات في `.env.example`. الهيكل: `identity/` (الجلسات، SEC-02؛ `principal.ts` الأدوار والنطاقات و`@Roles`)، `forms/` (الإصدارات والتحقق المشترك من الحقول الديناميكية)، `materials/` (النطاق في الاستعلام، جدول الانتقالات، الحجب، التصدير عند الطلب `export.service.ts`، المكررات `duplicates.service.ts`)، `notifications/` (التوزيع من Outbox إلى صندوق الوارد، القوالب في `messages.ts`، read/ack، قواعد الإدارة `notification-rules.service.ts` و`rule-fanout.ts`)، `dashboard/` (لوحة غرفة الأخبار)، `events/` (`GET /events`)، `verification/` (SHA-256 على الخادم بتوازٍ `VERIFY_CONCURRENCY` في مجمّع خيوط `hash-pool.ts`، و`recordVerification` لعامل الوسائط)، `media/` (نقاط عامل الوسائط `/internal/media/*`، ADR 0006؛ تُتحقق بمخططات العقد)، `outbox/media-stream.ts` (طابور `media:events`)، `push-devices/`، `push/` (تسليم الدفع APNs وFCM خلف `PUSH_DELIVERY_ENABLED`)، `permissions/` (المنح والسحب، وسجلها `GET /users/{id}/permissions/history` من التدقيق)، `identity/account.service.ts` (الجلسات والاستعادة بقاعدة تسلسل الأدوار، وحالة الحساب `PUT /users/{id}/status`)، `identity/auth.service.ts` (الدخول وإكمال الاستعادة وتأكيد TOTP؛ الجلسة المقيّدة بعلامة `@AllowDuringCredentialReset` في `auth.guard.ts`)، `identity/reset-token-delivery.ts` (تسليم رمز إعادة التعيين، قابل للحقن)، `common/preconditions.ts` (`If-Match`/`ETag`)، `common/internal-only.ts` (`/internal/*` بالعنوان، والمصادر المقيّدة بمسارات `INTERNAL_SOURCE_PATHS`)، `attestation/` (SEC-07: تحديات، App Attest وPlay Integrity، رمز ingest ES256 ورمز الويب عبر الـBFF، وفحص البوابة `/internal/ingest/session-status`؛ جذر Apple مثبّت في `app-attest.ts`)، `uploads/uploads.service.ts`، `notifications/escalation.worker.ts`، `idempotency/`، `outbox/` (`writeOutboxEvent(tx, …)`
يقبل معاملة فقط + المُرسل)، `uploads/` (خطّافات tusd، SEC-06؛ `upload-reconciler.ts` تسوية ما ضاع post-finish له)، `cli/` (أوامر التشغيل: `approve-admin-recovery` مخرج الطوارئ، `set-admin-status` تعليق مدير وإعادة تفعيله بتأكيد شخصين، `reencrypt-fields` بعد تدوير مفتاح الحقول)، `common/contract.ts` (التحقق من الأجسام بمخططات العقد نفسها)، `common/crypto.ts` (`FieldKeyring`: الحقول المشفرة بإصدار مفتاح).
القرارات في ADR 0005.

## الاختبار

- وحدات لكل انتقال حالة، وتكامل لكل مسار API ضد Postgres حقيقي في CI.
- اختبارات القبول المستهدفة في التأسيس: «إشعار الاستلام»، «الحقول المتغيرة»، «حدود الصلاحيات».
