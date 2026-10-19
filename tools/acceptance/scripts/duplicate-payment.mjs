// duplicate-payment — TEMPORARY SUBSTITUTE until the commercial phase has payments.
// The row's criterion is "replaying a gateway notification ten times, in different order, creates no duplicate
// licence or ledger entry". Payments do not exist yet, so this script measures the property underneath it on the
// writes that do exist: every write carries an Idempotency-Key, a repeat returns the first response, a different
// body under the same key is rejected, and concurrent duplicates execute once. It never claims the payment criterion.
//   IDEM_BASE_URL=http://127.0.0.1:13000/v1  IDEM_TOKENS='{"reporter":"…","supervisor":"…",…one per role}'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { canon, client, materialBody } from "../lib/live.mjs";

const ID_RE = /\{[^}]+\}/g;

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("duplicate-payment"));
  const doc = newResult("duplicate-payment", { device: { platform: "server" }, upload_path: "n/a" });
  if (!env.IDEM_BASE_URL) {
    console.error("ENVIRONMENT: IDEM_BASE_URL is not set; nothing measured (this script needs a running API)");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.IDEM_TOKENS ?? "{}");
  const api = YAML.parse(readFileSync(join(ROOT, "contracts/openapi.yaml"), "utf8"));
  const http = client(env.IDEM_BASE_URL);
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } };

  // A. every write operation outside /auth and /internal: a missing or malformed key is 422 before anything runs
  let checked = 0, unimplemented = 0;
  const writeOps = [];
  for (const [path, item] of Object.entries(api.paths)) {
    if (path.startsWith("/auth/") || path.startsWith("/internal/")) continue;
    for (const method of ["post", "put", "patch", "delete"].filter((m) => item[m])) {
      const roles = item[method]["x-roles"] ?? [];
      const role = roles.includes("authenticated") ? "reporter" : roles.find((r) => tokens[r]);
      writeOps.push({ path, method: method.toUpperCase(), role });
    }
  }
  for (const op of writeOps) {
    const url = op.path.replace(ID_RE, randomUUID());
    const probe = await http.call(null, op.method, url, { key: null });
    if (probe.status === 404) { unimplemented++; continue; }
    if (!op.role || !tokens[op.role]) { check(`${op.method} ${op.path}`, false, "no token for an allowed role"); continue; }
    checked++;
    const none = await http.call(tokens[op.role], op.method, url, { key: null });
    check(`${op.method} ${op.path} without key`, none.status === 422, `status ${none.status}`);
    const bad = await http.call(tokens[op.role], op.method, url, { key: "short" });
    check(`${op.method} ${op.path} with malformed key`, bad.status === 422, `status ${bad.status}`);
  }

  // B. behaviour on real writes
  const form = (await http.get(tokens.reporter, "/forms/current")).body;
  const fv = form.version;
  const unique = () => `idem-${randomUUID().slice(0, 8)}-material`;
  const countByTitle = async (title) => (await http.get(tokens.reporter, "/materials?limit=100")).body.items.filter((m) => m.title === title).length;

  const t1 = unique(), k1 = randomUUID(), b1 = materialBody(fv, t1);
  const first = await http.call(tokens.reporter, "POST", "/materials", { body: b1, key: k1 });
  const again = await http.call(tokens.reporter, "POST", "/materials", { body: b1, key: k1 });
  check("replay returns the first status", first.status === 201 && again.status === first.status, `${first.status}/${again.status}`);
  check("replay returns the first body (same JSON value)", canon(again.body) === canon(first.body));
  check("replay does not create a second material", (await countByTitle(t1)) === 1);

  const other = await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `${t1}-x`), key: k1 });
  check("same key, different body is 422 idempotency_key_reused", other.status === 422 && other.body?.code === "idempotency_key_reused", `${other.status} ${other.body?.code}`);

  const t3 = unique(), k3 = randomUUID(), b3 = materialBody(fv, t3);
  const burst = await Promise.all(Array.from({ length: 5 }, () => http.call(tokens.reporter, "POST", "/materials", { body: b3, key: k3 })));
  const okays = burst.filter((r) => r.status === 201), inprog = burst.filter((r) => r.status === 409 && r.body?.code === "idempotency_in_progress");
  check("concurrent duplicates: only 201 replays or 409 idempotency_in_progress", okays.length + inprog.length === burst.length, burst.map((r) => r.status).join(","));
  check("concurrent duplicates: all 201s are the same response", new Set(okays.map((r) => canon(r.body))).size <= 1);
  check("concurrent duplicates execute once", (await countByTitle(t3)) === 1);

  const m = (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, unique()) })).body;
  const tk = randomUUID(), tb = { track: "editorial", to: "acknowledged", reason: "seen" };
  const ack1 = await http.call(tokens.supervisor, "POST", `/materials/${m.id}/transitions`, { body: tb, key: tk });
  const ack2 = await http.call(tokens.supervisor, "POST", `/materials/${m.id}/transitions`, { body: tb, key: tk });
  check("a replayed transition returns the first response, not invalid_transition", ack1.status < 300 && ack2.status === ack1.status && canon(ack2.body) === canon(ack1.body), `${ack1.status}/${ack2.status}`);
  const log = (await http.get(tokens.reporter, `/materials/${m.id}/transitions`)).body;
  const acks = (log.items ?? log).filter?.((t) => t.to_state === "acknowledged" || t.to === "acknowledged") ?? [];
  check("a replayed transition is recorded once", acks.length <= 1, `${acks.length} acknowledged entries`);
  const fresh = await http.call(tokens.supervisor, "POST", `/materials/${m.id}/transitions`, { body: tb });
  check("the same transition under a NEW key is a real second attempt (409 invalid_transition)", fresh.status === 409, `status ${fresh.status}`);

  const failed = fails.length > 0;
  finish(doc, failed ? "fail" : unimplemented ? "partial" : "pass", {
    variant: "idempotency-key-on-writes",
    write_operations_total: writeOps.length, write_operations_checked: checked, write_operations_unimplemented: unimplemented,
    behaviour_scenarios: 8, failures: fails.length,
  }, ["بديل مؤقت لمعيار الدفع المكرر: يقيس مفتاح منع التكرار على كل كتابة موجودة، ولا يدّعي معيار البوابة المالية (لا دفع في التأسيس)",
      unimplemented ? `${unimplemented} عملية كتابة في العقد لم تُنفَّذ بعد في الخادم فلم تُقَس` : null].filter(Boolean).join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "idempotency-writes" }));
  return { code: failed ? 1 : 0, doc };
}
