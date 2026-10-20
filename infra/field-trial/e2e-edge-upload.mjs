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

const mint = (sid) => { // رمز اختبار بالمفتاح المولَّد للتجربة المحلية؛ في الإنتاج يصدره الخادم بعد شهادة الجهاز
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${b64u(JSON.stringify({ aud: "ingest", sid, iat: now, exp: now + 600, jti: b64u(crypto.randomBytes(12)) }))}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: fs.readFileSync(env.INGEST_SIGNING_KEY), dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
};

const fail = (msg) => { console.error(`!! ${msg}`); process.exit(1); };

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
}
console.log("edge uploads: ok");
