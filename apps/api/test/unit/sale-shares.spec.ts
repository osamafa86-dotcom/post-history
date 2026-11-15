import { itemSharesFromDetails, itemSharesToDetails, totalShares, type ItemShares } from '../../src/commerce/sale-shares';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';

// حصص بنود البيعة في تفاصيل قيدها (ADR 0031، تعديل 2026-11-15): تُكتب بمعرّفات وأرقام وحدها وتُقرأ كما كُتبت
describe('sale item shares in the entry details', () => {
  const shares: ItemShares[] = [
    { orderItemId: ITEM, platform: 3_000n, contributors: [{ userId: A, amount: 4_667n }, { userId: B, amount: 2_333n }] },
  ];

  it('round-trips through the details and adds up per account', () => {
    const details = { item_shares: itemSharesToDetails(shares) };
    expect(details.item_shares).toEqual([{ order_item_id: ITEM, platform_minor: 3_000, contributors: [{ user_id: A, amount_minor: 4_667 }, { user_id: B, amount_minor: 2_333 }] }]);
    expect(itemSharesFromDetails(JSON.parse(JSON.stringify(details)))).toEqual(shares);
    const total = totalShares([...shares, { orderItemId: ITEM, platform: 500n, contributors: [{ userId: A, amount: 500n }] }]);
    expect(total.platform).toBe(3_500n);
    expect([...total.contributors]).toEqual([[A, 5_167n], [B, 2_333n]]);
  });

  it('reads an entry written before the shares were recorded, or a malformed value, as absent', () => {
    for (const details of [
      null,
      {},
      { item_basis_points: [3000] },
      { item_shares: 'x' },
      { item_shares: [{ order_item_id: 'not-a-uuid', platform_minor: 1, contributors: [] }] },
      { item_shares: [{ order_item_id: ITEM, platform_minor: -1, contributors: [] }] },
      { item_shares: [{ order_item_id: ITEM, platform_minor: 1.5, contributors: [] }] },
      { item_shares: [{ order_item_id: ITEM, platform_minor: 1 }] },
      { item_shares: [{ order_item_id: ITEM, platform_minor: 1, contributors: [{ user_id: A, amount_minor: '5' }] }] },
      { item_shares: [{ order_item_id: ITEM, platform_minor: 1, contributors: [{ user_id: 'x', amount_minor: 5 }] }] },
      { item_shares: [null] },
    ]) {
      expect(itemSharesFromDetails(details)).toBeNull();
    }
    expect(itemSharesFromDetails({ item_shares: [] })).toEqual([]);
  });
});
