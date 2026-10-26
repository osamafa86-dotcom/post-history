// Pure helpers of the two commerce browser scripts (web-buyer-checkout, web-invite-conflict). Kept apart so they are unit-tested.
// Two rules of the security review hold for every result these scripts write: no payment page origin or URL, and no raw `error.message`.

/** A failure of one named step. Only the step label and the error's class go into a result; Playwright messages carry page text and call logs. */
export class StepError extends Error {
  constructor(label, cause) {
    super(`${label}: ${String(cause?.name ?? "Error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error"}`);
    this.name = "StepError";
    this.safe = true;
  }
}

/** The text a result may carry for a thrown value: our own StepError as is, anything else by class only. */
export function safeFailure(error) {
  if (error?.safe) return error.message;
  return `unexpected failure: ${String(error?.name ?? "Error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error"}`;
}

export async function step(label, fn) {
  try { return await fn(); } catch (error) { throw error?.safe ? error : new StepError(label, error); }
}

/** "‏100.01 US$" or "100.01 USD" -> "10001": the digits of an amount, comparable across how each page formats it. */
export function amountDigits(text) {
  const m = /([0-9٠-٩]+(?:[.,٫][0-9٠-٩]{1,2})?)/.exec(String(text ?? ""));
  if (!m) return null;
  const latin = m[1].replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,٫]/g, ".");
  const [whole, frac = ""] = latin.split(".");
  return `${whole}${frac.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
}

export const LICENSE_NUMBER = /PH-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{10}/;
export function licenseNumberIn(text) { return LICENSE_NUMBER.exec(String(text ?? ""))?.[0] ?? null; }

/** The origins of WEB_CHECKOUT_ORIGINS as a list; an entry that is not a URL is ignored. */
export function allowedOrigins(value) {
  return String(value ?? "").split(",").map((v) => v.trim()).filter(Boolean).flatMap((v) => { try { return [new URL(v).origin]; } catch { return []; } });
}
export function originAllowed(url, allowed) { try { return allowed.includes(new URL(url).origin); } catch { return false; } }

/** The page's own labels: each pattern must match the text the web app really shows (a unit test compares them with apps/web/messages). */
export const LABELS = {
  addToCart: /^(أضف إلى السلة|Add to cart)$/,
  goToCart: /^(في السلة، انتقل إليها|In your cart; go to it)$/,
  placeOrder: /^(إنشاء الطلب|Create order)$/,
  paySandbox: /^(الدفع لدى المزوّد التجريبي|Pay at the sandbox provider)$/,
  orderPaid: /^(مدفوع|Paid)$/,
  orderPending: /^(بانتظار الدفع|Awaiting payment)$/,
  licenseActive: /^(ساري|Active)$/,
  openCertificate: /^(الشهادة|Certificate)$/,
  download: /^(تنزيل حزمة التسليم|Download delivery package)$/,
};

/** Remaining downloads from "بقي 4 من مرات التنزيل." or "4 downloads left.": a number or null. */
export function remainingIn(text) {
  const m = /([0-9٠-٩]+)/.exec(String(text ?? ""));
  return m ? Number(m[1].replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))) : null;
}

/** RFC 6238 SHA-1, 6 digits, 30 s: for the administrator's code (the secret is base32 as in an otpauth link). */
import { createHmac } from "node:crypto";
export function totp(secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of String(secret).replace(/[\s=]+/g, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error("invalid TOTP secret");
    bits += v.toString(2).padStart(5, "0");
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const d = createHmac("sha1", key).update(msg).digest();
  const o = d[d.length - 1] & 15;
  return String(((d.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}
