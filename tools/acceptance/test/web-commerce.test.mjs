import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABELS, StepError, safeFailure, amountDigits, licenseNumberIn, allowedOrigins, originAllowed, remainingIn, totp } from "../scripts/web-commerce-helpers.mjs";
import { sameInviteShape, shapeDiff, run as inviteRun } from "../scripts/web-invite-conflict.mjs";
import { run as checkoutRun } from "../scripts/web-buyer-checkout.mjs";
import { validateMeasurement, ROOT } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";

const strings = (locale) => {
  const out = [];
  const walk = (v) => { if (typeof v === "string") out.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(JSON.parse(readFileSync(join(ROOT, "apps/web/messages", `${locale}.json`), "utf8")));
  return out;
};

test("every label the browser script looks for is a string the web app really has, in both languages", () => {
  for (const locale of ["ar", "en"]) {
    const all = strings(locale);
    for (const [name, pattern] of Object.entries(LABELS)) {
      assert.ok(all.some((s) => pattern.test(s)), `${locale}: no message matches LABELS.${name}`);
    }
  }
});

test("a step failure carries the step's label and the error class only, never its message", () => {
  const raw = new Error("page.goto: https://pay.example/checkout/abc failed with Bearer eyJhbGciOi");
  raw.name = "TimeoutError";
  const text = safeFailure(new StepError("login", raw));
  assert.equal(text, "login: TimeoutError");
  const other = safeFailure(raw);
  assert.equal(other, "unexpected failure: TimeoutError");
  for (const t of [text, other]) assert.doesNotMatch(t, /https?:|Bearer|example/);
});

test("amounts compare by digits across formats; licence numbers and remaining counts are read in both digit systems", () => {
  assert.equal(amountDigits("‏100.01 US$"), amountDigits("100.01 USD"));
  assert.notEqual(amountDigits("100.01 USD"), amountDigits("100.02 USD"));
  assert.equal(licenseNumberIn("الرقم PH-2026-DJHACWS5CP ساري"), "PH-2026-DJHACWS5CP");
  assert.equal(licenseNumberIn("PH-2026-0000"), null);
  assert.equal(remainingIn("بقي ٤ من مرات التنزيل."), 4);
  assert.equal(remainingIn("4 downloads left."), 4);
  assert.equal(remainingIn("none"), null);
});

test("the payment origin is judged against the declared list and an invalid URL is refused", () => {
  const allowed = allowedOrigins("http://127.0.0.1:3000, https://sandbox.example ,not a url");
  assert.deepEqual(allowed, ["http://127.0.0.1:3000", "https://sandbox.example"]);
  assert.equal(originAllowed("https://sandbox.example/sandbox/checkout/x", allowed), true);
  assert.equal(originAllowed("https://evil.example/", allowed), false);
  assert.equal(originAllowed("nonsense", allowed), false);
});

test("the one-time code follows RFC 6238", () => {
  // SHA-1 vector: secret "12345678901234567890", t = 59 s -> 94287082 (8 digits), so 287082 in six
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000), "287082");
});

test("two invite answers have the same shape when only identifying and time fields differ", () => {
  const a = { status: 201, body: { id: "1", email: "a@x", status: "invited", role: "editor", invite_token: "t1", invite_expires_at: "2026-11-01" } };
  const b = { status: 201, body: { id: "2", email: "b@x", status: "invited", role: "editor", invite_token: "t2", invite_expires_at: "2026-11-02" } };
  assert.equal(sameInviteShape(a, b), true);
  assert.equal(sameInviteShape(a, { ...b, status: 409 }), false);
  const c = { status: 201, body: { ...b.body, role: "admin" } };
  assert.equal(sameInviteShape(a, c), false);
  assert.ok(shapeDiff(a, c).values_differ.includes("role"));
  const d = { status: 201, body: { ...b.body, extra: 1 } };
  assert.deepEqual(shapeDiff(a, d).only_fresh, ["extra"]);
});

test("both scripts exit 2 with nothing written when their environment is missing", async () => {
  const quiet = console.error; console.error = () => {};
  try {
    assert.equal((await checkoutRun(["--dry-run"], {})).code, 2);
    assert.equal((await inviteRun(["--dry-run"], {})).code, 2);
  } finally { console.error = quiet; }
});

test("the catalog names both scripts and a result they would write passes measurement.json", () => {
  for (const name of ["web-buyer-checkout", "web-invite-conflict"]) {
    assert.ok(byName(name), `${name} is in the catalog`);
  }
  const dir = join(ROOT, "docs/measurements/acceptance");
  const files = readdirSync(dir).filter((f) => /web-(buyer-checkout|invite-conflict)-browser/.test(f));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    assert.deepEqual(validateMeasurement(doc).errors, [], f);
    assert.equal(doc.result, "partial");
    const text = JSON.stringify(doc);
    assert.doesNotMatch(text, /https?:\/\/|Bearer|eyJ[A-Za-z0-9_-]{10,}|127\.0\.0\.1/, `${f} carries no origin, URL or credential`);
  }
});
