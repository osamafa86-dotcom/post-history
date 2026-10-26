# 0032 — واجهة مزوّد الدفع ومزوّد تجريبي داخلي

- الحالة: مقترح (قرار المالك 2026-10-21، #148)
- التاريخ: 2026-10-21
- المسؤول: وكيل الخادم
- بند ملحق القرارات: الخطة «طبقة الدفع الموحّدة»

## السياق

- **المزوّد الحقيقي يُختار بعد تجربة الصرف:** Stripe لا يفتح حسابًا لكيان مسجل في فلسطين، والقنوات المرشحة تُقاس أولًا.
- **المطلوب الآن:** بناء المتجر والدفع والاسترداد واختبارها كاملة دون مزوّد حقيقي، ثم إضافة المحوّل الحقيقي دون مس بقية النظام.

## القرار

### الواجهة (`commerce/payment-provider.ts`)

```ts
interface PaymentProvider {
  readonly name: 'sandbox' | string;
  createCheckout(input: { orderId: string; amount: Money; returnUrl: string; idempotencyKey: string }): Promise<{ checkoutUrl: string; providerRef: string; expiresAt: Date }>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): ProviderEvent; // يرمي عند توقيع أو وقت غير صالحين
  refund(input: { providerRef: string; amount: Money; idempotencyKey: string }): Promise<{ refundRef: string }>;
  status(providerRef: string): Promise<ProviderPaymentStatus>; // للتسوية
}
type ProviderEvent = { eventId: string; type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'dispute.opened'; providerRef: string; amount: Money; occurredAt: Date };
```

### قواعد ملزمة لكل محوّل

1. **دفع مستضاف فقط:** لا تمر بيانات البطاقة بخوادمنا، ولا حقل بطاقة في أي عقد أو سجل.
2. **Webhook موقَّع:**
   - HMAC-SHA256 على `timestamp.body` بسر من البيئة، بمقارنة ثابتة الزمن.
   - يُرفض ما خرج عن ±5 دقائق.
   - الجسم الخام يُتحقق منه قبل التحليل.
3. **متكرر بأمان:**
   - `(provider, event_id)` فريد في جدول الإشعارات المستلمة.
   - المعالجة في معاملة واحدة مع قيد الدفتر (ADR 0031) وحالة الطلب وحدث Outbox.
   - التكرار يعيد 200 بلا أثر، والترتيب المختلف يُحسم بحالة الطلب.
   - مثال: استرداد قبل نجاح يُرفض ويُعاد من المزوّد.
4. **الحقيقة من المزوّد:** صفحة العودة (`returnUrl`) لا تؤكد الدفع، وإنما الإشعار الموقَّع أو `status()`.
5. **التسوية اليومية:** عامل يقارن الطلبات المفتوحة بـ `status()`، ويكتب الفرق للمراجعة لا تصحيحًا آليًا صامتًا.

### المزوّد التجريبي (`sandbox`)

- **التفعيل:** `PAYMENT_PROVIDER=sandbox`، ومعه `SANDBOX_WEBHOOK_SECRET`.
  - في غير `NODE_ENV=production` يُقبل.
  - في `NODE_ENV=production` يُرفض الإقلاع باسم المتغير، إلا للتجربة الميدانية بعلمين معًا: `DEPLOY_STAGE=trial`
    و`PAYMENT_SANDBOX_ALLOWED=1` (تعديل المنسّق 2026-10-26).
  - مع `DEPLOY_STAGE=production` يُرفض دائمًا، أيًّا كان `NODE_ENV` والعلم.
  - كل إقلاع به يكتب سطر تحذير في السجل.
- **صفحة الدفع:** صفحة مستضافة داخلية بسيطة على `/sandbox/checkout/{ref}`، لا تطلب بطاقة. تعرض المبلغ وأزرار
  النتيجة (نجاح، رفض، تأخير، تكرار الإشعار، إشعار خارج الترتيب)، ثم ترسل إشعارًا موقَّعًا بـ `SANDBOX_WEBHOOK_SECRET`
  إلى نقطة الإشعار نفسها التي يستعملها المزوّد الحقيقي.
- **السيناريوهات:** تُشغَّل آليًا من اختبارات القبول («الدفع المكرر» و«الاسترداد» و«الحقوق والحصرية») بلا متصفح.

### محوّل Stripe في وضع الاختبار (أمر المنسّق 2026-10-26)

- **مزوّد ثانٍ** خلف الواجهة نفسها (`commerce/stripe-provider.ts`)، بـ `PAYMENT_PROVIDER=stripe`. لا مال حقيقي.
- **المفاتيح:** `STRIPE_TEST_SECRET_KEY` وحده بصيغة `sk_test_` (المفتاح الحي يرفضه الإقلاع)، و`STRIPE_WEBHOOK_SECRET` بصيغة
  `whsec_`. من البيئة وحدها، ولا يُطبعان في خطأ الإعداد ولا في السجل. ولا يُقبل مع `DEPLOY_STAGE=production`.
- **الدفع:** جلسة Checkout مستضافة بمبلغ الطلب بوحداته الصغرى، واسم البند `Order <id>` وحده: لا عنوان مادة ولا مشترٍ عند
  المزوّد. العودة إلى `SANDBOX_RETURN_URL` إن ضُبطت. ومفتاح منع التكرار عند Stripe من مفاتيحنا.
- **الويبهوك** على `/payments/webhooks/stripe`: `Stripe-Signature` قبل التحليل بمقارنة ثابتة الزمن مع أي `v1`، ونافذة
  ±5 دقائق. والتكرار بمعرّف الحدث `evt_` في `payment_events` كما في التجريبي.
  - الترجمة إلى أنواعنا:
    - `checkout.session.completed` المدفوع و`async_payment_succeeded` ← `payment.succeeded`.
    - `async_payment_failed` و`expired` ← `payment.failed`.
    - `refund.created/updated` الناجح ← `refund.succeeded`.
    - `charge.dispute.created` ← `dispute.opened`.
  - ما عداها حدث موقّع صحيح يُقبل `200` بلا أثر ولا يُخزَّن.
- **الاسترداد:** من `payment_intent` الجلسة، بالمبلغ وبمفتاح منع التكرار.
- **الاختبار:** بردود Stripe مسجّلة وتوقيعات محسوبة بسر اختباري، أو `stripe-mock` بـ `STRIPE_API_BASE`. المفاتيح الحقيقية على
  التجربة وحدها.

### ما لا يُبنى الآن

- المزوّد الحي (مال حقيقي)، والتوجيه بين بوابات، والبوابة الاحتياطية: بعد تجربة الصرف.
- الصرف إلى المراسلين: يدوي موثَّق بقيد `payout` (ADR 0031) إلى أن تنجح قناة.

## التبعات

- **أسهل:** المتجر والدفتر والاسترداد يُبنى ويُقاس كاملًا الآن. وتبديل المزوّد محوّل واحد.
- **أصعب:** المزوّد التجريبي يجب ألا يصل الإنتاج. يُفحص في الإقلاع وفي `preflight` عند وكيل البنية.
- **يُراجع:** عند اختيار المزوّد الحقيقي، بـ ADR لمحوّله، مع رسومه وعملته وشروط الإشعار عنده.
