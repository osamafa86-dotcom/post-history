// The ingest gate's side of an upload (ADR 0011): a short ES256 token in `Ingest-Token`, next to the upload token in `Authorization`.
// A real device gets it from POST /uploads/{id}/ingest-token after its attestation; a script that holds the gate's test signing key (a stack we
// control: CI, a local compose) signs one itself, exactly as infra/field-trial/e2e-edge-upload.mjs does. A host's own key is never given to a script.
//   INGEST_SIGNING_KEY  path of the PEM private key   INGEST_KID  key id the gate trusts (k1)
//   ACCEPTANCE_RESOLVE  "name=ip,name=ip": reach a name at an address (SNI and Host keep the name), as a device does after DNS; for the two-address edge
import { createSign, randomBytes, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

const b64u = (b) => Buffer.from(b).toString("base64url");
const keys = new Map();

/** A token valid ten minutes for upload session `sid`; null when no signing key is configured. */
export function mintIngestToken(sid, env = process.env, nowMs = Date.now()) {
  const path = env.INGEST_SIGNING_KEY;
  if (!path) return null;
  if (!keys.has(path)) keys.set(path, createPrivateKey(readFileSync(path)));
  const now = Math.floor(nowMs / 1000);
  const input = `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: env.INGEST_KID || "k1" }))}.${b64u(JSON.stringify({ aud: "ingest", sid, iat: now, exp: now + 600, jti: b64u(randomBytes(12)), plat: "android" }))}`;
  const sig = createSign("sha256").update(input).sign({ key: keys.get(path), dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
}

/** Headers of one tus request for an upload session: the upload token, plus a fresh ingest token when a key is configured. */
export function tusAuth(session, env = process.env) {
  const ingest = mintIngestToken(session.id, env);
  return { Authorization: `Bearer ${session.token}`, ...(ingest ? { "Ingest-Token": ingest } : {}) };
}

/** A `lookup` for http(s).Agent from ACCEPTANCE_RESOLVE, or undefined. */
export function resolveLookup(env = process.env) {
  const map = new Map((env.ACCEPTANCE_RESOLVE ?? "").split(",").map((p) => p.trim().split("=")).filter((p) => p.length === 2 && p[0] && p[1]));
  if (!map.size) return undefined;
  return (host, opts, cb) => {
    const ip = map.get(host);
    if (!ip) return import("node:dns").then((d) => d.lookup(host, opts, cb));
    return opts?.all ? cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]) : cb(null, ip, ip.includes(":") ? 6 : 4);
  };
}
