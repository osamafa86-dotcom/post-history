import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { HashPool, hashInline } from '../../src/verification/hash-pool';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** تدفق بأجزاء غير منتظمة، بعضها شرائح من ذاكرة واحدة مشتركة (كما في تدفقات الشبكة). */
const chunked = (data: Buffer, sizes = [1, 7, 4096, 65536, 3 * 1024 * 1024]) => {
  const parts: Buffer[] = [];
  for (let i = 0, k = 0; i < data.length; k++) {
    const n = sizes[k % sizes.length]!;
    parts.push(data.subarray(i, i + n));
    i += n;
  }
  return Readable.from(parts);
};

describe('HashPool (SHA-256 off the event loop)', () => {
  let pool: HashPool;
  beforeAll(() => {
    pool = new HashPool(2);
  });
  afterAll(() => pool.close());

  it('matches the inline hash for empty, small and multi-batch inputs', async () => {
    for (const size of [0, 1, 4 * 1024 * 1024 - 1, 4 * 1024 * 1024, 9 * 1024 * 1024 + 13]) {
      const data = randomBytes(size);
      const r = await pool.hash(chunked(data));
      expect({ size, hex: r.sha256.toString('hex'), bytes: r.bytes }).toEqual({ size, hex: sha(data), bytes: size });
      expect((await hashInline(chunked(data))).sha256.toString('hex')).toBe(sha(data));
    }
  });

  it('hashes more streams than threads at once, each correctly', async () => {
    const inputs = Array.from({ length: 6 }, (_, i) => randomBytes(2 * 1024 * 1024 + i));
    const results = await Promise.all(inputs.map((d) => pool.hash(chunked(d))));
    expect(results.map((r) => r.sha256.toString('hex'))).toEqual(inputs.map(sha));
  });

  it('leaves the chunks it was given untouched (shared memory is copied, not transferred)', async () => {
    const data = randomBytes(5 * 1024 * 1024);
    const copy = Buffer.from(data);
    await pool.hash(chunked(data));
    expect(data.equals(copy)).toBe(true);
  });

  it('a failing stream rejects and the pool keeps working', async () => {
    async function* broken() {
      yield randomBytes(5 * 1024 * 1024);
      throw new Error('storage reset');
    }
    await expect(pool.hash(broken())).rejects.toThrow('storage reset');
    const data = randomBytes(1024);
    expect((await pool.hash(chunked(data))).sha256.toString('hex')).toBe(sha(data));
  });

  it('refuses to start after close', async () => {
    const p = new HashPool(1);
    await p.close();
    await expect(p.hash(Readable.from([Buffer.from('x')]))).rejects.toThrow('closed');
  });
});
