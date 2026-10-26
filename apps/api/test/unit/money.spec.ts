import { add, allocate, CurrencyMismatchError, fromContract, money, negate, percentToBasisPoints, subtract, sum, toContract } from '../../src/commerce/money';

// مولّد أرقام حتمي، فتتكرر الحالات نفسها في كل تشغيل ويُعاد إنتاج أي فشل بالبذرة
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Money (ADR 0031)', () => {
  it('adds and subtracts within one currency and refuses to mix two', () => {
    expect(add(money(150, 'USD'), money(50n, 'USD'))).toEqual(money(200n, 'USD'));
    expect(subtract(money(150, 'ILS'), money(200, 'ILS'))).toEqual(money(-50n, 'ILS'));
    expect(negate(money(7, 'USD'))).toEqual(money(-7n, 'USD'));
    expect(sum([money(1, 'USD'), money(2, 'USD')], 'USD')).toEqual(money(3n, 'USD'));
    expect(() => add(money(1, 'USD'), money(1, 'ILS'))).toThrow(CurrencyMismatchError);
    expect(() => sum([money(1, 'ILS')], 'USD')).toThrow(CurrencyMismatchError);
  });

  it('crosses the contract boundary as safe integers only, with a known currency', () => {
    expect(fromContract({ amount_minor: 15000, currency: 'USD' })).toEqual({ amountMinor: 15000n, currency: 'USD' });
    expect(toContract(money(15000n, 'ILS'))).toEqual({ amount_minor: 15000, currency: 'ILS' });
    expect(() => money(1.5, 'USD')).toThrow(RangeError);
    expect(() => money(1, 'EUR' as 'USD')).toThrow(RangeError);
    expect(() => toContract(money(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'USD'))).toThrow(RangeError);
  });

  it('reads contributor share percents with two decimals at most', () => {
    expect(['100', '33.33', '0.5', '0'].map(percentToBasisPoints)).toEqual([10_000n, 3333n, 50n, 0n]);
    for (const bad of ['100.01', '1.234', '-1', 'abc', '']) expect(() => percentToBasisPoints(bad)).toThrow(RangeError);
  });
});

describe('allocate (largest remainder)', () => {
  const shares = (total: bigint, w: Array<[string, bigint]>) =>
    Object.fromEntries([...allocate(money(total, 'USD'), w.map(([key, weight]) => ({ key, weight })))].map(([k, m]) => [k, m.amountMinor]));

  it('gives the leftover cents to the largest fractions, ties by key, independent of input order', () => {
    expect(shares(100n, [['a', 1n], ['b', 1n], ['c', 1n]])).toEqual({ a: 34n, b: 33n, c: 33n });
    expect(shares(100n, [['c', 1n], ['b', 1n], ['a', 1n]])).toEqual({ a: 34n, b: 33n, c: 33n });
    expect(shares(10n, [['x', 3333n], ['y', 3333n], ['z', 3334n]])).toEqual({ x: 3n, y: 3n, z: 4n });
    expect(shares(7n, [['only', 1n]])).toEqual({ only: 7n });
    expect(shares(5n, [['a', 1n], ['zero', 0n]])).toEqual({ a: 5n, zero: 0n });
  });

  it('a negative total (refund) mirrors the positive split share by share', () => {
    const w: Array<[string, bigint]> = [['a', 5000n], ['b', 3333n], ['c', 1667n]];
    const pos = shares(10_001n, w);
    const neg = shares(-10_001n, w);
    expect(Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, -v]))).toEqual(neg);
  });

  it('refuses no weights, duplicate keys, negative or all-zero weights', () => {
    for (const w of [[], [['a', 1n], ['a', 1n]], [['a', -1n]], [['a', 0n]]] as Array<Array<[string, bigint]>>) {
      expect(() => shares(10n, w)).toThrow(RangeError);
    }
  });

  it('property: for any amount and percents summing to 100, shares sum to the amount and each is within one unit of exact', () => {
    const next = rng(20261022);
    for (let run = 0; run < 2000; run++) {
      const n = 1 + Math.floor(next() * 6);
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(next() * 10_001)).sort((a, b) => a - b);
      const bounds = [0, ...cuts, 10_000];
      const w = Array.from({ length: n }, (_, i) => [`k${i}`, BigInt(bounds[i + 1]! - bounds[i]!)] as [string, bigint]);
      if (w.every(([, x]) => x === 0n)) continue;
      const amount = BigInt(Math.floor(next() * 1e12)) * (next() < 0.2 ? -1n : 1n);
      const got = shares(amount, w);
      const total = Object.values(got).reduce((a, b) => a + b, 0n);
      expect([run, total]).toEqual([run, amount]);
      for (const [key, weight] of w) {
        const exactTimesW = amount * weight;
        const diff = got[key]! * 10_000n - exactTimesW;
        expect([run, key, diff < 0n ? -diff < 10_000n : diff < 10_000n]).toEqual([run, key, true]);
      }
    }
  });
});
