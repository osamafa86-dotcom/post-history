// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a hex secret: what the server's own check computes.
import { createHmac } from "node:crypto";

export const TOTP_STEP_MS = 30_000;
export const totpStep = (nowMs = Date.now()) => Math.floor(nowMs / TOTP_STEP_MS);

export function totp(secretHex, nowMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(totpStep(nowMs)));
  const mac = createHmac("sha1", Buffer.from(secretHex, "hex")).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
