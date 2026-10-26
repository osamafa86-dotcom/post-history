/**
 * المال في الخادم (ADR 0031، ADR 0025 §7): عدد صحيح بأصغر وحدة (`bigint`) وعملة من قائمة مغلقة. لا `number` للمال داخل
 * الخادم، ولا عملية بين عملتين. الحدود مع العقد (`Money {amount_minor: integer}`) تمر بـ fromContract وtoContract وحدهما.
 */
export const CURRENCIES = ['USD', 'ILS'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export interface ContractMoney {
  amount_minor: number;
  currency: Currency;
}

export class CurrencyMismatchError extends Error {
  override name = 'CurrencyMismatchError';
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

export function money(amountMinor: bigint | number, currency: Currency): Money {
  if (typeof amountMinor === 'number' && !Number.isSafeInteger(amountMinor)) throw new RangeError('amount_minor must be a safe integer');
  if (!isCurrency(currency)) throw new RangeError('unknown currency');
  return { amountMinor: BigInt(amountMinor), currency };
}

export function fromContract(m: ContractMoney): Money {
  return money(m.amount_minor, m.currency);
}

export function toContract(m: Money): ContractMoney {
  if (m.amountMinor > BigInt(Number.MAX_SAFE_INTEGER) || m.amountMinor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('amount_minor exceeds the contract integer range');
  }
  return { amount_minor: Number(m.amountMinor), currency: m.currency };
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(`${a.currency} and ${b.currency} cannot be combined`);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), money(0n, currency));
}

/** «33.33» (نسبة مئوية بمنزلتين، كما في material_contributors.share_percent) → 3333 جزءًا من عشرة آلاف. */
export function percentToBasisPoints(percent: string): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent);
  if (!m) throw new RangeError('percent must have at most two decimals');
  const value = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  if (value > 10_000n) throw new RangeError('percent above 100');
  return value;
}

/**
 * يقسم المبلغ على الأوزان بالقسمة الصحيحة، ثم يوزّع الباقي وحدةً وحدةً بطريقة «الباقي الأكبر»: الأكبر كسرًا أولًا، والتعادل
 * بالمفتاح تصاعديًا. فمجموع الحصص يساوي المبلغ بالضبط، والنتيجة لا تتبع ترتيب المدخلات. المبلغ السالب (الاسترداد) يُقسم
 * بقيمته المطلقة ثم تُعكس إشارته، فتعكس كل حصة حصتها في البيعة.
 */
export function allocate(total: Money, weights: ReadonlyArray<{ key: string; weight: bigint }>): Map<string, Money> {
  if (weights.length === 0) throw new RangeError('at least one weight is required');
  if (new Set(weights.map((w) => w.key)).size !== weights.length) throw new RangeError('weight keys must be unique');
  if (weights.some((w) => w.weight < 0n)) throw new RangeError('weights must not be negative');
  const W = weights.reduce((acc, w) => acc + w.weight, 0n);
  if (W === 0n) throw new RangeError('weights must not all be zero');

  const sign = total.amountMinor < 0n ? -1n : 1n;
  const amount = total.amountMinor * sign;
  const parts = weights.map((w) => ({ key: w.key, base: (amount * w.weight) / W, fraction: (amount * w.weight) % W }));
  let rest = amount - parts.reduce((acc, p) => acc + p.base, 0n);
  const order = [...parts].sort((a, b) => (a.fraction === b.fraction ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.fraction > b.fraction ? -1 : 1));
  for (const p of order) {
    if (rest === 0n) break;
    p.base += 1n;
    rest -= 1n;
  }
  return new Map(parts.map((p) => [p.key, { amountMinor: p.base * sign, currency: total.currency }]));
}
