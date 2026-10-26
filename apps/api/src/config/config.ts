import { BlockList, isIP } from 'node:net';
import { availableParallelism } from 'node:os';
import { z } from 'zod';
import { FieldKeyring } from '../common/crypto';

export function parseCidr(cidr: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [address, bits] = cidr.split('/');
  const version = isIP(address ?? '');
  const prefix = Number(bits);
  if (!version || bits === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
    return null;
  }
  return { address: address!, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** مصدر داخلي مقيّد: عناوينه لا تصل من /internal/* إلا إلى بادئات مساراته. */
export interface InternalSource {
  cidr: string;
  prefixes: string[];
}

const INTERNAL_PREFIX = /^\/internal\/[a-z0-9-]+(\/[a-z0-9-]+)*\/$/;

export function blockListOf(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const p = parseCidr(c)!;
    list.addSubnet(p.address, p.prefix, p.family);
  }
  return list;
}

const cidrList = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .refine((list) => list.every((c) => parseCidr(c) !== null), 'must be a comma-separated list of CIDRs');

// كل الإعداد من البيئة؛ لا قيم أسرار افتراضية هنا. القائمة موثقة في apps/api/.env.example.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // عناوين الوكلاء العكسيين الموثوقين (نطاقات Cloudflare) مفصولة بفواصل؛ فارغ = لا يُوثق بـ X-Forwarded-For
  TRUSTED_PROXY_CIDRS: cidrList.prefault(''),
  // من يصل إلى /internal/* (خطّافات tusd) بعنوان المقبس نفسه لا بـ X-Forwarded-For؛ الافتراضي الحلقة المحلية فقط
  INTERNAL_ALLOWED_CIDRS: cidrList.prefault('127.0.0.1/32,::1/128'),
  // عنوان الـBFF (apps/web) الثابت، عنوان واحد لكل مدخل (/32 أو /128): منه وحده تُقبل ترويسة X-Client-Address
  // لحدود معدل الدخول والاستعادة؛ فارغ = لا تُقبل من أحد
  // مصادر /internal/* المقيّدة بمسارات صريحة: `CIDR=/internal/a/|/internal/b/` مفصولة بـ `;`. العنوان المطابق لمدخل
  // هنا يصل إلى بادئاته وحدها (ولو كان أيضًا في INTERNAL_ALLOWED_CIDRS)، وما سواها منه 403. بوابة ingest تُدرج هنا
  // بـ /internal/ingest/ فقط. فارغ = لا تقييد إضافي
  INTERNAL_SOURCE_PATHS: z
    .string()
    .transform((v) =>
      v
        .split(';')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e): InternalSource | null => {
          const [cidr, paths, ...rest] = e.split('=').map((x) => x.trim());
          const prefixes = (paths ?? '').split('|').map((x) => x.trim()).filter(Boolean);
          if (rest.length || !cidr || parseCidr(cidr) === null || !prefixes.length || !prefixes.every((x) => INTERNAL_PREFIX.test(x))) return null;
          return { cidr, prefixes };
        }),
    )
    .refine((list) => list.every((x) => x !== null), 'must be `CIDR=/internal/<path>/[|/internal/<path>/]` entries separated by `;`')
    .transform((list) => list as InternalSource[])
    .prefault(''),
  BFF_SOURCE_ADDRESSES: cidrList
    .refine((list) => list.every((c) => /\/(32|128)$/.test(c)), 'each entry must be a single address (/32 or /128)')
    .prefault(''),

  DATABASE_URL: z.string().min(1),
  // Redis مشترك بين نسخ الخادم (حد المعدل الآن، الطوابير لاحقًا). مطلوب في الإنتاج؛ غيابه خارجه = حدود في الذاكرة
  REDIS_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),

  JWT_SECRET: z.string().min(32),
  // SEC-02: رمز الوصول لا يتجاوز 15 دقيقة
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(30 * 24 * 3600),
  // مفتاح التشفير على مستوى الحقل (AES-256-GCM)، 32 بايت بترميز base64
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  // رقم إصدار المفتاح الحالي (1–255) يُكتب بايتًا أول في كل حقل مشفر. التدوير: المفتاح القديم ورقمه إلى *_PREVIOUS
  // (يُقرأ به فقط)، ومفتاح جديد برقم جديد هنا (يُكتب به)
  FIELD_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(255).default(1),
  FIELD_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded')
    .optional(),
  FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION: z.coerce.number().int().min(1).max(255).optional(),

  // محاولات الدخول لكل بريد ولكل عنوان IP (عنوان واحد قد يجمع مكتبًا كاملًا خلف NAT)
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  LOGIN_RATE_LIMIT_IP_MAX: z.coerce.number().int().min(1).default(100),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),

  // طلب استعادة الحساب ينتظر اعتماد المشرف هذه المدة ثم ينتهي
  RECOVERY_REQUEST_TTL_SECONDS: z.coerce.number().int().min(300).default(24 * 3600),
  // رمز إعادة التعيين الصادر عند الاعتماد (v0.1): صالح هذه المدة لإكمال الاستعادة، ومهلة تحديث الجلسة المقيّدة بعدها؛
  // القاعدة تفرض ألا تتجاوز 24 ساعة من الاعتماد
  RECOVERY_RESET_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(24 * 3600).default(12 * 3600),
  // مخرج الطوارئ (أمر CLI لاعتماد استعادة مدير النظام): بصمة SHA-256 (hex) لرمز التشغيل المحفوظ في الخزنة؛ الرمز نفسه لا
  // يوضع في البيئة. غير مضبوط = طريق الخزنة معطّل ويبقى طريق مديرَين
  BREAK_GLASS_TOKEN_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be a hex SHA-256 digest')
    .optional(),

  // SEC-06: الرمز في مسار عنوان الخطّاف
  TUSD_HOOK_SECRET: z.string().min(32).max(128),
  // تدوير بلا انقطاع: الرمز السابق يُقبل حتى TUSD_HOOK_SECRET_PREVIOUS_UNTIL (وقت ISO 8601) ثم يُرفض وحده دون إعادة تشغيل
  TUSD_HOOK_SECRET_PREVIOUS: z.string().min(32).max(128).optional(),
  TUSD_HOOK_SECRET_PREVIOUS_UNTIL: z.string().datetime({ offset: true }).optional(),
  TUSD_OBJECT_PREFIX: z.string().default(''),
  // true حين يرسل tusd حدث post-create (-hooks-enabled-events): الجلسة تبقى created حتى ينجح إنشاء الرفع فعلًا
  TUSD_POST_CREATE_HOOK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // مع post-create: مدة حجز الجلسة بعد قبول pre-create؛ يُرفض أي pre-create آخر قبل انقضائها أو قبل post-create
  TUSD_PRE_CREATE_RESERVATION_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  // ما يُعاد للعميل عند إنشاء جلسة رفع: نقطة tus العامة، وحجم الجزء الثابت (R2 يشترط تساويه، ≥ 5 MiB)
  TUS_PUBLIC_ENDPOINT: z.string().url().default('http://localhost:8080/files/'),
  TUSD_PART_SIZE_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).default(16 * 1024 * 1024),
  // عمر الجلسة ورمز الرفع معًا (عمود expires_at واحد في المخطط)
  UPLOAD_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(24 * 3600),
  // عمر رمز الرفع مستقلًا عن الجلسة (عقد v0.1): يلزم لبدء الرفع فقط (pre-create) لا لاستئنافه، ولا يتجاوز عمر الجلسة.
  // إعادة POST /uploads بالمفتاح نفسه تصدر رمزًا جديدًا بالعمر نفسه ما دامت الجلسة created
  UPLOAD_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  // مسار الرفع (بند القرارات 3، يُحسم بعد النموذج الأولي): tusd، أو direct حيث يعلن العميل الاكتمال بنفسه
  UPLOAD_PATH: z.enum(['tusd', 'direct']).default('tusd'),
  // حد حجم الملف الواحد في POST /uploads (بايت)؛ غيابه = بلا حد. المعاينة تضبطه مع -max-size في tusd (#235)
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).optional(),
  // true (افتراضيًا مع عقد v0.1، ADR 0012: «على كل عميل إرسالها»): إنشاء جلسة رفع بلا client_sha256 يُرفض (422)
  UPLOAD_REQUIRE_CLIENT_SHA256: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // مكنسة تسوية جلسات in_progress التي ضاع post-finish لها: تُفحص في التخزين بعد هذه المدة بلا تغيير
  UPLOAD_RECONCILE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  UPLOAD_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  UPLOAD_RECONCILE_STALE_SECONDS: z.coerce.number().int().min(30).default(300),
  UPLOAD_RECONCILE_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  S3_BUCKET_UPLOADS: z.string().min(1),
  // حاوية المشتقات (derived/<material_id>/<file_id>/…) التي يكتب فيها عامل الوسائط؛ غير حاوية الرفع (ADR 0006)
  S3_BUCKET_MEDIA: z.string().min(1).default('media'),
  // التخزين الذي يقرأ منه التحقق داخل الخادم (MinIO محليًا، R2 في الإنتاج)
  S3_ENDPOINT: z.string().optional(),
  // نقطة التخزين كما يصلها العميل لروابط التنزيل الموقّعة (المضيف جزء من التوقيع)؛ غير مضبوطة = S3_ENDPOINT
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  // in_process: يتحقق الخادم من الملفات المكتملة بنفسه؛ external: عامل الوسائط يفعل ذلك والخادم لا يقرأ التخزين
  UPLOAD_VERIFIER: z.enum(['in_process', 'external']).default('in_process'),
  VERIFY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  // UPLOAD_VERIFIER=external: أحداث الاستلام تُنشر إلى Redis Stream `media:events` بطول أقصى تقريبي (ADR 0006)
  MEDIA_STREAM_MAXLEN: z.coerce.number().int().min(1000).default(100_000),
  // رمز عامل الوسائط لنقاط /internal/media/* (ترويسة Bearer)، منفصل عن TUSD_HOOK_SECRET؛ غير مضبوط = النقاط 404
  MEDIA_WORKER_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/, 'must be 32-256 characters of [A-Za-z0-9_-]')
    .optional(),
  // رمز بوابة ingest على GET /internal/ingest/session-status (ترويسة Bearer) دفاعًا ثانيًا فوق INTERNAL_ALLOWED_CIDRS؛
  // مضبوط = الفحص بلا رمز مطابق 403
  INGEST_GATE_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/, 'must be 32-256 characters of [A-Za-z0-9_-]')
    .optional(),
  // حساب القبول الوحيد الذي تُقبل جلساته برمز موقَّع بمفتاح فئة qa (key_class=qa على فحص البوابة)؛ فارغ = رفض دائم
  ACCEPTANCE_UPLOADER_USER_ID: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a user id (uuid)')
    .optional(),
  // لقطة لوحة غرفة الأخبار لكل مستخدم ونطاقه (قرار المنسّق على #187): تُعاد ≤ هذه المدة ثم تُحسب من جديد؛ 0 = بلا لقطة
  DASHBOARD_SNAPSHOT_MS: z.coerce.number().int().min(0).max(5000).default(5000),
  // رمز عامل التفريغ المحلي: يُقبل على POST /internal/media/files/{id}/derivatives لنوعي transcript وcaptions وحدهما
  // (ولا شيء غيره)، منفصل عن MEDIA_WORKER_TOKEN؛ غير مضبوط = العامل لا يصل
  AI_WORKER_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/, 'must be 32-256 characters of [A-Za-z0-9_-]')
    .optional(),
  // عدد الملفات التي تُحسب بصماتها معًا؛ كل واحد يشغل اتصالًا من المجمع طوال قراءته، فيبقى أقل من DATABASE_POOL_MAX
  VERIFY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // خيوط حساب SHA-256 (worker_threads)؛ افتراضيًا عدد الأنوية ناقص واحد يبقى لخيط الحدث
  VERIFY_HASH_THREADS: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(Math.max(1, availableParallelism() - 1)),

  // حجز الإنتاج يُحرَّر تلقائيًا بعد هذا الخمول (15 دقيقة افتراضيًا)
  RESERVATION_IDLE_SECONDS: z.coerce.number().int().min(60).default(900),
  RESERVATION_SWEEP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // لغة عناوين الإشعارات المخزنة (القوالب بالعربية والإنجليزية في notifications/messages.ts)
  NOTIFICATION_LOCALE: z.enum(['ar', 'en']).default('ar'),

  // مهلة الإقرار قبل تصعيد مهمة لم يُقرّ استلامها (ثوانٍ) لكل أولوية، ثم المهلة نفسها لكل مستوى تالٍ
  ESCALATION_URGENT_SECONDS: z.coerce.number().int().min(1).default(600),
  ESCALATION_IMPORTANT_SECONDS: z.coerce.number().int().min(1).default(3600),
  ESCALATION_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(15000),

  // SEC-07 (ADR 0011): شهادة الجهاز ونطاق ingest. off = المسارات الثلاثة 404 ولا جلسة تطلب ingest؛ test = تحقق App
  // Attest الحقيقي بجذر اختبار من APP_ATTEST_TEST_ROOT_PEM وحكم Play Integrity غير موقّع (للاختبار والتطوير فقط)؛
  // production = جذر Apple المثبّت في الكود وواجهة Google.
  ATTESTATION_MODE: z.enum(['off', 'test', 'production']).default('off'),
  // App Attest: معرّف التطبيق <TeamID>.<BundleID>، وrpIdHash = SHA-256 له
  APP_ATTEST_APP_ID: z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/, 'must be <TeamID>.<BundleID>').optional(),
  // مفاتيح البيئة التطويرية (aaguid appattestdevelop)؛ ممنوعة في الإنتاج
  APP_ATTEST_ALLOW_DEVELOPMENT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // ATTESTATION_MODE=test: جذر الاختبار (PEM بترميز base64) بدل جذر Apple
  APP_ATTEST_TEST_ROOT_PEM: z.string().optional(),
  // Play Integrity: اسم الحزمة، وبصمات شهادة التوقيع (base64url بلا حشو كما يعيدها Google) مفصولة بفواصل
  PLAY_INTEGRITY_PACKAGE_NAME: z.string().regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/).optional(),
  PLAY_INTEGRITY_CERT_SHA256: z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .prefault(''),
  // حساب خدمة Google (JSON بترميز base64) لواجهة decodeIntegrityToken؛ سر من SOPS، لا يُسجَّل
  PLAY_INTEGRITY_SERVICE_ACCOUNT: z.string().optional(),
  // حد طلبات التحدي ورموز ingest لكل مستخدم في نافذة LOGIN_RATE_LIMIT_WINDOW_SECONDS
  ATTESTATION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  // مفتاح توقيع رموز ingest: ES256 خاص (PKCS#8 DER بترميز base64) من SOPS؛ البوابة تحمل العام وحده. التدوير: يُضاف العام
  // الجديد إلى البوابة أولًا، ثم يتبدّل هذا المفتاح ومعرّفه (kid)، ثم يُزال العام القديم بعد عمر الرمز.
  INGEST_TOKEN_SIGNING_KEY: z.string().optional(),
  INGEST_TOKEN_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  // عمر رمز ingest؛ البوابة ترفض ما فوق 900 ث
  INGEST_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  // نقطة tus على نطاق ingest؛ مضبوطة مع INGEST_REQUIRED=true تُعلن لكل جلسة رفع جديدة بدل TUS_PUBLIC_ENDPOINT
  INGEST_TUS_ENDPOINT: z.string().url().optional(),
  INGEST_REQUIRED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // تسليم الإشعارات بالدفع إلى الأجهزة المسجّلة (/push-devices). معطّل افتراضيًا؛ الإشعار يبقى في صندوق الوارد دائمًا
  PUSH_DELIVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PUSH_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  // APNs: مفتاح المزوّد .p8 (PEM بترميز base64، سر من SOPS) ومعرّفاه، والموضوع (Bundle ID)، والبيئة
  APNS_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_KEY_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_PRIVATE_KEY: z.string().optional(),
  APNS_TOPIC: z.string().optional(),
  APNS_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),
  // FCM HTTP v1: معرّف المشروع وحساب الخدمة (JSON بترميز base64، سر من SOPS)
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT: z.string().optional(),

  // مزوّد الدفع (ADR 0032): none = لا شراء؛ sandbox = المزوّد التجريبي الداخلي، خارج الإنتاج وحده. لا مال حقيقي.
  PAYMENT_PROVIDER: z.enum(['none', 'sandbox']).default('none'),
  // سر توقيع إشعارات المزوّد التجريبي (HMAC-SHA256)، من البيئة وحدها
  SANDBOX_WEBHOOK_SECRET: z.string().min(32).max(128).optional(),
  // الأصل العام الذي تُبنى عليه روابط صفحة الدفع التجريبية
  SANDBOX_CHECKOUT_BASE_URL: z.string().url().default('http://localhost:3000'),

  OUTBOX_DISPATCHER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
});

export type AppConfig = z.infer<typeof validated>;
// الإنتاج يتطلب Redis وبيانات التخزين للتحقق داخل الخادم؛ خارج الإنتاج يعمل الخادم بدونهما مع تحذير عند البدء
// (التشغيل المحلي وتشغيل القبول الحي لا يحتاجان Redis ولا MinIO).
export function storageConfigured(c: { S3_ENDPOINT?: string; S3_ACCESS_KEY?: string; S3_SECRET_KEY?: string }): boolean {
  return Boolean(c.S3_ENDPOINT && c.S3_ACCESS_KEY && c.S3_SECRET_KEY);
}

const validated = schema.superRefine((c, ctx) => {
  if (Boolean(c.TUSD_HOOK_SECRET_PREVIOUS) !== Boolean(c.TUSD_HOOK_SECRET_PREVIOUS_UNTIL)) {
    ctx.addIssue({ code: 'custom', path: ['TUSD_HOOK_SECRET_PREVIOUS_UNTIL'], message: 'set together with TUSD_HOOK_SECRET_PREVIOUS' });
  }
  if (Boolean(c.FIELD_ENCRYPTION_KEY_PREVIOUS) !== (c.FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION'], message: 'set together with FIELD_ENCRYPTION_KEY_PREVIOUS' });
  } else if (c.FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION === c.FIELD_ENCRYPTION_KEY_VERSION) {
    ctx.addIssue({ code: 'custom', path: ['FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION'], message: 'must differ from FIELD_ENCRYPTION_KEY_VERSION' });
  }
  if (c.UPLOAD_VERIFIER === 'in_process' && c.VERIFY_CONCURRENCY >= c.DATABASE_POOL_MAX) {
    ctx.addIssue({ code: 'custom', path: ['VERIFY_CONCURRENCY'], message: 'must be lower than DATABASE_POOL_MAX' });
  }
  if (c.ATTESTATION_MODE !== 'off' && !c.APP_ATTEST_APP_ID && !c.PLAY_INTEGRITY_PACKAGE_NAME) {
    ctx.addIssue({ code: 'custom', path: ['APP_ATTEST_APP_ID'], message: 'APP_ATTEST_APP_ID or PLAY_INTEGRITY_PACKAGE_NAME is required with ATTESTATION_MODE' });
  }
  if (c.PLAY_INTEGRITY_PACKAGE_NAME && c.PLAY_INTEGRITY_CERT_SHA256.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['PLAY_INTEGRITY_CERT_SHA256'], message: 'required with PLAY_INTEGRITY_PACKAGE_NAME' });
  }
  if (c.ATTESTATION_MODE === 'test' && c.APP_ATTEST_APP_ID && !c.APP_ATTEST_TEST_ROOT_PEM) {
    ctx.addIssue({ code: 'custom', path: ['APP_ATTEST_TEST_ROOT_PEM'], message: 'required with ATTESTATION_MODE=test' });
  }
  if (c.ATTESTATION_MODE !== 'off' && (!c.INGEST_TOKEN_SIGNING_KEY || !c.INGEST_TOKEN_KEY_ID)) {
    ctx.addIssue({ code: 'custom', path: ['INGEST_TOKEN_SIGNING_KEY'], message: 'INGEST_TOKEN_SIGNING_KEY and INGEST_TOKEN_KEY_ID are required with ATTESTATION_MODE' });
  }
  if (c.INGEST_REQUIRED && (c.ATTESTATION_MODE === 'off' || !c.INGEST_TUS_ENDPOINT)) {
    ctx.addIssue({ code: 'custom', path: ['INGEST_REQUIRED'], message: 'needs ATTESTATION_MODE and INGEST_TUS_ENDPOINT' });
  }
  if (c.PAYMENT_PROVIDER === 'sandbox' && !c.SANDBOX_WEBHOOK_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['SANDBOX_WEBHOOK_SECRET'], message: 'required with PAYMENT_PROVIDER=sandbox' });
  }
  if (c.NODE_ENV !== 'production') return;
  if (c.PAYMENT_PROVIDER === 'sandbox') ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'sandbox is not allowed in production' });
  if (c.ATTESTATION_MODE === 'test') ctx.addIssue({ code: 'custom', path: ['ATTESTATION_MODE'], message: 'test is not allowed in production' });
  if (c.APP_ATTEST_ALLOW_DEVELOPMENT) {
    ctx.addIssue({ code: 'custom', path: ['APP_ATTEST_ALLOW_DEVELOPMENT'], message: 'not allowed in production' });
  }
  if (c.ATTESTATION_MODE === 'production' && c.PLAY_INTEGRITY_PACKAGE_NAME && !c.PLAY_INTEGRITY_SERVICE_ACCOUNT) {
    ctx.addIssue({ code: 'custom', path: ['PLAY_INTEGRITY_SERVICE_ACCOUNT'], message: 'required in production with PLAY_INTEGRITY_PACKAGE_NAME' });
  }
  if (!c.REDIS_URL) ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'required in production' });
  if (c.UPLOAD_VERIFIER === 'external' && !c.MEDIA_WORKER_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['MEDIA_WORKER_TOKEN'], message: 'required in production when UPLOAD_VERIFIER=external' });
  }
  if (c.UPLOAD_VERIFIER !== 'in_process') return;
  for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
    if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required in production when UPLOAD_VERIFIER=in_process' });
  }
});

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // المتغير الفارغ (كما في .env.example المنسوخ) = غير مضبوط، فتسري القيمة الافتراضية
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = validated.safeParse(defined);
  if (!parsed.success) {
    // أسماء المتغيرات فقط؛ لا تُطبع القيم
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${names.join(', ')}`);
  }
  return parsed.data;
}

/** يطبّع عنوان IPv4 المحمول في IPv6 (::ffff:a.b.c.d) ثم يفحصه في القائمة. */
export function addressAllowed(list: BlockList, address: string | undefined): boolean {
  if (!address) return false;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const addr = v4 ?? address;
  const family = isIP(addr);
  if (!family) return false;
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

/** حلقة مفاتيح الحقول المشفرة من البيئة: الحالي للكتابة والقراءة، والسابق (إن ضُبط) للقراءة فقط. */
export function fieldKeyring(c: AppConfig): FieldKeyring {
  return new FieldKeyring(
    { version: c.FIELD_ENCRYPTION_KEY_VERSION, key: Buffer.from(c.FIELD_ENCRYPTION_KEY, 'base64') },
    c.FIELD_ENCRYPTION_KEY_PREVIOUS
      ? { version: c.FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION!, key: Buffer.from(c.FIELD_ENCRYPTION_KEY_PREVIOUS, 'base64') }
      : undefined,
  );
}
