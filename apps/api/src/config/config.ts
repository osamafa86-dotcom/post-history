import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

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

  // محاولات الدخول لكل بريد ولكل عنوان IP (عنوان واحد قد يجمع مكتبًا كاملًا خلف NAT)
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  LOGIN_RATE_LIMIT_IP_MAX: z.coerce.number().int().min(1).default(100),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),

  // طلب استعادة الحساب ينتظر اعتماد المشرف هذه المدة ثم ينتهي
  RECOVERY_REQUEST_TTL_SECONDS: z.coerce.number().int().min(300).default(24 * 3600),

  // SEC-06: الرمز في مسار عنوان الخطّاف
  TUSD_HOOK_SECRET: z.string().min(32).max(128),
  TUSD_OBJECT_PREFIX: z.string().default(''),
  // ما يُعاد للعميل عند إنشاء جلسة رفع: نقطة tus العامة، وحجم الجزء الثابت (R2 يشترط تساويه، ≥ 5 MiB)
  TUS_PUBLIC_ENDPOINT: z.string().url().default('http://localhost:8080/files/'),
  TUSD_PART_SIZE_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).default(16 * 1024 * 1024),
  // عمر الجلسة ورمز الرفع معًا (عمود expires_at واحد في المخطط)
  UPLOAD_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(24 * 3600),
  // مسار الرفع (بند القرارات 3، يُحسم بعد النموذج الأولي): tusd، أو direct حيث يعلن العميل الاكتمال بنفسه
  UPLOAD_PATH: z.enum(['tusd', 'direct']).default('tusd'),
  S3_BUCKET_UPLOADS: z.string().min(1),
  // التخزين الذي يقرأ منه التحقق داخل الخادم (MinIO محليًا، R2 في الإنتاج)
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  // in_process: يتحقق الخادم من الملفات المكتملة بنفسه؛ external: عامل الوسائط يفعل ذلك والخادم لا يقرأ التخزين
  UPLOAD_VERIFIER: z.enum(['in_process', 'external']).default('in_process'),
  VERIFY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),

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
  if (c.NODE_ENV !== 'production') return;
  if (!c.REDIS_URL) ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'required in production' });
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
