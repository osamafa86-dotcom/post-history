import type { components } from '../generated/api';

export type ErrorCode = components['schemas']['Error']['code'];
export type ErrorBody = components['schemas']['Error'];

// رسالة 401 واحدة لكل أسباب رفض الهوية (بريد غير موجود، كلمة مرور خاطئة، رمز مبطَل…)
export const UNAUTHORIZED_MESSAGE = 'Authentication required.';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }

  static unauthorized(): ApiError {
    return new ApiError(401, 'unauthorized', UNAUTHORIZED_MESSAGE);
  }

  static validation(details?: Record<string, unknown>): ApiError {
    return new ApiError(422, 'validation_failed', 'Request validation failed.', details);
  }

  static notFound(): ApiError {
    return new ApiError(404, 'not_found', 'Not found.');
  }
}

// يُرمى لإعادة استجابة محفوظة كما هي (منع التكرار)؛ يكتبها مرشّح الأخطاء دون تعديل.
export class StoredResponse extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('stored response replay');
  }
}
