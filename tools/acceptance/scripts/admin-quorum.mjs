// admin-quorum (core gate): a system admin cannot be suspended from the web/API, only by the two-person command line; the guard keeps at least two admins.
//   QUORUM_API_URL  QUORUM_TOKENS {system_admin, supervisor, victim}  QUORUM_USERS {system_admin_id, system_admin_b_id, victim_id, ...}  QUORUM_TOKEN_B (the target admin's token)
//   optional, the command line (any shell command; exit code is the verdict). It runs in this order, with TARGET_ID (the target admin) and, from
//   QUORUM_TOTP {label: secretHex}, a fresh TOTP_<label> for every secret, and the ids in QUORUM_USERS as ID_<LABEL> (QUORUM_CLI_ENV: JSON env for the command):
//     QUORUM_CLI_ONE    one approver only: must be REFUSED (non-zero) and change nothing
//     QUORUM_CLI_TWO    two approvers: must be ACCEPTED (zero) and revoke the target admin's access
//     QUORUM_CLI_GUARD  would leave fewer than two active admins (after TWO): must be REFUSED; QUORUM_TOKEN_C (the admin it targets) must keep working
// API part: PUT /users/{admin}/status -> 403 admin_quorum_required with the admin still working; self-suspension 403; a non-admin cannot suspend;
// an ordinary user is suspended (204, repeat 204, their token stops working) and reactivated. `pass` needs the command-line part; without it partial.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client } from "../lib/live.mjs";
import { checker, gateOff } from "../lib/core-gate.mjs";
import { freshFetch } from "../lib/http.mjs";

/** RFC 6238 (SHA-1, 6 digits, 30 s): the code the approver's authenticator would show now. */
export function totp(secretHex, nowMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const mac = createHmac("sha1", Buffer.from(secretHex, "hex")).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("admin-quorum"));
  const off = gateOff("admin-quorum", env);
  if (off) return off;
  if (!env.QUORUM_API_URL) { console.error("ENVIRONMENT: QUORUM_API_URL is not set; nothing measured"); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.QUORUM_TOKENS ?? "{}"), users = JSON.parse(env.QUORUM_USERS ?? "{}");
  const tokenB = env.QUORUM_TOKEN_B;
  const http = client(env.QUORUM_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("admin-quorum", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const setStatus = (token, id, status) => http.call(token, "PUT", `/users/${id}/status`, { body: { status } });
  const me = async (token) => (await http.get(token, "/auth/me")).status;

  const onAdmin = await setStatus(tokens.system_admin, users.system_admin_b_id, "suspended");
  check("suspending another system admin from the API is 403 admin_quorum_required", onAdmin.status === 403 && onAdmin.body?.code === "admin_quorum_required", `${onAdmin.status} ${onAdmin.body?.code}`);
  if (tokenB) check("that admin is untouched: the token still works", (await me(tokenB)) === 200);
  const onSelf = await setStatus(tokens.system_admin, users.system_admin_id, "suspended");
  check("an admin cannot suspend their own account", onSelf.status === 403, String(onSelf.status));
  check("the admin's own token still works", (await me(tokens.system_admin)) === 200);
  const byNonAdmin = await setStatus(tokens.supervisor, users.victim_id, "suspended");
  check("a non-admin cannot suspend anyone", byNonAdmin.status === 403, String(byNonAdmin.status));
  check("... and the target was not touched", (await me(tokens.victim)) === 200 || tokens.victim === undefined);

  const first = await setStatus(tokens.system_admin, users.victim_id, "suspended");
  check("an admin suspends an ordinary user (204)", first.status === 204, String(first.status));
  check("the suspension revokes the user's access at once", tokens.victim === undefined || (await me(tokens.victim)) === 401);
  check("suspending again is idempotent (204)", (await setStatus(tokens.system_admin, users.victim_id, "suspended")).status === 204);
  check("reactivation is accepted (204)", (await setStatus(tokens.system_admin, users.victim_id, "active")).status === 204);

  const secrets = JSON.parse(env.QUORUM_TOTP ?? "{}");
  const cli = (cmd) => spawnSync("bash", ["-c", cmd], {
    env: {
      ...env, ...JSON.parse(env.QUORUM_CLI_ENV ?? "{}"), TARGET_ID: users.system_admin_b_id,
      ...Object.fromEntries(Object.entries(users).map(([k, v]) => [`ID_${k.toUpperCase()}`, v])),
      ...Object.fromEntries(Object.entries(secrets).map(([k, hex]) => [`TOTP_${k.toUpperCase()}`, totp(hex)])),
    },
    encoding: "utf8", timeout: 120_000,
  });
  // a command that could not even start (missing build, bad path) is not a refusal: only the CLI's own answer counts
  const notStarted = (r) => r.error || r.status === 127 || /Cannot find module|MODULE_NOT_FOUND|command not found/.test(`${r.stderr}`);
  const cliRan = Boolean(env.QUORUM_CLI_ONE && env.QUORUM_CLI_GUARD && env.QUORUM_CLI_TWO);
  if (cliRan) {
    const one = cli(env.QUORUM_CLI_ONE);
    check("command line, one approver: refused and nothing changes", !notStarted(one) && one.status !== 0 && (!tokenB || (await me(tokenB)) === 200), `exit ${one.status}`);
    const two = cli(env.QUORUM_CLI_TWO);
    check("command line, two approvers: accepted", !notStarted(two) && two.status === 0, `exit ${two.status} ${String(two.stderr).slice(0, 120)}`);
    if (tokenB) check("... and the target admin's access is revoked", (await me(tokenB)) === 401);
    const guard = cli(env.QUORUM_CLI_GUARD);
    check("command line, guard: a suspension that leaves fewer than two active admins is refused for that reason (quorum)", !notStarted(guard) && guard.status === 1 && /quorum/.test(`${guard.stderr}${guard.stdout}`), `exit ${guard.status} ${String(guard.stderr).slice(0, 120)}`);
    if (env.QUORUM_TOKEN_C) check("... and the admin it targeted still works", (await me(env.QUORUM_TOKEN_C)) === 200);
  } else console.log("note the two-person command line was not given (QUORUM_CLI_ONE, QUORUM_CLI_TWO, QUORUM_CLI_GUARD): that part is not measured");

  finish(doc, fails.length ? "fail" : cliRan ? "pass" : "partial", {
    api_admin_target_refused: onAdmin.status === 403, api_self_refused: onSelf.status === 403, ordinary_user_suspended: first.status === 204, cli_checked: cliRan,
  }, cliRan ? "الواجهة وسطر الأوامر ثنائي الأشخاص والحارس" : "جزء الواجهة فقط؛ سطر الأوامر ثنائي الأشخاص لم يُقَس (لم يُعطَ أمره) فلا pass");
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
