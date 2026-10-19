import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

/** مقارنة ثابتة الزمن لنصين بأي طول (تُقارن بصمتاهما فلا يتسرب الطول). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// صيغة الحقل المشفر (مثل users.totp_secret_enc، materials.gps_enc): version (1) || iv (12) || tag (16) || ciphertext،
// AES-256-GCM، وبايت الإصدار بيانات مصادَق عليها (AAD) فلا يُبدَّل. الإصدار يسمّي المفتاح فيُدوَّر بلا إعادة تشفير فورية:
// الكتابة بالحالي، والقراءة بأي مفتاح في الحلقة (الحالي والسابق).
const IV_LEN = 12;
const TAG_LEN = 16;

export interface FieldKey {
  version: number;
  key: Buffer;
}

export class FieldKeyring {
  private readonly byVersion = new Map<number, Buffer>();

  constructor(
    private readonly current: FieldKey,
    previous?: FieldKey,
  ) {
    for (const k of [current, previous]) {
      if (!k) continue;
      if (!Number.isInteger(k.version) || k.version < 1 || k.version > 255) throw new Error('field key version must be 1..255');
      if (k.key.length !== 32) throw new Error('field key must be 32 bytes');
      if (this.byVersion.has(k.version)) throw new Error('field key versions must differ');
      this.byVersion.set(k.version, k.key);
    }
  }

  encrypt(plaintext: Buffer): Buffer {
    const version = Buffer.of(this.current.version);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(version);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([version, iv, cipher.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer): Buffer {
    if (blob.length < 1 + IV_LEN + TAG_LEN) throw new Error('encrypted field too short');
    const key = this.byVersion.get(blob[0]!);
    if (!key) throw new Error('encrypted field uses an unknown key version');
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 1 + IV_LEN));
    decipher.setAAD(blob.subarray(0, 1));
    decipher.setAuthTag(blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN));
    return Buffer.concat([decipher.update(blob.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]);
  }

  /** هل كُتب الحقل بمفتاح غير الحالي (مرشّح لإعادة التشفير عند التدوير)؟ */
  isStale(blob: Buffer): boolean {
    return blob[0] !== this.current.version;
  }
}

/** TOTP (RFC 6238): SHA-1، 6 أرقام، خطوة 30 ثانية. */
export function totp(secret: Buffer, timeMs: number, step = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / step)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, '0');
}

/** يقبل الرمز في الخطوة الحالية أو المجاورة لها (انحراف ساعة الهاتف). */
export function verifyTotp(secret: Buffer, code: string, nowMs = Date.now()): boolean {
  let ok = false;
  for (const drift of [-1, 0, 1]) {
    if (constantTimeEqual(totp(secret, nowMs + drift * 30_000), code)) ok = true;
  }
  return ok;
}
