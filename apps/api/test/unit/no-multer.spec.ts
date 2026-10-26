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

// multer مثبّت بـ overrides على إصدار فيه إصلاح GHSA-q7qp-rjg7-q26m (ADR 0040)، ويبقى بلا مسار يحلل multipart
describe('multer (ADR 0040)', () => {
  it('the resolved multer is 2.5.0 or later, through the package.json override', () => {
    const lock = JSON.parse(readFileSync(join(__dirname, '../../package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { overrides?: Record<string, string> };
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path.endsWith('node_modules/multer'))
      .map(([, p]) => p.version!.split('.').map(Number));
    expect(versions.length).toBeGreaterThan(0);
    for (const [major, minor] of versions) expect(major! > 2 || (major === 2 && minor! >= 5)).toBe(true);
    expect(pkg.overrides?.multer).toBe('2.5.0');
  });

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
  const entry = { id: 'GHSA-aaaa', reason: 'r', added: '2026-10-26', expires: '2026-12-25', removal_condition: 'w' };

  it('blocks any high or critical advisory not on the list, allows listed ones, ignores moderate, and reports stale entries', () => {
    const r = check(report([['GHSA-aaaa', 'high'], ['GHSA-bbbb', 'critical'], ['GHSA-cccc', 'moderate']]), [entry, { ...entry, id: 'GHSA-gone' }], '2026-10-26');
    expect(r.blocking.map((b) => b.id)).toEqual(['GHSA-bbbb']);
    expect(r.allowed.map((b) => b.id)).toEqual(['GHSA-aaaa']);
    expect(r.stale).toEqual(['GHSA-gone']);
    expect(advisories(report([['GHSA-cccc', 'moderate']]))).toEqual([]);
  });

  it('refuses an entry without a reason, a date, an expiry or a removal condition', () => {
    for (const key of ['reason', 'added', 'expires', 'removal_condition']) {
      expect(() => check(report([]), [{ ...entry, [key]: '' }])).toThrow(key);
    }
    expect(() => check(report([]), [{ ...entry, added: '2999-01-01' }], '2026-10-26')).toThrow('future');
  });

  it('an exception lasts 60 days at most and fails the check once expired', () => {
    expect(() => check(report([]), [{ ...entry, expires: '2026-12-26' }], '2026-10-26')).toThrow('60 days');
    expect(() => check(report([]), [entry], '2026-12-25')).not.toThrow();
    expect(() => check(report([]), [entry], '2026-12-26')).toThrow('expired');
  });
});
