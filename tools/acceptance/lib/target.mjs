// A remote host under test (the field trial): accounts come from the environment, everything else is made through the public API.
// Nothing here touches a database or object storage; what needs them stays in the compose-only scripts.
//   FT_ACCOUNTS  JSON {"reporter":{"email":"…","password":"…"},"reporter_b":…,"supervisor_b":…, …other roles}; an account with TOTP also carries "totp_secret" (hex)
//                reporter_b and supervisor_b belong to ANOTHER office than reporter (the isolation cases need two offices).
//                "system_admin" is read only for a run that needs it (--allow-publish-form, local compose only), and then only with TOTP enrolled: see loginAccount.
import { randomBytes, createHash } from "node:crypto";
import { client, createUploadSession, sleep } from "./live.mjs";
import { totp, totpStep } from "./totp.mjs";

export const REQUIRED = ["reporter", "reporter_b", "supervisor_b"];
export const ROLES = ["system_admin", "editor_in_chief", "supervisor", "producer", "finance", "reporter", "rights_officer"];

/** True for a host on this machine (the only kind a run may publish a form to or use the administrator on). */
export const isLoopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

/** { url, apiUrl, tusUrl } from `--target https://host`; plain http is allowed for loopback only. */
export function parseTarget(value, env = process.env) {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error(`--target must be a URL, got "${value}"`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("--target must be https (http only for loopback)");
  const base = `${u.protocol}//${u.host}`;
  return { url: base, apiUrl: env.FT_API_URL ?? `${base}/v1`, tusUrl: env.FT_TUS_URL ?? `${base}/files/` };
}

/**
 * One login. A system_admin account must have TOTP: a password-only 200 is refused (the token is revoked at once) because an administrator
 * reachable by password alone is exactly what a trial host must not have. Any account the server answers 401 totp_required needs its totp_secret.
 */
export async function loginAccount(api, role, a, { now = Date.now() } = {}) {
  let r = await api.call(null, "POST", "/auth/login", { body: { email: a.email, password: a.password }, key: null });
  if (r.status === 200) {
    if (role === "system_admin") {
      await api.call(r.body.access_token, "POST", "/auth/logout", { key: null }).catch(() => {});
      throw new Error("system_admin logs in with a password alone: TOTP is not enrolled, refused (that session was logged out); enrol TOTP on the account and run again");
    }
    return r.body.access_token;
  }
  if (r.status === 401 && r.body?.code === "totp_required") {
    if (!a.totp_secret) throw new Error(`login needs a TOTP code for ${role}: give totp_secret in FT_ACCOUNTS.${role}`);
    r = await api.call(null, "POST", "/auth/login", { body: { email: a.email, password: a.password, totp_code: totp(a.totp_secret, now) }, key: null });
    if (r.status === 200) return r.body.access_token;
  }
  throw new Error(`login failed (${r.status}) for ${role}`);
}

export function accountsFromEnv(env = process.env) {
  if (!env.FT_ACCOUNTS) return { accounts: null, missing: REQUIRED };
  let accounts;
  try { accounts = JSON.parse(env.FT_ACCOUNTS); } catch { throw new Error("FT_ACCOUNTS is not valid JSON"); }
  for (const [role, a] of Object.entries(accounts)) if (!a?.email || !a?.password) throw new Error(`FT_ACCOUNTS.${role} needs email and password`);
  return { accounts, missing: REQUIRED.filter((r) => !accounts[r]) };
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/**
 * Logs in every account and makes the fixtures the live scripts need, through the API only: one material per reporter
 * (canary coordinates and titles), an upload session and a notification of the other office's reporter.
 * Returns the shape live/seed.mjs returns, minus what only a database gives (hook sessions).
 */
export async function remoteSeed({ apiUrl, accounts, adminNeeded = false, fetchImpl }) {
  const api = client(apiUrl, fetchImpl);
  const tokens = {}, users = {};
  let adminStep = null;
  for (const [role, a] of Object.entries(accounts)) {
    if (role === "system_admin" && !adminNeeded) continue;   // least privilege: the administrator is not even logged in unless a step needs it
    if (role === "system_admin") adminStep = totpStep();
    tokens[role] = await loginAccount(api, role, a);
    users[role] = { email: a.email };
  }
  const formVersion = (await api.get(tokens.reporter, "/forms/current")).body?.version;
  if (!Number.isInteger(formVersion)) throw new Error("GET /forms/current gave no version");
  const canaries = { coordinates: [], titles: [] };
  const create = async (token, tag, lat, lng, governorate) => {
    const title = `canary-title-${tag}-${randomBytes(4).toString("hex")}`;
    canaries.coordinates.push(String(lat), String(lng));
    canaries.titles.push(title);
    const r = await api.call(token, "POST", "/materials", { body: {
      title, material_types: ["report"], governorate, city: "c", priority: "urgent",
      sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: "network" },
      form_version: formVersion, dynamic_fields: {}, gps: { lat, lng }, shot_at: "2026-10-19T09:30:00Z",
    } });
    if (r.status !== 201) throw new Error(`POST /materials answered ${r.status}`);
    return r.body;
  };
  const mA = await create(tokens.reporter, "a", 12.34567891, 98.76543219, "gaza");
  const mB = await create(tokens.reporter_b, "b", 23.45678912, 87.65432198, "khan_younis");
  const ack = await api.call(tokens.supervisor_b, "POST", `/materials/${mB.id}/transitions`, { body: { track: "editorial", to: "acknowledged", reason: "seen" } });
  let notificationB = null;
  for (let i = 0; i < 50 && ack.status < 300 && !notificationB; i++) {
    notificationB = (await api.get(tokens.reporter_b, "/notifications")).body?.items?.[0]?.id ?? null;
    if (!notificationB) await sleep(200);
  }
  // a stand-in file's digest: the session only has to exist for the isolation cases
  const up = await createUploadSession(api, tokens.reporter_b, { materialId: mB.id, size: 1000, clientSha256: sha256(Buffer.alloc(1000, 0x5a)) }).catch(() => null);
  const { reporter_b: _b, supervisor_b: _sb, ...roleTokens } = tokens;
  return {
    tokens: roleTokens, allTokens: tokens, users, formVersion, canaries, adminStep,
    fixtures: {
      other_reporter_material_id: mB.id, out_of_scope_material_id: mB.id,
      other_reporter_upload_id: up?.id ?? null, other_reporter_notification_id: notificationB,
      own_material_id: mA.id, sensitive_field_keys: [],
    },
  };
}

