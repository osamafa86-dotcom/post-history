import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * شهادات App Attest اصطناعية للاختبار: جذر ووسيطة بـ openssl، وشهادة جهاز لكل تسجيل تحمل امتداد الـ nonce، وتأكيدات
 * موقّعة بمفتاح الجهاز. تمر بشيفرة التحقق الحقيقية (app-attest.ts) بجذر الاختبار بدل جذر Apple.
 */
const sha256 = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export const AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]);
export const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop');

export interface Device {
  keyId: Buffer;
  privateKey: KeyObject;
}

export class AppAttestFixtures {
  private readonly dir = mkdtempSync(join(tmpdir(), 'app-attest-'));
  readonly rootPem: string;

  constructor() {
    this.openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', this.path('root.key'));
    this.openssl('req', '-x509', '-new', '-key', this.path('root.key'), '-subj', '/CN=Test App Attest Root', '-days', '2',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-out', this.path('root.pem'));
    this.issueCa('int', 'root');
    this.rootPem = readFileSync(this.path('root.pem'), 'utf8');
  }

  /** جذر آخر لا يثق به الخادم، لشهادات سلسلتها خاطئة. */
  foreignChain(): void {
    this.openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', this.path('evil.key'));
    this.openssl('req', '-x509', '-new', '-key', this.path('evil.key'), '-subj', '/CN=Test App Attest Root', '-days', '2',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-out', this.path('evil.pem'));
    this.issueCa('evilint', 'evil');
  }

  newDevice(): Device {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.of(4), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
    return { keyId: sha256(point), privateKey };
  }

  /** كائن attestKey بترميز base64 كما يرسله التطبيق. `tamper` يفسد جزءًا بعينه لاختبار الرفض. */
  attest(
    device: Device,
    challenge: Buffer,
    appId: string,
    opts: { aaguid?: Buffer; counter?: number; ca?: 'int' | 'evilint'; tamperAuthData?: boolean } = {},
  ): string {
    const authData = Buffer.concat([
      sha256(Buffer.from(appId)),
      Buffer.of(0x40),
      u32(opts.counter ?? 0),
      opts.aaguid ?? AAGUID_PRODUCTION,
      u16(device.keyId.length),
      device.keyId,
    ]);
    const nonce = sha256(authData, sha256(challenge));
    const ca = opts.ca ?? 'int';
    writeFileSync(this.path('dev.key'), device.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    writeFileSync(this.path('dev.ext'), `1.2.840.113635.100.8.2=DER:3024A1220420${nonce.toString('hex').toUpperCase()}\n`);
    this.openssl('req', '-new', '-key', this.path('dev.key'), '-subj', '/CN=device', '-out', this.path('dev.csr'));
    this.openssl('x509', '-req', '-in', this.path('dev.csr'), '-CA', this.path(`${ca}.pem`), '-CAkey', this.path(`${ca}.key`),
      '-CAcreateserial', '-days', '1', '-extfile', this.path('dev.ext'), '-out', this.path('dev.pem'));
    const leaf = derOf(readFileSync(this.path('dev.pem'), 'utf8'));
    const intermediate = derOf(readFileSync(this.path(`${ca}.pem`), 'utf8'));
    const finalAuth = opts.tamperAuthData ? Buffer.concat([authData.subarray(0, 34), Buffer.of(authData[34]! ^ 1), authData.subarray(35)]) : authData;
    return encodeCbor(new Map<string, unknown>([
      ['fmt', 'apple-appattest'],
      ['attStmt', new Map<string, unknown>([['x5c', [leaf, intermediate]], ['receipt', Buffer.alloc(0)]])],
      ['authData', finalAuth],
    ])).toString('base64');
  }

  /** تأكيد generateAssertion على clientData بعدّاد معيّن، بترميز base64. */
  assert(device: Device, clientData: Buffer, counter: number, appId: string): string {
    const authenticatorData = Buffer.concat([sha256(Buffer.from(appId)), Buffer.of(0x40), u32(counter)]);
    const nonce = sha256(authenticatorData, sha256(clientData));
    const signature = sign('sha256', nonce, device.privateKey);
    return encodeCbor(new Map<string, unknown>([['signature', signature], ['authenticatorData', authenticatorData]])).toString('base64');
  }

  close(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private issueCa(name: string, issuer: string): void {
    this.openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', this.path(`${name}.key`));
    this.openssl('req', '-new', '-key', this.path(`${name}.key`), '-subj', `/CN=Test App Attest CA ${name}`, '-out', this.path(`${name}.csr`));
    writeFileSync(this.path(`${name}.ext`), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
    this.openssl('x509', '-req', '-in', this.path(`${name}.csr`), '-CA', this.path(`${issuer}.pem`), '-CAkey', this.path(`${issuer}.key`),
      '-CAcreateserial', '-days', '2', '-extfile', this.path(`${name}.ext`), '-out', this.path(`${name}.pem`));
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private openssl(...args: string[]): void {
    execFileSync('openssl', args, { stdio: 'pipe' });
  }
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function derOf(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

/** مشفّر CBOR صغير للاختبار: نص، بايت، مصفوفة، خريطة، أعداد صحيحة غير سالبة. */
export function encodeCbor(value: unknown): Buffer {
  if (typeof value === 'number') return head(0, value);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  if (value instanceof Map) {
    const parts: Buffer[] = [head(5, value.size)];
    for (const [k, v] of value) parts.push(encodeCbor(k), encodeCbor(v));
    return Buffer.concat(parts);
  }
  throw new Error('unsupported CBOR value');
}

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.of((major << 5) | n);
  if (n < 0x100) return Buffer.of((major << 5) | 24, n);
  if (n < 0x10000) return Buffer.concat([Buffer.of((major << 5) | 25), u16(n)]);
  return Buffer.concat([Buffer.of((major << 5) | 26), u32(n)]);
}
