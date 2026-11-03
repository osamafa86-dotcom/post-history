// A software WebAuthn authenticator for the live acceptance runs (ADR 0107): an ES256 (P-256) key on the "device", "none" attestation,
// and the JSON a browser's PublicKeyCredential.toJSON() returns. It signs what a real authenticator signs (authenticator data followed by
// the SHA-256 of the client data), DER-encoded. No browser, no platform authenticator: a result that uses it is partial by construction.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  constructor(origin) {
    this.origin = origin;
    this.rpId = new URL(origin).hostname;
  }

  /** navigator.credentials.create() then toJSON(): the response to send, and the credential kept on the "device". */
  create(options, { multiDevice = true } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const credential = { id: randomBytes(32), privateKey, publicKey, userHandle: options.user.id, counter: 0, multiDevice };
    const jwk = publicKey.export({ format: "jwk" });
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const attested = Buffer.concat([Buffer.alloc(16), u16(credential.id.length), credential.id, cose]);
    const authData = Buffer.concat([sha256(options.rp?.id ?? this.rpId), Buffer.of(flags(multiDevice, true)), u32(0), attested]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      credential,
      json: {
        id: b64u(credential.id), rawId: b64u(credential.id), type: "public-key",
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
        clientExtensionResults: {}, authenticatorAttachment: "platform",
      },
    };
  }

  /** navigator.credentials.get() then toJSON() with a kept credential. A synced credential keeps its counter at zero, as sync does. */
  get(credential, options) {
    if (!credential.multiDevice) credential.counter += 1;
    const authData = Buffer.concat([sha256(options.rpId ?? this.rpId), Buffer.of(flags(credential.multiDevice, false)), u32(credential.counter)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), credential.privateKey);
    return {
      id: b64u(credential.id), rawId: b64u(credential.id), type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: credential.userHandle },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }
}

// UP 0x01, UV 0x04, BE+BS 0x18 for a synced credential, AT 0x40 with attested credential data
const flags = (multiDevice, attested) => 0x01 | 0x04 | (multiDevice ? 0x18 : 0) | (attested ? 0x40 : 0);

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

/** A small CBOR encoder: integers (negative too), text, bytes and maps. */
export function cbor(value) {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") { const b = Buffer.from(value, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("unsupported CBOR value");
}

function head(major, n) {
  if (n < 24) return Buffer.of((major << 5) | n);
  if (n < 0x100) return Buffer.of((major << 5) | 24, n);
  if (n < 0x10000) return Buffer.concat([Buffer.of((major << 5) | 25), u16(n)]);
  return Buffer.concat([Buffer.of((major << 5) | 26), u32(n)]);
}
