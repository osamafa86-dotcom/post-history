import test from "node:test";
import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import { run, base32ToHex, leaked } from "../scripts/account-recovery.mjs";
import { SoftAuthenticator } from "../lib/webauthn-soft.mjs";
import { byName } from "../lib/catalog.mjs";

const quiet = async (fn) => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

test("account-recovery is in the catalog beside the SEC tests, and without its environment measures nothing", async () => {
  assert.equal(byName("account-recovery")?.source, "ADR 0107");
  const { code, doc } = await quiet(() => run(["--dry-run"], {}));
  assert.equal(code, 2);
  assert.equal(doc, null);
});

test("base32ToHex reads the TOTP secret the server enrols (RFC 4648, no padding)", () => {
  // RFC 6238's test secret, encoded here as the server encodes it (common/crypto.ts base32Encode)
  const bytes = Buffer.from("12345678901234567890");
  const alphabet = String.fromCharCode(...Array.from({ length: 26 }, (_, i) => 65 + i)) + "234567";
  let bits = 0, value = 0, encoded = "";
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { encoded += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) encoded += alphabet[(value << (5 - bits)) & 31];
  assert.equal(base32ToHex(encoded), bytes.toString("hex"));
  assert.throws(() => base32ToHex("not base32!"));
});

test("leaked counts the secrets present in a text and ignores short or missing ones", () => {
  assert.equal(leaked("a log line with SECRETVALUE1 inside", ["SECRETVALUE1", "OTHERSECRET2", "short", undefined]), 1);
  assert.equal(leaked("nothing here", ["SECRETVALUE1"]), 0);
});

test("the software authenticator's assertion verifies with its public key over authenticator data and the client data digest", () => {
  const device = new SoftAuthenticator("http://localhost:3000");
  const { credential, json } = device.create({ challenge: "Y2hhbGxlbmdl", user: { id: "dXNlcg" }, rp: { id: "localhost" } });
  assert.equal(json.id, credential.id.toString("base64url"));
  const clientData = JSON.parse(Buffer.from(json.response.clientDataJSON, "base64url"));
  assert.deepEqual([clientData.type, clientData.challenge, clientData.origin], ["webauthn.create", "Y2hhbGxlbmdl", "http://localhost:3000"]);
  const assertion = device.get(credential, { challenge: "c2Vjb25k" });
  const authData = Buffer.from(assertion.response.authenticatorData, "base64url");
  assert.deepEqual(authData.subarray(0, 32), createHash("sha256").update("localhost").digest());
  assert.equal(authData[32] & 0x05, 0x05, "user present and verified");
  const digest = createHash("sha256").update(Buffer.from(assertion.response.clientDataJSON, "base64url")).digest();
  assert.ok(verify("sha256", Buffer.concat([authData, digest]), credential.publicKey, Buffer.from(assertion.response.signature, "base64url")));
  assert.equal(assertion.response.userHandle, "dXNlcg");
});
