/** خطأ Postgres برمزه (SQLSTATE) واسم قيده إن وُجد؛ drizzle يلفّه أحيانًا في cause. */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  let e = err as { code?: string; constraint?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 3 && e; i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return { code: e.code, constraint: e.constraint };
    e = e.cause as typeof e;
  }
  return {};
}
