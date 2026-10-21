#!/usr/bin/env node
// نافذة مفتاح الاختبار qa- عبر حافة التجربة (ADR 0022)، على مرحلتين حول infra/field-trial/qa-window.sh:
//   DATABASE_URL API_URL node e2e-qa-key.mjs seed > state.json      # حساب القبول (reporter_b) وجلسة له، وجلسة لمراسل آخر
//   QA_STATE INGEST_DOMAIN INGEST_IP CA_FILE INGEST_SIGNING_KEY QA_SIGNING_KEY QA_KID node e2e-qa-key.mjs check open|expired|closed
// open: رمز qa لجلسة حساب القبول يعبر البوابة، ولجلسة مراسل آخر 403 عند البوابة بينما رمز الإنتاج للجلسة نفسها يعبر
// (فالرفض من key_class لا من الجلسة). expired وclosed: رمز qa يُرفض 401 عند البوابة ورمز الإنتاج يعبر.
// العبور = الجواب من tusd (يضع Tus-Resumable دائمًا)، والطلب HEAD بلا أثر على الرفع.
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { seed } from "../../tools/acceptance/live/seed.mjs";

const env = process.env;
const [mode, phase] = process.argv.slice(2);
const fail = (msg) => { console.error(`!! ${msg}`); process.exit(1); };

if (mode === "seed") {
  const s = await seed({ databaseUrl: env.DATABASE_URL, apiUrl: env.API_URL });
  process.stdout.write(JSON.stringify({ acceptance_email: s.users.reporter_b.email, acceptance_session: s.uploads.sessionB,
    other_session: s.uploads.hookSessions.ok[0].id }));
  process.exit(0);
}
if (mode !== "check" || !["open", "expired", "closed"].includes(phase)) fail("usage: e2e-qa-key.mjs seed | check open|expired|closed");
for (const k of ["QA_STATE", "INGEST_DOMAIN", "INGEST_IP", "CA_FILE", "INGEST_SIGNING_KEY", "QA_SIGNING_KEY", "QA_KID"]) if (!env[k]) fail(`${k} is required`);

const state = JSON.parse(env.QA_STATE);
const ca = fs.readFileSync(env.CA_FILE);
const b64u = (b) => Buffer.from(b).toString("base64url");
const mint = (sid, kid, keyFile) => {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid }))}.${b64u(JSON.stringify({ aud: "ingest", sid, iat: now, exp: now + 600, jti: b64u(crypto.randomBytes(12)) }))}`;
  return `${input}.${b64u(crypto.sign("sha256", Buffer.from(input), { key: fs.readFileSync(keyFile), dsaEncoding: "ieee-p1363" }))}`;
};
const qa = (sid) => mint(sid, env.QA_KID, env.QA_SIGNING_KEY);
const prod = (sid) => mint(sid, env.INGEST_KID || "k1", env.INGEST_SIGNING_KEY);
const head = (sid, token) => new Promise((resolve, reject) => {
  const r = https.request({
    host: env.INGEST_DOMAIN, servername: env.INGEST_DOMAIN, port: 443, method: "HEAD", path: `/files/${sid}`, ca,
    headers: { "Tus-Resumable": "1.0.0", "Ingest-Token": token },
    lookup: (_h, opts, cb) => (opts.all ? cb(null, [{ address: env.INGEST_IP, family: 4 }]) : cb(null, env.INGEST_IP, 4)),
  }, (res) => { res.resume(); res.on("end", () => resolve(res.headers["tus-resumable"] ? "tus" : String(res.statusCode))); });
  r.on("error", reject);
  r.end();
});

const cases = phase === "open"
  ? [["a qa token for the acceptance account's session passes the gate", state.acceptance_session, qa, "tus"],
     ["a qa token for another reporter's session is refused at the gate", state.other_session, qa, "403"],
     ["a production token for that same session passes (the refusal is the key class)", state.other_session, prod, "tus"]]
  : [[`a qa token is refused at the gate once the window is ${phase}`, state.acceptance_session, qa, "401"],
     ["a production token still passes", state.acceptance_session, prod, "tus"]];
for (const [what, sid, tok, want] of cases) {
  const got = await head(sid, tok(sid));
  if (got !== want) fail(`${what}: got ${got === "tus" ? "through to tusd" : got}, want ${want === "tus" ? "through to tusd" : `${want} from the gate`}`);
  console.log(`${what}: ok`);
}
