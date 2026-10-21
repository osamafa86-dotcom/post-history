// حسابات المعاينة التجريبية ومواد اصطناعية (ADR 0023)، داخل حاوية الخادم (pg وargon2 من اعتماديته):
//   seed-preview.sh يمرر {"supervisor":{email,password},"editor":{…},"reporter":{…}} على stdin
// مشرف لمكتب تجريبي، ورئيس تحرير، ومراسل في المكتب، وثلاث مواد اصطناعية بلا إحداثيات من المراسل عبر الخادم نفسه.
// لا مدير نظام. متكرر بأمان: الحساب الموجود تُحدَّث كلمة سره، والمواد لا تتكرر. لا يطبع كلمة سر ولا رمزًا.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { hash } from "@node-rs/argon2";

const input = JSON.parse(await new Promise((res) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s)); }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const q = (text, params) => pool.query(text, params);
const API = "http://127.0.0.1:3000/v1";

const office = (await q(`SELECT id FROM offices WHERE name_en = 'Preview office' LIMIT 1`)).rows[0]?.id
  ?? (await q(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('مكتب تجريبي', 'Preview office', 'gaza') RETURNING id`)).rows[0].id;

const account = async ({ email, password }, role, scope) => {
  const { rows } = await q(
    `INSERT INTO users (email, password_hash, status, office_id) VALUES ($1, $2, 'active', $3)
     ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active' RETURNING id`,
    [email, await hash(password), role === "reporter" ? office : null]);
  await q(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [rows[0].id, role, scope ? "office" : "all", scope ? office : ""]);
  return rows[0].id;
};
await account(input.supervisor, "supervisor", true);
await account(input.editor, "editor_in_chief", false);
const reporter = await account(input.reporter, "reporter", false);

let form = (await q(`SELECT max(version) AS v FROM upload_forms`)).rows[0].v;
if (!form) { form = 1; await q(`INSERT INTO upload_forms (version, schema) VALUES (1, $1)`, [{ version: 1, fields: [] }]); }

const have = Number((await q(`SELECT count(*) FROM materials WHERE reporter_id = $1`, [reporter])).rows[0].count);
if (have < 3) {
  const login = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: input.reporter.email, password: input.reporter.password }) });
  if (login.status !== 200) throw new Error(`reporter login failed (${login.status})`);
  const { access_token: token } = await login.json();
  for (let i = have + 1; i <= 3; i++) {
    const r = await fetch(`${API}/materials`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ title: `مادة تجريبية ${i} (معاينة)`, material_types: ["report"], governorate: "gaza", city: "مدينة تجريبية",
        priority: i === 1 ? "urgent" : "normal", sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: "network" }, form_version: form, dynamic_fields: {} }) });
    if (r.status >= 300) throw new Error(`material ${i}: ${r.status}`);
  }
}
await pool.end();
console.log("preview accounts (supervisor, editor_in_chief, reporter) and 3 synthetic materials ready");
