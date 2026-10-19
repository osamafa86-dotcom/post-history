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

// صيغة الحقل المشفر (مثل users.totp_secret_enc): iv (12) || tag (16) || ciphertext، AES-256-GCM.
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptField(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptField(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('encrypted field too short');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_LEN));
  decipher.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(blob.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
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
