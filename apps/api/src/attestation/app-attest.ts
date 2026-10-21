import { createHash, createPublicKey, type KeyObject, verify, X509Certificate } from 'node:crypto';
import { cborGet, decodeCbor } from './cbor';

/**
 * التحقق من App Attest على الخادم (ADR 0011، وثيقة Apple «Validating apps that connect to your server»). كل فشل
 * AttestationRejected بسبب داخلي للسجل فقط؛ الرد للعميل 403 attestation_failed واحد لا يكشف أي خطوة فشلت.
 */
export class AttestationRejected extends Error {
  constructor(readonly reason: string) {
    super(`attestation rejected: ${reason}`);
  }
}

// جذر Apple App Attestation Root CA (صالح حتى 2045-03-15)، مثبّت في الكود لا من الإعداد؛ بصمته SHA-256:
// 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

// 1.2.840.113635.100.8.2 (امتداد الـ nonce في شهادة الجهاز) بترميز DER مع الوسم والطول
const NONCE_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]);
const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop');

const sha256 = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export interface AppAttestPolicy {
  appId: string;
  allowDevelopment: boolean;
  root: X509Certificate;
}

export interface AttestedKey {
  /** المفتاح العام للجهاز (SPKI DER) يُخزَّن ويُتحقق به من كل تأكيد لاحق */
  publicKeySpki: Buffer;
  environment: 'production' | 'development';
}

/**
 * تسجيل مفتاح: `attestation` كائن CBOR من attestKey، و`keyId` المعرّف الخام (بعد فك base64)، و`challenge` التحدي
 * الخام الذي وقّعه التطبيق (clientDataHash = SHA-256(challenge)).
 */
export function verifyAttestation(attestation: Buffer, keyId: Buffer, challenge: Buffer, policy: AppAttestPolicy, now = new Date()): AttestedKey {
  const obj = decodeOrReject(attestation);
  if (cborGet(obj, 'fmt') !== 'apple-appattest') throw new AttestationRejected('fmt');
  const attStmt = cborGet(obj, 'attStmt');
  const authData = cborGet(obj, 'authData');
  const x5c = cborGet(attStmt ?? null, 'x5c');
  if (!Buffer.isBuffer(authData) || !Array.isArray(x5c) || x5c.length < 2 || !x5c.every(Buffer.isBuffer)) {
    throw new AttestationRejected('structure');
  }

  // 1. السلسلة: شهادة الجهاز ← الوسيطة ← الجذر، كلٌّ صالحة الآن
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    leaf = new X509Certificate(x5c[0] as Buffer);
    intermediate = new X509Certificate(x5c[1] as Buffer);
  } catch {
    throw new AttestationRejected('certificate');
  }
  for (const cert of [leaf, intermediate, policy.root]) {
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) throw new AttestationRejected('validity');
  }
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw new AttestationRejected('chain');
  if (!intermediate.checkIssued(policy.root) || !intermediate.verify(policy.root.publicKey)) throw new AttestationRejected('chain');

  // 2. الـ nonce في امتداد الشهادة = SHA-256(authData ‖ SHA-256(challenge))
  const nonce = sha256(authData, sha256(challenge));
  if (!nonceExtension(leaf.raw).equals(nonce)) throw new AttestationRejected('nonce');

  // 3. المعرّف = SHA-256 للمفتاح العام غير المضغوط في الشهادة
  const publicKey = leaf.publicKey;
  if (!sha256(rawPoint(publicKey)).equals(keyId)) throw new AttestationRejected('key_id');

  // 4. authData: rpIdHash، العدّاد صفر، البيئة، والمعرّف
  const auth = parseAuthData(authData, true);
  if (!auth.rpIdHash.equals(sha256(Buffer.from(policy.appId)))) throw new AttestationRejected('rp_id');
  if (auth.signCount !== 0) throw new AttestationRejected('counter');
  let environment: AttestedKey['environment'];
  if (auth.aaguid!.equals(AAGUID_PRODUCTION)) environment = 'production';
  else if (auth.aaguid!.equals(AAGUID_DEVELOPMENT) && policy.allowDevelopment) environment = 'development';
  else throw new AttestationRejected('aaguid');
  if (!auth.credentialId!.equals(keyId)) throw new AttestationRejected('credential_id');

  return { publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }) as Buffer, environment };
}

/**
 * تأكيد لكل رمز ingest: `assertion` كائن CBOR من generateAssertion على clientDataHash = SHA-256(clientData). يعيد
 * العدّاد الجديد؛ على المستدعي أن يشترط تجاوزه للمخزَّن (إعادة التشغيل) ويحدّثه في المعاملة نفسها.
 */
export function verifyAssertion(assertion: Buffer, clientData: Buffer, publicKeySpki: Buffer, appId: string): { signCount: number } {
  const obj = decodeOrReject(assertion);
  const signature = cborGet(obj, 'signature');
  const authData = cborGet(obj, 'authenticatorData');
  if (!Buffer.isBuffer(signature) || !Buffer.isBuffer(authData)) throw new AttestationRejected('structure');
  const nonce = sha256(authData, sha256(clientData));
  let ok = false;
  try {
    ok = verify('sha256', nonce, createPublicKey({ key: publicKeySpki, format: 'der', type: 'spki' }), signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new AttestationRejected('signature');
  const auth = parseAuthData(authData, false);
  if (!auth.rpIdHash.equals(sha256(Buffer.from(appId)))) throw new AttestationRejected('rp_id');
  return { signCount: auth.signCount };
}

function decodeOrReject(data: Buffer) {
  try {
    return decodeCbor(data);
  } catch {
    throw new AttestationRejected('cbor');
  }
}

/** rpIdHash (32) ‖ flags (1) ‖ signCount (4)، ثم في التسجيل: aaguid (16) ‖ طول المعرّف (2) ‖ المعرّف ‖ مفتاح COSE. */
function parseAuthData(data: Buffer, attested: boolean) {
  if (data.length < 37) throw new AttestationRejected('auth_data');
  const out: { rpIdHash: Buffer; signCount: number; aaguid?: Buffer; credentialId?: Buffer } = {
    rpIdHash: data.subarray(0, 32),
    signCount: data.readUInt32BE(33),
  };
  if (!attested) return out;
  if (data.length < 55) throw new AttestationRejected('auth_data');
  out.aaguid = data.subarray(37, 53);
  const len = data.readUInt16BE(53);
  if (data.length < 55 + len) throw new AttestationRejected('auth_data');
  out.credentialId = data.subarray(55, 55 + len);
  return out;
}

/** النقطة غير المضغوطة 0x04 ‖ X ‖ Y لمفتاح P-256. */
function rawPoint(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new AttestationRejected('key_type');
  return Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

/** محتوى امتداد الـ nonce: SEQUENCE { [1] EXPLICIT OCTET STRING (32) } داخل extnValue. */
function nonceExtension(der: Buffer): Buffer {
  const at = der.indexOf(NONCE_OID);
  if (at < 0 || der.indexOf(NONCE_OID, at + 1) >= 0) throw new AttestationRejected('nonce_extension');
  let tlv = readTlv(der, at + NONCE_OID.length);
  if (tlv.tag === 0x01) tlv = readTlv(der, tlv.end); // critical
  if (tlv.tag !== 0x04) throw new AttestationRejected('nonce_extension');
  const seq = readTlv(der, tlv.start);
  if (seq.tag !== 0x30 || seq.end !== tlv.end) throw new AttestationRejected('nonce_extension');
  const tagged = readTlv(der, seq.start);
  if (tagged.tag !== 0xa1) throw new AttestationRejected('nonce_extension');
  const octets = readTlv(der, tagged.start);
  if (octets.tag !== 0x04 || octets.end - octets.start !== 32) throw new AttestationRejected('nonce_extension');
  return der.subarray(octets.start, octets.end);
}

function readTlv(buf: Buffer, pos: number): { tag: number; start: number; end: number } {
  if (pos + 2 > buf.length) throw new AttestationRejected('der');
  const tag = buf[pos]!;
  let len = buf[pos + 1]!;
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 2 || start + n > buf.length) throw new AttestationRejected('der');
    len = n === 1 ? buf[start]! : buf.readUInt16BE(start);
    start += n;
  }
  if (start + len > buf.length) throw new AttestationRejected('der');
  return { tag, start, end: start + len };
}
