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
  // مسار الرفع (بند القرارات 3، يُحسم بعد النموذج الأولي): tusd، أو direct حيث يعلن العميل الاكتمال بنفسه
  UPLOAD_PATH: z.enum(['tusd', 'direct']).default('tusd'),
  // مكنسة تسوية جلسات in_progress التي ضاع post-finish لها: تُفحص في التخزين بعد هذه المدة بلا تغيير
  UPLOAD_RECONCILE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  UPLOAD_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  UPLOAD_RECONCILE_STALE_SECONDS: z.coerce.number().int().min(30).default(300),
  UPLOAD_RECONCILE_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  S3_BUCKET_UPLOADS: z.string().min(1),
  // التخزين الذي يقرأ منه التحقق داخل الخادم (MinIO محليًا، R2 في الإنتاج)
  S3_ENDPOINT: z.string().optional(),
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
  if (c.NODE_ENV !== 'production') return;
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
