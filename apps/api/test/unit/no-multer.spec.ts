import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { advisories, check } = require('../../tools/audit-allowlist.cjs') as {
  advisories: (r: object) => Array<{ id: string }>;
  check: (r: object, a: object[], today?: string) => { blocking: Array<{ id: string }>; allowed: Array<{ id: string }>; stale: string[] };
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'generated' ? [] : files(path)) : path.endsWith('.ts') ? [path] : [];
  });
}

// شرط استثناء multer (ADR 0040): لا مسار يحلل multipart، فثغرة multer غير قابلة للوصول من الخادم
describe('multer allowlist condition (ADR 0040)', () => {
  it('no source file uses FileInterceptor, multer or a multipart parser', () => {
    const hits = files(join(__dirname, '../../src')).filter((f) =>
      /FileInterceptor|FilesInterceptor|AnyFilesInterceptor|FileFieldsInterceptor|UploadedFiles?\(|MulterModule|from ['"]multer['"]/.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});

describe('audit allowlist check', () => {
  const report = (ids: Array<[string, string]>) => ({
    vulnerabilities: Object.fromEntries(ids.map(([id, severity], i) => [`p${i}`, { via: [{ url: `https://github.com/advisories/${id}`, severity, name: `p${i}` }, 'transitive'] }])),
  });
  const entry = { id: 'GHSA-aaaa', reason: 'r', added: '2026-10-26', remove_when: 'w' };

  it('blocks any high or critical advisory not on the list, allows listed ones, ignores moderate, and reports stale entries', () => {
    const r = check(report([['GHSA-aaaa', 'high'], ['GHSA-bbbb', 'critical'], ['GHSA-cccc', 'moderate']]), [entry, { ...entry, id: 'GHSA-gone' }], '2026-10-26');
    expect(r.blocking.map((b) => b.id)).toEqual(['GHSA-bbbb']);
    expect(r.allowed.map((b) => b.id)).toEqual(['GHSA-aaaa']);
    expect(r.stale).toEqual(['GHSA-gone']);
    expect(advisories(report([['GHSA-cccc', 'moderate']]))).toEqual([]);
  });

  it('refuses an entry without a reason, a date or a removal condition', () => {
    for (const key of ['reason', 'added', 'remove_when']) {
      expect(() => check(report([]), [{ ...entry, [key]: '' }])).toThrow(key);
    }
    expect(() => check(report([]), [{ ...entry, added: '2999-01-01' }], '2026-10-26')).toThrow('future');
  });
});
