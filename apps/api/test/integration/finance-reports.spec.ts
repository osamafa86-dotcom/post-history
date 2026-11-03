import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { type AccountRef, postEntry } from '../../src/commerce/ledger';
import { money } from '../../src/commerce/money';
import { schemaValidator } from '../../src/common/contract';
import { DB, type Database } from '../../src/database/database.module';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
type Row = { user_id: string; sales: number; gross: { amount_minor: number }; fees_and_taxes: { amount_minor: number }; net: { amount_minor: number };
  share: { amount_minor: number }; refunded: { amount_minor: number }; share_basis_points: number | null; currency: string; work_name: string | null;
  balance: { pending: { amount_minor: number } } };
const SECRET = randomBytes(32).toString('hex');

// قراءات المال المجمّعة للوحة الإدارة (ADR 0099، A4 وA5): مستحقات المساهمين في شهر من الدفتر، ومشتريات المؤسسات في سنة
describe('finance reports (/v1/contributor-earnings, /v1/buyer-purchase-totals)', () => {
  let h: Harness;
  let db: Database;
  let admin: Actor;
  let finance: Actor;
  let chief: Actor;
  let rights: Actor;
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const year = now.getUTCFullYear();

  beforeAll(async () => {
    h = await createHarness({ env: { PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: SECRET, SANDBOX_CHECKOUT_BASE_URL: 'http://api.test' } });
    db = h.app.get(DB);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (a: Actor, url: string) => http().get(`/v1${url}`).set(as(a.token));
  const post = (t: string, url: string, body: object = {}) => http().post(`/v1${url}`).set(as(t)).set('Idempotency-Key', randomUUID()).send(body);
  const pending = (ownerId: string): AccountRef => ({ kind: 'contributor_payable', ownerId, state: 'pending', currency: 'USD' });
  // كل صفوف الشهر بالمرور على الصفحات
  const allRows = async (a: Actor = finance) => {
    const rows: Row[] = [];
    let cursor: string | null = null;
    let body: { items: Row[]; next_cursor: string | null; totals: Array<Record<string, unknown>> };
    do {
      body = (await get(a, `/contributor-earnings?month=${month}&limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body;
      rows.push(...body.items);
      cursor = body.next_cursor;
    } while (cursor);
    return { rows, totals: body.totals };
  };

  it('splits each sale between its contributors by their share of the pool, with fees, net, refunds and the frozen rate; totals are the sums of the rows', async () => {
    const a = await seedUser(h);
    const b = await seedUser(h);
    await h.pool.query(`UPDATE users SET work_name = 'مراسل تجريبي ١' WHERE id = $1`, [a.id]);
    // سعر 10000، رسوم بوابة 1000، فالصافي 9000؛ نسبة المساهمين 30% (2700) بحصتين 2:1، والباقي للمنصة
    const sale = await db.transaction((tx) =>
      postEntry(tx, {
        kind: 'sale',
        referenceType: 'order',
        referenceId: randomUUID(),
        details: { platform_basis_points: 7000 },
        idempotencyKey: randomUUID(),
        actorId: null,
        postings: [
          { account: { kind: 'provider_clearing', currency: 'USD' }, amount: money(9_000n, 'USD') },
          { account: { kind: 'provider_fees', currency: 'USD' }, amount: money(1_000n, 'USD') },
          { account: { kind: 'platform_revenue', currency: 'USD' }, amount: money(-7_300n, 'USD') },
          { account: pending(a.id), amount: money(-1_800n, 'USD') },
          { account: pending(b.id), amount: money(-900n, 'USD') },
        ],
      }),
    );
    await db.transaction((tx) =>
      postEntry(tx, {
        kind: 'refund',
        referenceType: 'order',
        referenceId: randomUUID(),
        idempotencyKey: randomUUID(),
        reversesEntryId: sale.entryId,
        actorId: null,
        postings: [
          { account: pending(a.id), amount: money(600n, 'USD') },
          { account: { kind: 'provider_clearing', currency: 'USD' }, amount: money(-600n, 'USD') },
        ],
      }),
    );

    const first = await get(finance, `/contributor-earnings?month=${month}`).expect(200);
    const valid = schemaValidator('ContributorEarningsPage');
    expect(valid(first.body) ? [] : valid.errors).toEqual([]);
    const { rows, totals } = await allRows();
    const rowA = rows.find((r) => r.user_id === a.id)!;
    const rowB = rows.find((r) => r.user_id === b.id)!;
    expect(rowA).toMatchObject({
      work_name: 'مراسل تجريبي ١', currency: 'USD', sales: 1, gross: { amount_minor: 6_667 }, fees_and_taxes: { amount_minor: 667 },
      net: { amount_minor: 6_000 }, share: { amount_minor: 1_800 }, refunded: { amount_minor: 600 }, share_basis_points: 3_000,
      balance: { pending: { amount_minor: 1_200 } },
    });
    expect(rowB).toMatchObject({ work_name: null, sales: 1, gross: { amount_minor: 3_333 }, net: { amount_minor: 3_000 }, share: { amount_minor: 900 }, refunded: { amount_minor: 0 } });
    // الأعلى نصيبًا أولًا
    expect(rows.findIndex((r) => r.user_id === a.id)).toBeLessThan(rows.findIndex((r) => r.user_id === b.id));

    const usd = rows.filter((r) => r.currency === 'USD');
    const sum = (f: (r: Row) => number) => usd.reduce((s, r) => s + f(r), 0);
    expect(totals.find((t) => t.currency === 'USD')).toMatchObject({
      contributors: new Set(usd.map((r) => r.user_id)).size,
      sales: sum((r) => r.sales),
      gross: { amount_minor: sum((r) => r.gross.amount_minor), currency: 'USD' },
      net: { amount_minor: sum((r) => r.net.amount_minor), currency: 'USD' },
      share: { amount_minor: sum((r) => r.share.amount_minor), currency: 'USD' },
      refunded: { amount_minor: sum((r) => r.refunded.amount_minor), currency: 'USD' },
    });
    // لا بريد ولا اسم حقيقي
    expect(JSON.stringify(rows)).not.toContain('@');
  });

  it('a paid order through the sandbox appears in the month of its contributor and in the year of its organization, with what was refunded', async () => {
    const reporter = (await seedUser(h)).id;
    const template = (
      await post(rights.token, '/license-templates', {
        type: 'editorial_single', name: { ar: 'ترخيص', en: 'License' }, terms: { ar: 'شروط', en: 'Terms' }, usage_media: ['web'],
        territory: { kind: 'worldwide' }, term_days: null, exclusivity_hours: null, deliverables: ['original'],
        attribution: { ar: 'المصدر', en: 'Source' }, prohibitions: [], base_price: { amount_minor: 10_000, currency: 'USD' }, enabled: true,
      }).expect(201)
    ).body.id as string;
    const listings: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { materialId } = await seedUploadSession(h, reporter);
      await h.pool.query(`UPDATE materials SET rights_state = 'sellable' WHERE id = $1`, [materialId]);
      const { rows } = await h.pool.query<{ id: string }>(
        `INSERT INTO catalog_listings (material_id, material_version, state, title_ar, title_en, description_ar, description_en, updated_by, listed_at)
         SELECT id, version, 'listed', 'عنوان', 'Title', 'وصف', 'Description', $2, now() FROM materials WHERE id = $1 RETURNING id`, [materialId, rights.id]);
      await h.pool.query(`INSERT INTO listing_offers (listing_id, license_template_id) VALUES ($1, $2)`, [rows[0]!.id, template]);
      listings.push(rows[0]!.id);
    }
    const org = (await h.pool.query<{ id: string }>(
      `INSERT INTO buyer_organizations (legal_name, display_name_ar, display_name_en, country, billing_email, status, verified_at, verified_by)
       VALUES ('Buyer LLC', 'مشترٍ', 'Buyer', 'JO', 'b@example.test', 'active', now(), gen_random_uuid()) RETURNING id`)).rows[0]!.id;
    const email = `buyer-${randomUUID()}@example.test`;
    const password = randomUUID();
    const buyerId = (await h.pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, organization_id) VALUES ($1, $2, $3) RETURNING id`, [email, await hash(password), org])).rows[0]!.id;
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, 'buyer_admin', 'organization', $2)`, [buyerId, org]);
    const buyerToken = (await http().post('/v1/auth/login').send({ email, password }).expect(200)).body.access_token as string;

    const order = (await post(buyerToken, '/orders', { items: listings.map((l) => ({ listing_id: l, license_template_id: template })), expected_total: { amount_minor: 20_000, currency: 'USD' } }).expect(201)).body;
    const session = (await post(buyerToken, `/orders/${order.id}/checkout`).expect(200)).body;
    await http().post(`/sandbox/checkout/${(session.checkout_url as string).split('/').pop()}/succeeded`).expect(202);
    const paid = (await http().get(`/v1/orders/${order.id}`).set(as(buyerToken)).expect(200)).body;
    expect(paid.status).toBe('paid');
    const refund = (await post(finance.token, `/orders/${order.id}/refunds`, { order_item_ids: [paid.items[0].id], reason_code: 'buyer_request' }).expect(201)).body;
    const ref = (await h.pool.query<{ r: string }>(`SELECT provider_refund_ref AS r FROM refunds WHERE id = $1`, [refund.id])).rows[0]!.r;
    await http().post(`/sandbox/refunds/${ref}/succeeded`).expect(202);

    const credited = (await h.pool.query<{ n: string }>(
      `SELECT (-sum(p.amount_minor))::text AS n FROM journal_entries j JOIN postings p ON p.entry_id = j.id JOIN ledger_accounts a ON a.id = p.account_id
       WHERE j.kind = 'sale' AND j.reference_id = $1 AND a.kind = 'contributor_payable' AND a.owner_id = $2`, [order.id, reporter])).rows[0]!.n;
    const { rows } = await allRows(admin);
    expect(rows.find((r) => r.user_id === reporter)).toMatchObject({
      sales: 1, gross: { amount_minor: 20_000 }, fees_and_taxes: { amount_minor: 0 }, net: { amount_minor: 20_000 },
      share: { amount_minor: Number(credited) }, refunded: { amount_minor: Number(credited) / 2 },
    });

    const totals = await get(finance, `/buyer-purchase-totals?year=${year}&limit=100`).expect(200);
    const valid = schemaValidator('BuyerPurchaseTotalsPage');
    expect(valid(totals.body) ? [] : valid.errors).toEqual([]);
    let items = totals.body.items as Array<{ organization_id: string }>;
    let cursor = totals.body.next_cursor as string | null;
    while (cursor) {
      const next = (await get(finance, `/buyer-purchase-totals?year=${year}&limit=100&cursor=${cursor}`).expect(200)).body;
      items = [...items, ...next.items];
      cursor = next.next_cursor;
    }
    expect(items.filter((i) => i.organization_id === org)).toEqual([
      { organization_id: org, currency: 'USD', paid_orders: 1, paid: { amount_minor: 20_000, currency: 'USD' }, refunded: { amount_minor: 10_000, currency: 'USD' } },
    ]);
    expect((await get(admin, `/buyer-purchase-totals?year=${year - 1}&limit=100`).expect(200)).body.items.filter((i: { organization_id: string }) => i.organization_id === org)).toEqual([]);
    await http().get(`/v1/buyer-purchase-totals?year=${year}`).set(as(buyerToken)).expect(403);
  });

  it('is for the admin and finance alone; a malformed month, year or cursor is 400', async () => {
    for (const a of [chief, rights]) {
      expect((await get(a, `/contributor-earnings?month=${month}`).expect(403)).body.code).toBe('forbidden_role');
      expect((await get(a, `/buyer-purchase-totals?year=${year}`).expect(403)).body.code).toBe('forbidden_role');
    }
    for (const q of ['month=2026-13', 'month=2026-1', '', `month=${month}&cursor=bad`]) {
      expect((await get(finance, `/contributor-earnings?${q}`).expect(400)).body.code).toBe('bad_request');
    }
    for (const q of ['year=1999', '', `year=${year}&cursor=bad`]) {
      expect((await get(finance, `/buyer-purchase-totals?${q}`).expect(400)).body.code).toBe('bad_request');
    }
  });
});
