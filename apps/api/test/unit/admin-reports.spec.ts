import { earningsTotals, type EarningsRow, monthRange } from '../../src/commerce/finance-reports.controller';
import { changedFields } from '../../src/settings/platform-settings.controller';

// قواعد القراءات المجمّعة وهوية المنصة (ADR 0099)
describe('admin reports and platform settings rules', () => {
  it('bounds a month in UTC, December into the next year', () => {
    expect(monthRange('2026-11')).toEqual(['2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z']);
    expect(monthRange('2026-12')).toEqual(['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  });

  it('totals are the sums of the rows per currency, with one rate only when every row agrees', () => {
    const row = (userId: string, share: bigint, over: Partial<EarningsRow> = {}): EarningsRow => ({
      userId, workName: null, currency: 'USD', sales: 2, gross: share * 4n, net: share * 3n, share, refunded: 0n, shareBasisPoints: 3000, ...over,
    });
    const totals = earningsTotals([row('a', 100n), row('b', 50n, { refunded: 10n }), row('a', 7n, { currency: 'ILS', shareBasisPoints: null })]);
    expect(totals).toEqual([
      {
        currency: 'USD', contributors: 2, sales: 4,
        gross: { amount_minor: 600, currency: 'USD' }, fees_and_taxes: { amount_minor: 150, currency: 'USD' }, net: { amount_minor: 450, currency: 'USD' },
        share: { amount_minor: 150, currency: 'USD' }, refunded: { amount_minor: 10, currency: 'USD' }, share_basis_points: 3000,
      },
      expect.objectContaining({ currency: 'ILS', contributors: 1, share_basis_points: null }),
    ]);
    expect(earningsTotals([row('a', 1n), row('b', 1n, { shareBasisPoints: 2500 })])[0]!.share_basis_points).toBeNull();
    expect(earningsTotals([])).toEqual([]);
  });

  it('names the changed fields in contract order, and none for the same values', () => {
    const current = { platformName: 'منصة', appName: 'تطبيق', watermarkText: 'معاينة' };
    expect(changedFields(current, { platform_name: 'منصة', app_name: 'تطبيق', watermark_text: 'معاينة' })).toEqual([]);
    expect(changedFields(current, { platform_name: 'منصة ٢', app_name: 'تطبيق', watermark_text: 'معاينة ٢' })).toEqual(['platform_name', 'watermark_text']);
  });
});
