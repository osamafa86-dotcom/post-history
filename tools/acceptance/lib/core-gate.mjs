// Shared by the core-gate acceptance scripts (reservation-conflict, optimistic-concurrency, admin-quorum, download-url,
// notification-delivery). They are built ahead of the server work they measure (#69, #75), so they run only behind a flag:
// CORE_ACCEPTANCE=1 (the live harness and the compose jobs set it once the server side is on main). Without the flag a
// script prints that it is off and exits as pending; it never writes a result, so nothing is claimed that was not measured.
import { materialBody } from "./live.mjs";
import { EXIT_PENDING } from "./pending.mjs";

export const coreEnabled = (env = process.env) => env.CORE_ACCEPTANCE === "1";

/** `{code: EXIT_PENDING}` when the flag is off; null when the script may run. */
export function gateOff(name, env = process.env) {
  if (coreEnabled(env)) return null;
  console.log(`PENDING: ${name} is behind CORE_ACCEPTANCE=1 until the server side is merged; nothing measured`);
  return { code: EXIT_PENDING, doc: null };
}

/** A material in `accepted` state: the reporter creates it, the supervisor walks it inbox -> acknowledged -> reviewing -> accepted. */
export async function acceptedMaterial(http, tokens, formVersion, label) {
  const m = (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(formVersion, `${label}-${Math.random().toString(36).slice(2, 10)}`) })).body;
  if (!m?.id) throw new Error("material not created");
  for (const to of ["acknowledged", "reviewing", "accepted"]) {
    const r = await http.call(tokens.supervisor, "POST", `/materials/${m.id}/transitions`, { body: { track: "editorial", to, reason: "core-gate" } });
    if (r.status !== 200) throw new Error(`transition to ${to} answered ${r.status}`);
  }
  return m.id;
}

/** Records a failed check by name and prints it; `ok` lines are printed too so a log shows what ran. */
export function checker() {
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); };
  return { fails, check };
}

export const etagOf = (res) => res.headers?.etag ?? null;
