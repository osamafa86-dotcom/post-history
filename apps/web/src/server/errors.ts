export class WebError extends Error {
  /** `details` آلية منقّاة وحدها (مثل شروط النسخة الفاشلة)؛ لا نص من الخادم ولا رسالته. */
  constructor(readonly status: number, readonly code: string, readonly details?: Record<string, unknown>) { super(code); }
}
