import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * مصادِق WebAuthn برمجي للاختبار (ADR 0107): مفتاح ES256 (P-256) على «الجهاز»، وشهادة `none`، وردود بصيغة JSON من Level 3 كما
 * يعيدها `PublicKeyCredential.toJSON()`. يوقّع ما يوقّعه المصادِق الحقيقي (بيانات المصادِق ‖ بصمة بيانات العميل) بتوقيع DER.
 */
export interface SoftCredential {
  id: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  userHandle: string;
  counter: number;
  multiDevice: boolean;
}

type Options = { challenge: string; rp?: { id?: string }; rpId?: string; user?: { id: string } };

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  constructor(
    readonly origin: string,
    readonly rpId: string,
  ) {}

  /** `navigator.credentials.create()` ثم `toJSON()`: يعيد الرد والاعتماد المحفوظ على «الجهاز». */
  create(options: Options, opts: { multiDevice?: boolean; userVerified?: boolean; origin?: string; type?: string; id?: Buffer } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const credential: SoftCredential = {
      id: opts.id ?? randomBytes(32),
      privateKey,
      publicKey,
      userHandle: options.user!.id,
      counter: 0,
      multiDevice: opts.multiDevice ?? true,
    };
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const attested = Buffer.concat([Buffer.alloc(16), u16(credential.id.length), credential.id, cose]);
    const authData = Buffer.concat([
      sha256(options.rp?.id ?? this.rpId),
      Buffer.of(flags({ uv: opts.userVerified ?? true, be: credential.multiDevice, attested: true })),
      u32(0),
      attested,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: opts.type ?? 'webauthn.create', challenge: options.challenge, origin: opts.origin ?? this.origin, crossOrigin: false }),
    );
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      credential,
      json: {
        id: b64u(credential.id),
        rawId: b64u(credential.id),
        type: 'public-key',
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      },
    };
  }

  /** `navigator.credentials.get()` ثم `toJSON()` باعتماد محفوظ؛ العدّاد يرتفع إلا لمفتاح متزامن (يبقى صفرًا كما تفعل المزامنة). */
  get(
    credential: SoftCredential,
    options: Options,
    opts: { userVerified?: boolean; origin?: string; counter?: number; userHandle?: string | null; rpId?: string } = {},
  ) {
    if (!credential.multiDevice) credential.counter += 1;
    const counter = opts.counter ?? credential.counter;
    const authData = Buffer.concat([
      sha256(opts.rpId ?? options.rpId ?? this.rpId),
      Buffer.of(flags({ uv: opts.userVerified ?? true, be: credential.multiDevice, attested: false })),
      u32(counter),
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: opts.origin ?? this.origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), credential.privateKey);
    const userHandle = opts.userHandle === undefined ? credential.userHandle : opts.userHandle;
    return {
      id: b64u(credential.id),
      rawId: b64u(credential.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle === null ? {} : { userHandle }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

function flags(f: { uv: boolean; be: boolean; attested: boolean }): number {
  // UP=0x01 UV=0x04 BE=0x08 BS=0x10 AT=0x40 (المتزامن محفوظ نسخة: BE وBS معًا)
  return 0x01 | (f.uv ? 0x04 : 0) | (f.be ? 0x18 : 0) | (f.attested ? 0x40 : 0);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** مشفّر CBOR صغير: أعداد صحيحة (والسالبة)، ونص، وبايت، وخريطة. */
function cbor(value: unknown): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    const parts: Buffer[] = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
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
