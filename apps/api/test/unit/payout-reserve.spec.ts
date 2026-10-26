import { reserveOf } from '../../src/commerce/payouts';

// الاحتياطي من المتاح بنقاط أساس، مقرَّبًا لأعلى فلا يُطلب سنت منه (ADR 0034)
describe('payout reserve', () => {
  it('rounds up and is never more than the available balance', () => {
    expect(reserveOf(9_000n, 1000)).toBe(900n);
    expect(reserveOf(9_001n, 1000)).toBe(901n);
    expect(reserveOf(1n, 1)).toBe(1n);
    expect(reserveOf(0n, 5000)).toBe(0n);
    expect(reserveOf(-5n, 5000)).toBe(0n);
    expect(reserveOf(12_345n, 0)).toBe(0n);
    for (const available of [1n, 7n, 999n, 10_000n, 123_456_789n]) {
      for (const bps of [1, 333, 2500, 5000]) {
        const r = reserveOf(available, bps);
        expect(r * 10_000n >= available * BigInt(bps)).toBe(true);
        expect(r <= available).toBe(true);
      }
    }
  });
});
