/**
 * فاكّ CBOR (RFC 8949) بالقدر الذي يحتاجه App Attest: أعداد صحيحة، وسلاسل بايت ونص، ومصفوفات وخرائط محددة الطول.
 * ما عداها (الطول غير المحدد، الأعداد العشرية، الوسوم) يُرفض: المُدخل من جهاز لا نثق به، فلا تساهل في الصيغة.
 */
export type CborValue = number | Buffer | string | CborValue[] | Map<CborValue, CborValue> | boolean | null;

const MAX_DEPTH = 8;

export function decodeCbor(data: Buffer): CborValue {
  const [value, end] = item(data, 0, 0);
  if (end !== data.length) throw new Error('trailing bytes after CBOR item');
  return value;
}

function item(buf: Buffer, pos: number, depth: number): [CborValue, number] {
  if (depth > MAX_DEPTH) throw new Error('CBOR nesting too deep');
  if (pos >= buf.length) throw new Error('truncated CBOR');
  const head = buf[pos]!;
  const major = head >> 5;
  const [arg, next] = argument(buf, pos, head & 0x1f);
  switch (major) {
    case 0:
      return [arg, next];
    case 1:
      return [-1 - arg, next];
    case 2:
    case 3: {
      if (next + arg > buf.length) throw new Error('truncated CBOR string');
      const bytes = buf.subarray(next, next + arg);
      return [major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), next + arg];
    }
    case 4: {
      const out: CborValue[] = [];
      let p = next;
      for (let i = 0; i < arg; i++) {
        const [v, n] = item(buf, p, depth + 1);
        out.push(v);
        p = n;
      }
      return [out, p];
    }
    case 5: {
      const out = new Map<CborValue, CborValue>();
      let p = next;
      for (let i = 0; i < arg; i++) {
        const [k, n1] = item(buf, p, depth + 1);
        const [v, n2] = item(buf, n1, depth + 1);
        out.set(k, v);
        p = n2;
      }
      return [out, p];
    }
    case 7:
      if ((head & 0x1f) === 20) return [false, pos + 1];
      if ((head & 0x1f) === 21) return [true, pos + 1];
      if ((head & 0x1f) === 22) return [null, pos + 1];
      throw new Error('unsupported CBOR simple value');
    default:
      throw new Error('unsupported CBOR major type');
  }
}

function argument(buf: Buffer, pos: number, info: number): [number, number] {
  if (info < 24) return [info, pos + 1];
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (!size) throw new Error('unsupported CBOR length');
  if (pos + 1 + size > buf.length) throw new Error('truncated CBOR');
  const v = size === 1 ? buf.readUInt8(pos + 1) : size === 2 ? buf.readUInt16BE(pos + 1) : buf.readUInt32BE(pos + 1);
  return [v, pos + 1 + size];
}

/** قيمة مفتاح نصي في خريطة CBOR، أو undefined. */
export function cborGet(map: CborValue, key: string): CborValue | undefined {
  return map instanceof Map ? map.get(key) : undefined;
}
