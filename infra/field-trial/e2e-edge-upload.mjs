#!/usr/bin/env node
// رفع tus كامل عبر الوكيل الأمامي لبيئة التجربة (ADR 0013): النطاق الرئيسي (Caddy على MAIN_IP ← tusd-proxy)،
// ونطاق ingest (Caddy على INGEST_IP ← بوابة الرمز ← tusd-proxy، ADR 0011). لكل منهما: إنشاء 201 بـ Location
// على https والاسم نفسه، ثم PATCH للملف كله 204، ثم HEAD بالإزاحة الكاملة. الجلسات من seed (tools/acceptance).
//   DATABASE_URL API_URL MAIN_DOMAIN MAIN_IP INGEST_DOMAIN INGEST_IP CA_FILE INGEST_SIGNING_KEY node e2e-edge-upload.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { seed } from "../../tools/acceptance/live/seed.mjs";

const env = process.env;
for (const k of ["DATABASE_URL", "API_URL", "MAIN_DOMAIN", "MAIN_IP", "INGEST_DOMAIN", "INGEST_IP", "CA_FILE", "INGEST_SIGNING_KEY"]) {
  if (!env[k]) { console.error(`${k} is required`); process.exit(2); }
}
const ca = fs.readFileSync(env.CA_FILE);
const b64u = (b) => Buffer.from(b).toString("base64url");

// يصل إلى الاسم عبر العنوان المعطى (SNI وHost بالاسم)، كما يفعل الجهاز بعد حل DNS.
const call = (name, ip, method, path, headers, body) => new Promise((resolve, reject) => {
  const r = https.request({
    host: name, servername: name, port: 443, method, path, headers, ca,
    lookup: (_h, opts, cb) => (opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
  }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers })); });
  r.on("error", reject);
  r.end(body);
});

const signingKey = fs.readFileSync(env.INGEST_SIGNING_KEY);
// رمز اختبار بالمفتاح المولَّد للتجربة المحلية؛ في الإنتاج يصدره الخادم بعد شهادة الجهاز. opts للرموز المرفوضة عمدًا.
const mint = (sid, { kid = env.INGEST_KID || "k1", key = signingKey, iatOffset = 0 } = {}) => {
  const now = Math.floor(Date.now() / 1000) + iatOffset;
  const input = `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid }))}.${b64u(JSON.stringify({ aud: "ingest", sid, iat: now, exp: now + 600, jti: b64u(crypto.randomBytes(12)) }))}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
};

const fail = (msg) => { console.error(`!! ${msg}`); process.exit(1); };

let ingestPath = null;
const s = await seed({ databaseUrl: env.DATABASE_URL, apiUrl: env.API_URL });
const [viaMain, viaIngest] = s.uploads.hookSessions.ok;
for (const [label, name, ip, session, extra] of [
  ["main", env.MAIN_DOMAIN, env.MAIN_IP, viaMain, {}],
  ["ingest", env.INGEST_DOMAIN, env.INGEST_IP, viaIngest, { "Ingest-Token": mint(viaIngest.id) }],
]) {
  const tus = { "Tus-Resumable": "1.0.0", Authorization: `Bearer ${session.token}`, ...extra };
  const body = Buffer.alloc(session.size, 0x5a); // the stand-in file seed declared (client_sha256)
  const c = await call(name, ip, "POST", "/files/", { ...tus, "Upload-Length": String(session.size),
    "Upload-Metadata": `upload_session_id ${Buffer.from(session.id).toString("base64")},filename ${Buffer.from("clip.mp4").toString("base64")}` });
  if (c.status !== 201) fail(`${label}: create ${c.status}`);
  const loc = new URL(c.headers.location);
  if (loc.protocol !== "https:" || loc.hostname !== name) fail(`${label}: Location ${c.headers.location}`);
  const p = await call(name, ip, "PATCH", loc.pathname, { ...tus, "Upload-Offset": "0",
    "Content-Type": "application/offset+octet-stream", "Content-Length": String(body.length) }, body);
  if (p.status !== 204 || Number(p.headers["upload-offset"]) !== session.size) fail(`${label}: patch ${p.status}`);
  const h = await call(name, ip, "HEAD", loc.pathname, tus);
  if (h.status !== 200 || Number(h.headers["upload-offset"]) !== session.size) fail(`${label}: head ${h.status}`);
  console.log(`${label}: upload complete through the edge (${session.size} bytes, Location ${loc.protocol}//${loc.hostname})`);
  if (label === "ingest") ingestPath = loc.pathname;
}
console.log("edge uploads: ok");

// ingest مطلوب افتراضيًا في التجربة: الخادم يعلن نطاق ingest لجلسة tus جديدة.
const apiGet = async (path, token) => {
  const r = await fetch(`${env.API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};
const adv = await apiGet(`/uploads/${viaIngest.id}`, s.allTokens.reporter);
if (adv.status !== 200) fail(`GET /uploads/{id}: ${adv.status}`);
if (adv.body.ingest_token_required !== true || adv.body.tus_endpoint !== `https://${env.INGEST_DOMAIN}/files/`) {
  fail(`ingest not required by default (ingest_token_required=${adv.body.ingest_token_required}, tus_endpoint host ${new URL(adv.body.tus_endpoint).hostname})`);
}
console.log("the API requires ingest for new tus sessions: ok");

// PATCH على الرفع نفسه برموز مرفوضة يتوقف عند البوابة ولا يصل إلى tusd: رمز موقّع بمفتاح أُبطل (kid أُزيل من
// INGEST_TOKEN_PUBLIC_KEYS)، ورمز بمفتاح غريب تحت kid المعتمد، ورمز منتهٍ، ورمز صالح لجلسة أخرى. الإزاحة لا تتغير.
const { privateKey: otherKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = s.uploads.hookSessions.ok[2];
const tusOf = (tok) => ({ "Tus-Resumable": "1.0.0", Authorization: `Bearer ${viaIngest.token}`, "Ingest-Token": tok });
const patchWith = (tok) => call(env.INGEST_DOMAIN, env.INGEST_IP, "PATCH", ingestPath, { ...tusOf(tok), "Upload-Offset": String(viaIngest.size),
  "Content-Type": "application/offset+octet-stream", "Content-Length": "1" }, Buffer.from("x"));
for (const [what, tok, want] of [
  ["a key that was revoked (kid no longer in the gate's keys)", mint(viaIngest.id, { kid: "k0-revoked", key: otherKey }), 401],
  ["a foreign key under the trusted kid", mint(viaIngest.id, { key: otherKey }), 401],
  ["an expired token", mint(viaIngest.id, { iatOffset: -1300 }), 401],
  ["a valid token for another session", mint(other.id), 403],
]) {
  const r = await patchWith(tok);
  if (r.status !== want) fail(`PATCH with ${what}: ${r.status} (want ${want} from the gate)`);
}
const after = await call(env.INGEST_DOMAIN, env.INGEST_IP, "HEAD", ingestPath, tusOf(mint(viaIngest.id)));
if (after.status !== 200 || Number(after.headers["upload-offset"]) !== viaIngest.size) fail(`offset changed after refused PATCHes: ${after.status} ${after.headers["upload-offset"]}`);
console.log("PATCH with a revoked, foreign, expired or other-session token is refused at the gate: ok");
