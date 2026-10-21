import '../integration/env';

// قاعدة مخصصة للأداء تُنشأ وتُبذر في كل تشغيل: لا تُشغَّل أبدًا على قاعدة التكامل أو أي قاعدة لا يدل اسمها على ذلك
const url = process.env.PERF_DATABASE_URL;
if (!url || !/perf/i.test(new URL(url).pathname)) {
  throw new Error('PERF_DATABASE_URL must point to a dedicated database whose name contains "perf" (it is seeded)');
}
process.env.DATABASE_URL = url;
