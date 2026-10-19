import { z } from 'zod';

// كل الإعداد من البيئة؛ لا قيم أسرار افتراضية هنا. القائمة موثقة في apps/api/.env.example.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
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

  // SEC-06: الرمز في مسار عنوان الخطّاف
  TUSD_HOOK_SECRET: z.string().min(32).max(128),
  TUSD_OBJECT_PREFIX: z.string().default(''),
  S3_BUCKET_UPLOADS: z.string().min(1),

  OUTBOX_DISPATCHER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // المتغير الفارغ (كما في .env.example المنسوخ) = غير مضبوط، فتسري القيمة الافتراضية
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(defined);
  if (!parsed.success) {
    // أسماء المتغيرات فقط؛ لا تُطبع القيم
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${names.join(', ')}`);
  }
  return parsed.data;
}
