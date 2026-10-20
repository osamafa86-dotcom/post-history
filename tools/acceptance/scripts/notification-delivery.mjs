// notification-delivery (core gate): a receipt event -> notification to the right recipients within a measured time, whitelisted payload only,
// and "اطّلعت" (ack) stops the escalation.
//   NOTIF_API_URL  NOTIF_TOKENS {reporter, supervisor, supervisor_b, editor_in_chief, system_admin}  NOTIF_RUNS (20)  NOTIF_LIMIT_S (10, the plan's delivery target)
//   NOTIF_ESCALATION_S  the server's short urgent escalation timeout; without it the escalation half is not measured
// Per run: a material carrying a canary GPS and a canary title is created (alternating urgent/normal). The office supervisor gets exactly one notification within the limit;
// the other office's supervisor and the reporter get none for it; every notification carries only the contract's keys and neither canary; the Outbox payloads of the events
// stay inside the closed whitelist of contracts/schemas/outbox-event.json. Then the supervisor's ack answers 204, the material becomes acknowledged, the reporter is told.
// `pass` needs 20 runs, p95 within the limit and the escalation half measured.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, eventsOfType, materialBody, percentile, sleep } from "../lib/live.mjs";
import { waitFor } from "../lib/hooks.mjs";
import { checker, gateOff } from "../lib/core-gate.mjs";
import { freshFetch } from "../lib/http.mjs";
import { scan, CHANNEL_KEYS } from "../lib/pii.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NOTIFICATION_KEYS = ["id", "type", "material_id", "title", "priority", "state", "assignment_state", "escalation_level", "recovery_request_id", "created_at", "read_at", "acknowledged_at"];

/** The allowed payload keys of one event type, from the closed whitelist in the contract. */
export function allowedPayloadKeys(type, schema = JSON.parse(readFileSync(join(HERE, "../../../contracts/schemas/outbox-event.json"), "utf8"))) {
  const rule = schema.allOf.find((r) => r.if?.properties?.type?.enum?.includes(type));
  return rule ? Object.keys(rule.then?.properties?.payload?.properties ?? {}) : null;
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("notification-delivery"));
  const off = gateOff("notification-delivery", env);
  if (off) return off;
  if (!env.NOTIF_API_URL) { console.error("ENVIRONMENT: NOTIF_API_URL is not set; nothing measured"); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.NOTIF_TOKENS ?? "{}");
  const http = client(env.NOTIF_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("notification-delivery", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const runs = Number(env.NOTIF_RUNS ?? 20), limitS = Number(env.NOTIF_LIMIT_S ?? 10);
  const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
  const inbox = async (role) => (await http.get(tokens[role], "/notifications?limit=100")).body.items ?? [];
  const lat = [];
  const n = { missing: 0, duplicates: 0, strayRecipient: 0, badKeys: 0, leaks: 0, acked: 0, reporterTold: 0 };
  const created = [];
  for (let i = 0; i < runs; i++) {
    const lat0 = 40 + i / 1000 + 0.12345678, lng0 = 31 + i / 1000 + 0.87654321;
    const title = `deliver-${i}-${Math.random().toString(36).slice(2, 10)}`;
    const t0 = Date.now();
    const m = (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, title, { priority: i % 2 ? "urgent" : "normal", gps: { lat: lat0, lng: lng0 } }) })).body;
    created.push(m.id);
    const got = await waitFor(async () => { const mine = (await inbox("supervisor")).filter((x) => x.material_id === m.id); return mine.length ? mine : null; }, { timeoutMs: (limitS + 20) * 1000, everyMs: 150 });
    if (!got.value) { n.missing++; continue; }
    lat.push((Date.now() - t0) / 1000);
    if (got.value.length > 1) n.duplicates++;
    await sleep(500);
    const others = [...(tokens.supervisor_b ? await inbox("supervisor_b") : []), ...(await inbox("reporter"))].filter((x) => x.material_id === m.id && x.type !== "upload.verified");
    if (others.length) n.strayRecipient++;
    for (const x of got.value) {
      if (Object.keys(x).some((k) => !NOTIFICATION_KEYS.includes(k))) n.badKeys++;
      if (JSON.stringify(x).includes(title) || scan(x, { keys: CHANNEL_KEYS, canaries: [String(lat0), String(lng0)] }).length) n.leaks++;
    }
    const mine = got.value[0];
    if (mine && (await http.call(tokens.supervisor, "POST", `/notifications/${mine.id}/ack`)).status === 204) {
      const seen = await waitFor(async () => (await http.get(tokens.reporter, `/materials/${m.id}`)).body?.editorial_state === "acknowledged", { timeoutMs: 5000, everyMs: 150 });
      if (seen.value) n.acked++;
      const told = await waitFor(async () => (await inbox("reporter")).some((x) => x.material_id === m.id && x.type === "material.acknowledged"), { timeoutMs: limitS * 1000, everyMs: 150 });
      if (told.value) n.reporterTold++;
    }
  }
  lat.sort((a, b) => a - b);
  const p95 = percentile(lat, 95), p50 = percentile(lat, 50);
  check(`every material reached the office supervisor (p95 ${p95 ?? "n/a"} s, limit ${limitS} s)`, n.missing === 0 && p95 !== null && p95 <= limitS, `missing ${n.missing}`);
  check("exactly one notification per material for the recipient", n.duplicates === 0, `${n.duplicates} duplicates`);
  check("nobody else was notified: the other office's supervisor, the reporter (own incoming)", n.strayRecipient === 0, `${n.strayRecipient} stray`);
  check("every notification carries only the contract's keys", n.badKeys === 0, `${n.badKeys} with extra keys`);
  check("no canary coordinate or material title in any notification", n.leaks === 0, `${n.leaks} leaks`);
  check("ack (اطّلعت): 204, the material becomes acknowledged", n.acked === lat.length, `${n.acked}/${lat.length}`);
  check("ack tells the reporter their material was seen", n.reporterTold === lat.length, `${n.reporterTold}/${lat.length}`);

  let eventsBad = 0, eventsChecked = 0;
  if (tokens.system_admin) {
    for (const type of ["material.created", "material.urgent_received", "material.acknowledged"]) {
      const allowed = allowedPayloadKeys(type);
      for (const e of await eventsOfType(http, tokens.system_admin, type)) {
        if (!created.includes(e.payload?.material_id)) continue;
        eventsChecked++;
        if (!allowed || Object.keys(e.payload).some((k) => !allowed.includes(k))) eventsBad++;
      }
    }
    check("Outbox payloads of these materials stay inside the closed whitelist", eventsChecked > 0 && eventsBad === 0, `${eventsBad}/${eventsChecked} outside`);
  }

  // escalation: an urgent material nobody acknowledges escalates after the server's timeout; one acknowledged in time stays quiet
  let escalationMeasured = false;
  if (env.NOTIF_ESCALATION_S && tokens.editor_in_chief) {
    const secs = Number(env.NOTIF_ESCALATION_S);
    const make = async (tag) => (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `escalate-${tag}-${Math.random().toString(36).slice(2, 8)}`, { priority: "urgent" }) })).body.id;
    const [unacked, acked] = [await make("open"), await make("acked")];
    const task = await waitFor(async () => (await inbox("supervisor")).find((x) => x.material_id === acked), { timeoutMs: 20_000, everyMs: 150 });
    if (task.value) await http.call(tokens.supervisor, "POST", `/notifications/${task.value.id}/ack`);
    await sleep((secs + 3) * 1000);
    const eic = (await inbox("editor_in_chief")).map((x) => x.material_id);
    check("an unacknowledged urgent material escalated to the editor in chief", eic.includes(unacked));
    check("an acknowledged one did not escalate", !eic.includes(acked));
    escalationMeasured = true;
  } else console.log("note NOTIF_ESCALATION_S not given: the escalation half is not measured");

  const full = runs >= 20 && escalationMeasured && Boolean(tokens.system_admin) && tokens.supervisor_b;
  finish(doc, fails.length ? "fail" : full ? "pass" : "partial", {
    runs, delivered: lat.length, limit_s: limitS, delivery_s_p50: p50 ?? "n/a", delivery_s_p95: p95 ?? "n/a", duplicates: n.duplicates, stray_recipients: n.strayRecipient,
    payload_key_violations: n.badKeys, leak_hits: n.leaks, acked: n.acked, reporter_told: n.reporterTold, outbox_events_checked: eventsChecked, escalation_measured: escalationMeasured,
  }, `${runs} مادة؛ زمن الوصول بالاستطلاع كل 150 مللي ثانية${full ? "" : "؛ أقل من 20 جولة أو بلا التصعيد أو الأحداث أو مشرف المكتب الآخر فلا pass"}`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
