import { reserveAndRequestable, reserveOf } from '../../src/commerce/payouts';

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

  // ADR 0031، تعديل 2026-11-15: الأساس المتاح وما حُجز للصرف وما صُرف خلال فترة الاسترداد، والاحتياطي يُحتجز من المتاح
  it('takes the reserve of everything a refund may still reach, out of the available balance', () => {
    const split = (available: bigint, inPayout: bigint, paidRecently: bigint) => reserveAndRequestable({ available, inPayout, paidRecently }, 1000);
    expect(split(10_000n, 0n, 0n)).toEqual({ reserve: 1_000n, requestable: 9_000n });
    // المبلغ نفسه موزَّعًا على المتاح وقيد الصرف والمصروف حديثًا: الاحتياطي واحد
    expect(split(6_000n, 4_000n, 0n)).toEqual({ reserve: 1_000n, requestable: 5_000n });
    expect(split(1_000n, 0n, 9_000n)).toEqual({ reserve: 1_000n, requestable: 0n });
    // المتاح أقل من الاحتياطي: لا يُطلب شيء، ولا قيمة سالبة
    expect(split(500n, 0n, 9_500n)).toEqual({ reserve: 1_000n, requestable: 0n });
    expect(reserveAndRequestable({ available: 5_000n, inPayout: 5_000n, paidRecently: 0n }, 0)).toEqual({ reserve: 0n, requestable: 5_000n });
  });

  it('whatever the split into requests, the total requested never passes the first requestable amount', () => {
    for (const bps of [1, 1000, 3333, 5000]) {
      for (const total of [1n, 999n, 10_000n, 191_046n]) {
        const first = reserveAndRequestable({ available: total, inPayout: 0n, paidRecently: 0n }, bps).requestable;
        let available = total;
        let held = 0n;
        for (let i = 0; i < 20; i++) {
          const { requestable } = reserveAndRequestable({ available, inPayout: held, paidRecently: 0n }, bps);
          const take = requestable / 2n > 0n ? requestable / 2n : requestable;
          available -= take;
          held += take;
        }
        expect(held <= first).toBe(true);
      }
    }
  });
});
