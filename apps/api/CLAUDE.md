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

## التشغيل

```bash
cd apps/api && npm ci
export DATABASE_URL=postgres://posthistory:<password>@localhost:5432/posthistory_test
src/db/migrate.sh up
npm run typecheck            # يولّد src/generated/api.d.ts من contracts/openapi.yaml (لا يُلتزم)
npm test                     # وحدات
npm run test:integration     # تكامل على Postgres (أسرار الاختبار تُولَّد عشوائيًا في test/integration/env.ts)
npm run db:pull              # بعد كل ترحيل مدمج: يعيد استبطان src/database/schema (CI يفشل إن اختلف)
```

المتغيرات في `.env.example`. الهيكل: `identity/` (الجلسات، SEC-02)، `idempotency/`، `outbox/` (`writeOutboxEvent(tx, …)`
يقبل معاملة فقط + المُرسل)، `uploads/` (خطّافات tusd، SEC-06)، `common/contract.ts` (التحقق من الأجسام بمخططات العقد نفسها).
القرارات في ADR 0004.

## الاختبار

- وحدات لكل انتقال حالة، وتكامل لكل مسار API ضد Postgres حقيقي في CI.
- اختبارات القبول المستهدفة في التأسيس: «إشعار الاستلام»، «الحقول المتغيرة»، «حدود الصلاحيات».
