// reporter-identity-access (ADR 0021): which permission reveals the reporter's legal name follows the admin setting, live.
//   RID_API_URL  RID_TOKENS {system_admin, identity_holder, source_holder, reporter}  RID_USERS {identity_holder, source_holder}
//   RID_MATERIAL_ID  RID_LEGAL_NAME (the canary the seed stored encrypted for the reporter; without it the name itself is not checked)
// separate (default): only reporter_identity:read sees the key, protected_source:read alone does not; switching to protected_source
// takes effect on the next request with one setting.changed event (setting, value, actor, coded reason; no name); the same value
// again writes no event; switching back restores separate. Admin only, coded reason only. Not measured: several API processes
// (each caches the setting for at most 5 s).
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client } from "../lib/live.mjs";
import { checker, gateOff } from "../lib/core-gate.mjs";
import { freshFetch } from "../lib/http.mjs";

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("reporter-identity-access"));
  const off = gateOff("reporter-identity-access", env);
  if (off) return off;
  if (!env.RID_API_URL) { console.error("ENVIRONMENT: RID_API_URL is not set; nothing measured"); return { code: 2, doc: null }; }
  const t = JSON.parse(env.RID_TOKENS ?? "{}");
  const u = JSON.parse(env.RID_USERS ?? "{}");
  const m = env.RID_MATERIAL_ID, legal = env.RID_LEGAL_NAME || null;
  const http = client(env.RID_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("reporter-identity-access", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const setting = "/admin/settings/reporter-identity";
  const put = (token, body) => http.call(token, "PUT", setting, { body });
  const sees = async (token) => {
    const r = await http.get(token, `/materials/${m}`);
    return r.status === 200 && r.body && Object.hasOwn(r.body, "reporter_legal_name") ? r.body.reporter_legal_name : undefined;
  };
  const visible = (v) => v !== undefined && (legal === null || v === legal);
  const settingEvents = async () => {
    const items = [];
    let after = null;
    for (let i = 0; i < 50; i++) {
      const r = await http.get(t.system_admin, `/events?type=setting.changed&limit=100${after ? `&after=${after}` : ""}`);
      if (r.status !== 200) break;
      items.push(...r.body.items);
      if (!r.body.next_after || r.body.items.length === 0) break;
      after = r.body.next_after;
    }
    return items;
  };

  for (const [who, perm] of [["identity_holder", "reporter_identity:read"], ["source_holder", "protected_source:read"]]) {
    const g = await http.call(t.system_admin, "PUT", `/users/${u[who]}/permissions/${perm}`, { body: { reason: "acceptance reporter-identity-access" } });
    if (g.status !== 204) throw new Error(`grant ${perm} answered ${g.status}`);
  }
  if ((await http.get(t.system_admin, setting)).body?.access !== "separate") await put(t.system_admin, { access: "separate", reason_code: "audit_finding" });

  const start = await http.get(t.system_admin, setting);
  check("the setting reads separate", start.status === 200 && start.body?.access === "separate", JSON.stringify(start.body));
  check("separate: the reporter_identity:read holder sees the legal name", visible(await sees(t.identity_holder)));
  check("separate: protected_source:read alone does not get the key", (await sees(t.source_holder)) === undefined);
  check("separate: the reporter does not get the key", (await sees(t.reporter)) === undefined);

  const before = (await settingEvents()).length;
  const sw = await put(t.system_admin, { access: "protected_source", reason_code: "policy_change" });
  check("switch to protected_source answers 200 with the actor", sw.status === 200 && sw.body?.access === "protected_source" && typeof sw.body?.updated_by === "string", `${sw.status}`);
  check("protected_source: the protected_source:read holder sees it on the next request", visible(await sees(t.source_holder)));
  check("protected_source: reporter_identity:read alone does not get the key", (await sees(t.identity_holder)) === undefined);
  const evs = (await settingEvents()).slice(before);
  const ev = evs[0];
  check("one setting.changed event", evs.length === 1, `${evs.length}`);
  check("the event carries setting, value, actor and coded reason only",
    ev && ev.payload?.setting === "reporter_legal_name_access" && ev.payload?.value === "protected_source" && ev.payload?.reason_code === "policy_change"
      && Object.keys(ev.payload).every((k) => ["setting", "value", "actor_id", "reason_code", "occurred_at"].includes(k)), JSON.stringify(ev?.payload));
  check("no legal name in the event", !legal || !JSON.stringify(evs).includes(legal));

  const again = await put(t.system_admin, { access: "protected_source", reason_code: "operational_need" });
  check("the same value again answers 200 and writes no event", again.status === 200 && (await settingEvents()).length === before + 1);

  check("a non-admin cannot read or change it", (await http.get(t.identity_holder, setting)).status === 403 && (await put(t.identity_holder, { access: "separate", reason_code: "policy_change" })).status === 403);
  check("a free-text reason is refused", (await put(t.system_admin, { access: "separate", reason_code: "because" })).status === 422);

  const back = await put(t.system_admin, { access: "separate", reason_code: "audit_finding" });
  check("switching back restores separate", back.status === 200 && (await sees(t.source_holder)) === undefined && visible(await sees(t.identity_holder)));

  for (const [who, perm] of [["identity_holder", "reporter_identity:read"], ["source_holder", "protected_source:read"]]) {
    await http.call(t.system_admin, "DELETE", `/users/${u[who]}/permissions/${perm}`);
  }
  const result = fails.length ? "fail" : legal ? "pass" : "partial";
  finish(doc, result, { events_on_change: evs.length }, `الوضعان والتبديل الحي على نسخة خادم واحدة؛ لم يُقَس التبديل عبر عمليات خادم متعددة (كاش ≤ 5 ث)${legal ? "" : "؛ بلا اسم كناري فلم يُقارن الاسم نفسه"}`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
