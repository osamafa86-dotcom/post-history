import { randomBytes } from 'node:crypto';

// قيم اختبار تُولَّد عشوائيًا في كل تشغيل؛ لا أسرار ثابتة في المستودع. DATABASE_URL من البيئة (CI أو محليًا).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.TUSD_HOOK_SECRET = randomBytes(24).toString('hex');
process.env.S3_BUCKET_UPLOADS = 'uploads';
process.env.TUSD_OBJECT_PREFIX = 'tus/';
process.env.OUTBOX_DISPATCHER_ENABLED = 'false';
process.env.LOGIN_RATE_LIMIT_MAX = '5';
process.env.LOGIN_RATE_LIMIT_IP_MAX = '10000';
process.env.RESERVATION_SWEEP_ENABLED = 'false';
process.env.REDIS_URL ??= 'redis://localhost:6379';
// التحقق تقوده الاختبارات باستدعاء verifyNext مع تخزين بديل في الذاكرة (harness)، فلا حلقة خلفية ولا S3
process.env.UPLOAD_VERIFIER = 'external';
