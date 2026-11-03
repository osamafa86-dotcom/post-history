import { returnUrlFor } from '../../src/commerce/orders.service';
import { SANDBOX_OUTCOMES, SANDBOX_PAGE_MESSAGES, sandboxPage } from '../../src/commerce/sandbox-page';

const money = { amountMinor: 10_001n, currency: 'USD' } as const;

describe('sandbox checkout page and return (ADR 0032, addendum 2026-11-03)', () => {
  it('renders in the session locale with lang and dir, the store trial notice and a labelled button per outcome', () => {
    const ar = sandboxPage('sbx_1', money, 'ar', undefined);
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain(SANDBOX_PAGE_MESSAGES.ar.notice);
    expect(ar).toContain('<bdi dir="ltr">100.01 USD</bdi>');
    for (const o of SANDBOX_OUTCOMES) {
      expect(ar).toContain(`action="sbx_1/${o}?return=1"`);
      expect(ar).toContain(`>${SANDBOX_PAGE_MESSAGES.ar.labels[o].label}<`);
    }
    // بلا قالب عودة لا رابط عودة
    expect(ar).not.toContain('<a ');
    const en = sandboxPage('sbx_1', money, 'en', 'https://web.example/en/store/orders/o1?returned=1');
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).toContain('Test payment environment: no real money is charged.');
    expect(en).toContain('<a href="https://web.example/en/store/orders/o1">');
  });

  it('the two locales carry the same keys, and markup in a reference or URL is escaped', () => {
    expect(Object.keys(SANDBOX_PAGE_MESSAGES.en.labels).sort()).toEqual(Object.keys(SANDBOX_PAGE_MESSAGES.ar.labels).sort());
    const page = sandboxPage('a"><script>x</script>', money, 'en', 'https://web.example/en/store/orders/o1?x="><b>');
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('"><b>');
  });

  it('the return template takes the order id and the locale from the closed list alone', () => {
    expect(returnUrlFor('https://web.example/{locale}/store/orders/{order_id}?returned=1', 'o1', 'en')).toBe('https://web.example/en/store/orders/o1?returned=1');
    // قالب بلا {locale} يبقى كما كان
    expect(returnUrlFor('https://web.example/ar/orders/{order_id}', 'o1', 'en')).toBe('https://web.example/ar/orders/o1');
  });
});
