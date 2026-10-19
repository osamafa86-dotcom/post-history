import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { ApiError } from '../common/errors';

/**
 * مخططات مؤقتة لنقاط عامل الوسائط (ADR 0006) بقرار المنسّق في التذكرة 9، إلى أن يضيف وكيل العقود المسارات الثلاثة
 * إلى contracts/openapi.yaml بعد التجميد؛ حينها تُحذف هذه ويُتحقق بـ validateBody كبقية المسارات. مغلقة كلها
 * (additionalProperties: false): ما لم يُسمَّ هنا يُرفض، وأولها وسوم الملف (الإحداثيات وطراز الجهاز).
 */

const hex64 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const int = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum: min, maximum: max }) as const;
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });

/** المفاتيح التي لها أعمدة في material_files. */
export const TECHNICAL_COLUMN_KEYS = ['duration_ms', 'start_pts_us', 'width', 'height'] as const;
/** ما يُخزَّن في material_files.technical؛ يطابق material_file_technical_keys() في القاعدة. */
export const TECHNICAL_JSON_KEYS = [
  'container',
  'video_codec',
  'audio_codec',
  'frame_rate',
  'avg_frame_rate',
  'vfr',
  'frame_count',
  'max_frame_gap_ms',
  'has_gaps',
  'rotation',
  'hdr',
  'bit_depth',
  'audio_sample_rate',
  'audio_channels',
] as const;

const technical = {
  type: 'object',
  additionalProperties: false,
  required: ['duration_ms', 'start_pts_us'],
  properties: {
    duration_ms: int(0),
    start_pts_us: int(-(2 ** 52), 2 ** 52),
    width: nullable(int(1, 100_000)),
    height: nullable(int(1, 100_000)),
    container: nullable({ type: 'string', maxLength: 64 }),
    video_codec: nullable({ type: 'string', maxLength: 64 }),
    audio_codec: nullable({ type: 'string', maxLength: 64 }),
    frame_rate: nullable({ type: 'number', minimum: 0, maximum: 10_000 }),
    avg_frame_rate: nullable({ type: 'number', minimum: 0, maximum: 10_000 }),
    vfr: { type: 'boolean' },
    frame_count: nullable(int(0)),
    max_frame_gap_ms: nullable({ type: 'number', minimum: 0 }),
    has_gaps: { type: 'boolean' },
    rotation: int(0, 359),
    hdr: { type: 'boolean' },
    bit_depth: nullable(int(1, 64)),
    audio_sample_rate: nullable(int(1, 1_000_000)),
    audio_channels: nullable(int(1, 64)),
  },
} as const;

export type MediaTechnical = { duration_ms: number; start_pts_us: number; width?: number | null; height?: number | null } & Partial<
  Record<(typeof TECHNICAL_JSON_KEYS)[number], string | number | boolean | null>
>;

export interface MediaVerificationBody {
  result: 'verified' | 'invalid_file' | 'storage_error';
  sha256?: string;
  size_bytes?: number;
  head_sha256?: string;
  tail_sha256?: string;
  technical?: MediaTechnical;
}

export interface MediaDerivativeBody {
  kind: 'proxy';
  storage_key: string;
  sha256: string;
  size_bytes: number;
  technical: MediaTechnical;
}

const verification = {
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { enum: ['verified', 'invalid_file', 'storage_error'] },
    sha256: hex64,
    size_bytes: int(0),
    head_sha256: hex64,
    tail_sha256: hex64,
    technical,
  },
  // التحقق الناجح يحمل البصمة والحجم والبصمة الرخيصة؛ الفشل لا يحمل شيئًا يُخزَّن
  if: { properties: { result: { const: 'verified' } } },
  then: { required: ['sha256', 'size_bytes', 'head_sha256', 'tail_sha256', 'technical'] },
  else: { not: { anyOf: [{ required: ['sha256'] }, { required: ['technical'] }] } },
};

const derivative = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'storage_key', 'sha256', 'size_bytes', 'technical'],
  properties: {
    kind: { const: 'proxy' },
    storage_key: { type: 'string', minLength: 1, maxLength: 1024, pattern: '^[A-Za-z0-9/_.-]+$' },
    sha256: hex64,
    size_bytes: int(1),
    technical,
  },
};

const ajv = new Ajv2020({ strict: true, allErrors: true, strictRequired: false });
const validators: Record<'verification' | 'derivative', ValidateFunction> = {
  verification: ajv.compile(verification),
  derivative: ajv.compile(derivative),
};

/** يتحقق من الجسم؛ الفشل 422 بمسارات الحقول فقط (لا قيم)، كما في common/contract.ts. */
export function validateMediaBody<T>(kind: keyof typeof validators, body: unknown): T {
  const validate = validators[kind];
  if (!validate(body)) {
    const fields = [...new Set((validate.errors ?? []).map((e) => e.instancePath || '/'))];
    throw ApiError.validation({ fields });
  }
  return body as T;
}

/** يقسم البيانات الفنية: ما له أعمدة، وما يُخزَّن في technical (جديد بلا مفاتيح خارج القائمة). */
export function splitTechnical(t: MediaTechnical): {
  columns: { durationMs: number; startPtsUs: number; width: number | null; height: number | null };
  json: Record<string, unknown>;
} {
  const json: Record<string, unknown> = {};
  for (const k of TECHNICAL_JSON_KEYS) if (t[k] !== undefined) json[k] = t[k];
  return { columns: { durationMs: t.duration_ms, startPtsUs: t.start_pts_us, width: t.width ?? null, height: t.height ?? null }, json };
}
