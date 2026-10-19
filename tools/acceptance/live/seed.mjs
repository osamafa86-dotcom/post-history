// Seeds a throwaway database for the live acceptance runs: offices, one user per role (plus a second
// reporter and supervisor in another office), a published form, materials carrying canary values, and
// the fixtures the scope cases need. Everything is synthetic and random per run.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { hash } from "@node-rs/argon2";

const ROLES = ["system_admin", "editor_in_chief", "supervisor", "producer", "finance", "reporter", "rights_officer"];
const sha256 = (s) => createHash("sha256").update(s).digest();

export async function seed({ databaseUrl, apiUrl }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const q = (text, params) => pool.query(text, params);
  const password = randomBytes(12).toString("base64url");
  const passwordHash = await hash(password);

  const office = async (gov) => (await q(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'office', $1) RETURNING id`, [gov])).rows[0].id;
  const officeA = await office("gaza");
  const officeB = await office("khan_younis");

  const user = async (label, role, { officeId = null, scopeKind = "all", scopeId = "" } = {}) => {
    const email = `${label}-${randomUUID()}@example.test`;
    const { rows } = await q(`INSERT INTO users (email, password_hash, status, office_id) VALUES ($1, $2, 'active', $3) RETURNING id`, [email, passwordHash, officeId]);
    await q(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, $2, $3, $4)`, [rows[0].id, role, scopeKind, scopeId]);
    return { id: rows[0].id, email };
  };
  const users = {};
  for (const role of ROLES) {
    users[role] = await user(role, role, role === "reporter" ? { officeId: officeA } : role === "supervisor" ? { scopeKind: "office", scopeId: officeA } : {});
  }
  users.reporter_b = await user("reporter-b", "reporter", { officeId: officeB });
  users.supervisor_b = await user("supervisor-b", "supervisor", { scopeKind: "office", scopeId: officeB });

  const login = async (u) => {
    const res = await fetch(`${apiUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password }) });
    if (res.status !== 200) throw new Error(`seed login failed (${res.status}) for ${u.email.split("-")[0]}`);
    return (await res.json()).access_token;
  };
  const tokens = {};
  for (const [k, u] of Object.entries(users)) tokens[k] = await login(u);

  const { rows: v } = await q(`SELECT COALESCE(max(version), 0) + 1 AS v FROM upload_forms`);
  const formVersion = v[0].v;
  await q(`INSERT INTO upload_forms (version, schema) VALUES ($1, $2)`, [formVersion, { version: formVersion, fields: [] }]);

  const write = async (token, method, path, body) => {
    const res = await fetch(`${apiUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID(), "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status >= 300) throw new Error(`seed ${method} ${path} -> ${res.status}`);
    return text ? JSON.parse(text) : null;
  };
  // canary coordinates: unrealistic on purpose, distinct per material, 8 decimals so a collision is not plausible
  const canaries = { coordinates: [], titles: [] };
  const create = async (token, tag, lat, lng, governorate) => {
    const title = `canary-title-${tag}-${randomBytes(4).toString("hex")}`;
    canaries.coordinates.push(String(lat), String(lng));
    canaries.titles.push(title);
    return write(token, "POST", "/materials", {
      title, material_types: ["report"], governorate, city: "c", priority: "urgent",
      sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: "network" },
      form_version: formVersion, dynamic_fields: {}, gps: { lat, lng }, shot_at: "2026-10-19T09:30:00Z",
    });
  };
  const mA = await create(tokens.reporter, "a", 12.34567891, 98.76543219, "gaza");
  const mB = await create(tokens.reporter_b, "b", 23.45678912, 87.65432198, "khan_younis");

  // supervisor B acknowledges B's material: reporter B gets a notification that reporter A must not reach
  await write(tokens.supervisor_b, "POST", `/materials/${mB.id}/transitions`, { track: "editorial", to: "acknowledged", reason: "seen" });
  let notificationB = null;
  for (let i = 0; i < 50 && !notificationB; i++) {
    notificationB = (await q(`SELECT id FROM notifications WHERE user_id = $1 LIMIT 1`, [users.reporter_b.id])).rows[0]?.id ?? null;
    if (!notificationB) await new Promise((r) => setTimeout(r, 200));
  }

  const uploadToken = randomBytes(16).toString("base64url");
  const session = (await q(
    `INSERT INTO upload_sessions (material_id, created_by, kind, state, size_bytes, filename, part_size_bytes, upload_token_hash, expires_at)
     VALUES ($1, $2, 'original', 'created', 1000, 'clip.mp4', 16777216, $3, now() + interval '1 hour') RETURNING id`,
    [mB.id, users.reporter_b.id, sha256(uploadToken)],
  )).rows[0].id;
  const sessionA = (await q(
    `INSERT INTO upload_sessions (material_id, created_by, kind, state, size_bytes, filename, part_size_bytes, upload_token_hash, expires_at)
     VALUES ($1, $2, 'original', 'created', 1000, 'clip.mp4', 16777216, $3, now() + interval '1 hour') RETURNING id`,
    [mA.id, users.reporter.id, sha256(randomBytes(8))],
  )).rows[0].id;

  // upload sessions for the hook cases: each with its own token so cases cannot interfere with each other
  const hookSession = async (state, expiresSql = "now() + interval '1 hour'") => {
    const token = randomBytes(16).toString("base64url");
    const id = (await q(
      `INSERT INTO upload_sessions (material_id, created_by, kind, state, size_bytes, filename, part_size_bytes, upload_token_hash, expires_at)
       VALUES ($1, $2, 'original', $3, 1000, 'clip.mp4', 16777216, $4, ${expiresSql}) RETURNING id`,
      [mA.id, users.reporter.id, state, sha256(token)],
    )).rows[0].id;
    return { id, token, size: 1000 };
  };
  const hookSessions = {
    ok: [await hookSession("created"), await hookSession("created"), await hookSession("created"), await hookSession("created")],
    expired: await hookSession("created", "now() - interval '1 minute'"),
    finished: await hookSession("completed"),
  };

  await pool.end();
  const { reporter_b: _b, supervisor_b: _sb, ...roleTokens } = tokens;
  return {
    tokens: roleTokens, allTokens: tokens, users, password,
    fixtures: {
      other_reporter_material_id: mB.id, out_of_scope_material_id: mB.id,
      other_reporter_upload_id: session, other_reporter_notification_id: notificationB,
      own_material_id: mA.id, sensitive_field_keys: [],
    },
    canaries, formVersion, uploads: { sessionB: session, tokenB: uploadToken, sessionA, materialA: mA.id, materialB: mB.id, hookSessions },
  };
}
