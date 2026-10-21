import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { hashSliceBytes } from "./upload-policy";

/**
 * SHA-256 للملف كاملًا بالتدفق: شرائح ثابتة تُقرأ واحدة واحدة، فلا يُحمَّل الملف في الذاكرة.
 * Web Crypto لا يعرض بصمة تزايدية (digest على مخزن واحد فقط)، فالتنفيذ من @noble/hashes ويعمل في Worker.
 */
export async function streamSha256(blob: Blob, progress?: (bytes: number) => void, aborted?: () => boolean, slice = hashSliceBytes): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += slice) {
    if (aborted?.()) throw new DOMException("Aborted", "AbortError");
    hash.update(new Uint8Array(await blob.slice(offset, offset + slice).arrayBuffer()));
    progress?.(Math.min(offset + slice, blob.size));
  }
  return bytesToHex(hash.digest());
}
