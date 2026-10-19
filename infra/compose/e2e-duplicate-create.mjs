#!/usr/bin/env node
// e2e على compose (SEC-06): إنشاءان متزامنان لرفع tus بالرمز الصالح نفسه للجلسة نفسها ← 201 واحد فقط.
// tusd لا يرفض معرّفًا مكرّرًا ثبّته الخطّاف، فالتفرّد مسؤولية حجز الخادم الذري في pre-create.
// يحتاج compose مع الخادم (--profile api) وقاعدة مُرحَّلة، وتبعيات tools/acceptance (npm ci):
//   DATABASE_URL=postgres://… API_URL=http://127.0.0.1:3000/v1 TUS_URL=http://127.0.0.1:8080/files/ \
//     node infra/compose/e2e-duplicate-create.mjs
import { seed } from "../../tools/acceptance/live/seed.mjs";

const { DATABASE_URL, API_URL, TUS_URL } = process.env;
const CONCURRENT = Number(process.env.E2E_CONCURRENT ?? 5);
if (!DATABASE_URL || !API_URL || !TUS_URL) {
  console.error("DATABASE_URL, API_URL and TUS_URL are required");
  process.exit(2);
}

const b64 = (s) => Buffer.from(s).toString("base64");
const create = (session) =>
  fetch(TUS_URL, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(session.size),
      "Upload-Metadata": `upload_session_id ${b64(session.id)},filename ${b64("e2e.bin")}`,
      Authorization: `Bearer ${session.token}`,
    },
  }).then((r) => r.status, () => 0);

const fail = (msg) => {
  console.error(`!! ${msg}`);
  process.exit(1);
};

const s = await seed({ databaseUrl: DATABASE_URL, apiUrl: API_URL });
const [raced, sequential] = s.uploads.hookSessions.ok;

// 1) N creates fired together with the same valid token: exactly one is created.
const codes = await Promise.all(Array.from({ length: CONCURRENT }, () => create(raced)));
const created = codes.filter((c) => c === 201).length;
console.log(`concurrent creates (${CONCURRENT}): ${codes.join(",")}`);
if (created !== 1) fail(`expected exactly one 201 among concurrent creates, got ${created}`);
if (codes.some((c) => c !== 201 && (c < 400 || c >= 500))) fail(`the losers must be rejected with 4xx (not 5xx/timeout): ${codes}`);

// 2) After a create, the same token is spent: a later create is rejected.
const first = await create(sequential);
const second = await create(sequential);
console.log(`sequential creates: ${first},${second}`);
if (first !== 201 || second < 400 || second >= 500) fail(`expected 201 then 4xx, got ${first} then ${second}`);

console.log("e2e duplicate create: ok");
process.exit(0);
