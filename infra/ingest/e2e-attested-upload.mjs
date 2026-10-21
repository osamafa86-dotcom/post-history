#!/usr/bin/env node
// الخادم وبوابة ingest معًا (ADR 0011، SEC-07 البند 5): الخادم في ATTESTATION_MODE=test يتحقق من حكم Play Integrity
// غير موقّع ويصدر رمز ingest بمفتاحه وkid، والبوابة تتحقق منه بالمفتاح العام وحده. يجريه infra/ingest/e2e-attested.sh.
//   1) تحدٍّ ← جلسة رفع (ingest_token_required، tus_endpoint على ingest) ← رمز ingest (kid الخادم) ← رفع tus كامل عبر البوابة
//   2) الرمز نفسه لجلسة أخرى ← 403 من البوابة؛ التحدي المستهلك ← 410 من الخادم
// البيئة: DATABASE_URL API_URL INGEST_URL INGEST_CA PLAY_PACKAGE PLAY_CERT EXPECT_KID
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { seed } from "../../tools/acceptance/live/seed.mjs";

const env = process.env;
for (const k of ["DATABASE_URL", "API_URL", "INGEST_URL", "INGEST_CA", "PLAY_PACKAGE", "PLAY_CERT", "EXPECT_KID"]) {
  if (!env[k]) { console.error(`${k} is required`); process.exit(2); }
}
const fail = (msg) => { console.error(`!! ${msg}`); process.exit(1); };
const b64u = (b) => Buffer.from(b).toString("base64url");
const ingest = new URL(env.INGEST_URL);
const ca = fs.readFileSync(env.INGEST_CA);

const api = async (token, method, path, body) => {
  const r = await fetch(`${env.API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// tus إلى البوابة بالاسم (SNI) على 127.0.0.1، والشهادة من سلطة الاختبار.
const tus = (method, path, headers, body) => new Promise((resolve, reject) => {
  const r = https.request({
    host: ingest.hostname, servername: ingest.hostname, port: ingest.port, method, path, headers, ca,
    lookup: (_h, o, cb) => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)),
  }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers })); });
  r.on("error", reject);
  r.end(body);
});

// حكم Play Integrity غير موقّع بشكل وضع test في الخادم، مربوط بالتحدي والجلسة (requestHash).
const verdict = (challenge, sessionId) => b64u(JSON.stringify({
  requestDetails: {
    requestPackageName: env.PLAY_PACKAGE, timestampMillis: String(Date.now()),
    requestHash: b64u(crypto.createHash("sha256").update(Buffer.concat([Buffer.from(challenge, "base64url"), Buffer.from(sessionId)])).digest()),
  },
  appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: env.PLAY_PACKAGE, certificateSha256Digest: [env.PLAY_CERT] },
  deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
}));

const s = await seed({ databaseUrl: env.DATABASE_URL, apiUrl: env.API_URL });
const reporter = s.tokens.reporter;
const material = s.fixtures.own_material_id;
const newSession = async () => {
  const size = 4096;
  const sha = crypto.createHash("sha256").update(Buffer.alloc(size, 0x5a)).digest("hex");
  const r = await api(reporter, "POST", "/uploads", { material_id: material, kind: "original", size_bytes: size, filename: "clip.mp4", client_sha256: sha });
  if (r.status !== 201 && r.status !== 200) fail(`POST /uploads ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body, size };
};

const session = await newSession();
if (session.ingest_token_required !== true) fail("session does not require an ingest token (INGEST_REQUIRED)");
if (new URL(session.tus_endpoint).hostname !== ingest.hostname) fail(`tus_endpoint is not the ingest domain: ${session.tus_endpoint}`);

const ch = await api(reporter, "POST", "/device-attestations/challenge");
if (ch.status !== 200 && ch.status !== 201) fail(`challenge ${ch.status} ${JSON.stringify(ch.body)}`);
const issued = await api(reporter, "POST", `/uploads/${session.id}/ingest-token`,
  { platform: "android", integrity_token: verdict(ch.body.challenge, session.id), challenge_id: ch.body.challenge_id });
if (issued.status !== 200) fail(`ingest-token ${issued.status} ${JSON.stringify(issued.body)}`);
const token = issued.body.token;
const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
if (header.kid !== env.EXPECT_KID) fail(`token kid ${header.kid}, expected ${env.EXPECT_KID}`);
console.log(`server issued an ingest token (kid ${header.kid}) after the test-mode Play Integrity verdict`);

const replay = await api(reporter, "POST", `/uploads/${session.id}/ingest-token`,
  { platform: "android", integrity_token: verdict(ch.body.challenge, session.id), challenge_id: ch.body.challenge_id });
if (replay.status !== 410) fail(`a consumed challenge should be 410, got ${replay.status}`);

const h = { "Tus-Resumable": "1.0.0", Authorization: `Bearer ${session.upload_token}`, "Ingest-Token": token };
const body = Buffer.alloc(session.size, 0x5a);
const c = await tus("POST", ingest.pathname, { ...h, "Upload-Length": String(session.size),
  "Upload-Metadata": `upload_session_id ${Buffer.from(session.id).toString("base64")},filename ${Buffer.from("clip.mp4").toString("base64")}` });
if (c.status !== 201) fail(`create through the gate ${c.status}`);
const loc = new URL(c.headers.location);
const p = await tus("PATCH", loc.pathname, { ...h, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream", "Content-Length": String(body.length) }, body);
if (p.status !== 204 || Number(p.headers["upload-offset"]) !== session.size) fail(`patch through the gate ${p.status}`);
const hd = await tus("HEAD", loc.pathname, h);
if (hd.status !== 200 || Number(hd.headers["upload-offset"]) !== session.size) fail(`head through the gate ${hd.status}`);
console.log(`upload complete through the gate with the server's token (${session.size} bytes)`);

const other = await newSession();
const x = await tus("POST", ingest.pathname, { "Tus-Resumable": "1.0.0", Authorization: `Bearer ${other.upload_token}`, "Ingest-Token": token,
  "Upload-Length": String(other.size), "Upload-Metadata": `upload_session_id ${Buffer.from(other.id).toString("base64")}` });
if (x.status !== 403 || x.headers["tus-resumable"]) fail(`a token for another session should be 403 at the gate, got ${x.status}`);
console.log("server + gate: ok");
