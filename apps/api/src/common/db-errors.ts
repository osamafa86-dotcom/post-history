/** خطأ Postgres برمزه (SQLSTATE) واسم قيده إن وُجد؛ drizzle يلفّه أحيانًا في cause. */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  let e = err as { code?: string; constraint?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 3 && e; i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return { code: e.code, constraint: e.constraint };
    e = e.cause as typeof e;
  }
  return {};
}

/** رموز SQLSTATE لقاعدة لا تُبلَغ أو مهلة تجاوزها الطلب: إيقاف الخادم أو إقلاعه (57P01–57P03)، امتلاء اتصالاته (53300)، مهلة الاستعلام (57014)، مهلة المعاملة الخاملة (25P03). */
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300', '57014', '25P03']);
/** أعطال المقبس كما يرميها Node: القاعدة متوقفة أو اسمها لا يُحلّ أو الاتصال قُطع. */
const SOCKET_FAILURES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);
/** ما يرميه عميل pg ومجمّعه بلا رمز: انتهاء انتظار اتصال من المجمّع، وانقطاع الاتصال قبل الرد أو أثناءه. */
const DRIVER_FAILURE = /^(timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error)/;

/**
 * هل الخطأ عطل في بلوغ القاعدة أو مهلة تجاوزها الطلب، لا خلل في الطلب ولا في الكود (ADR 0028، تعديل 2026-11-11)؟ جوابه 503 مع
 * Retry-After لا 500: العطل مؤقت والإعادة بعد قليل هي العلاج. خطأ المقبس لا يحمل اسم وجهته، فمقبس مرفوض إلى خدمة أخرى يبلغ
 * المرشّح بلا معالجة يأخذ الجواب نفسه، وهو جواب سليم له أيضًا: عطل مؤقت في خدمة يعتمد عليها الطلب.
 */
export function databaseUnavailable(err: unknown): boolean {
  let e = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = typeof e.code === 'string' ? e.code : '';
    // الصنف 08 كله: استثناءات الاتصال
    if (/^08[0-9A-Z]{3}$/.test(code) || UNAVAILABLE_SQLSTATES.has(code) || SOCKET_FAILURES.has(code)) return true;
    if (e instanceof Error && DRIVER_FAILURE.test(e.message)) return true;
    e = e.cause as typeof e;
  }
  return false;
}
