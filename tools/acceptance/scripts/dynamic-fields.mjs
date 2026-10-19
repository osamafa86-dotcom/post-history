// dynamic-fields: new form version publishes with old records still readable, old phone drafts complete,
// and the conformance result is identical on the three clients.
// This script covers the shared-conformance part: it judges every platform result file given with
//   --platforms=web.json,ios.json,android.json   (each produced by that client from form-conformance/cases.json)
// With DYN_API_URL + DYN_TOKENS (system_admin, reporter) it also drives the live API: it publishes the shared form, runs every shared
// case through POST /materials, checks the v0 gate, readable history and completing an old draft with a newer version.
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { readFileSync } from "node:fs";
import { loadSuite, checkForms, judge, runReference } from "../form-conformance/run.mjs";
import { randomUUID } from "node:crypto";
import { client, materialBody } from "../lib/live.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("dynamic-fields"));
  const { suite, forms, results } = runReference();
  const doc = newResult("dynamic-fields", { device: { platform: "other" }, upload_path: "n/a" });

  const formProblems = checkForms(forms);
  const refWrong = judge(results, suite);
  const platforms = (typeof args.platforms === "string" ? args.platforms.split(",") : []).map((f) => JSON.parse(readFileSync(f, "utf8")));
  const verdicts = platforms.map((p) => ({ platform: p.platform, wrong: judge(p.results, suite) }));
  [...formProblems.map((p) => `form invalid: ${p}`), ...refWrong.map((w) => `reference ${w.id}: ${w.why}`),
    ...verdicts.flatMap((v) => v.wrong.map((w) => `${v.platform} ${w.id}: ${w.why}`))].forEach((l) => console.log(`FAIL ${l}`));
  // ---- server side, live
  const server = { ran: false, cases: 0, matching: 0, checks: {} };
  if (env.DYN_API_URL) {
    server.ran = true;
    const tokens = JSON.parse(env.DYN_TOKENS ?? "{}");
    const http = client(env.DYN_API_URL);
    const norm = (errs) => JSON.stringify([...(errs ?? [])].sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code)));
    const old = (await http.get(tokens.reporter, "/forms/current")).body.version;
    const oldMaterial = (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(old, `dyn-old-${randomUUID().slice(0, 8)}`) })).body;
    const published = await http.call(tokens.system_admin, "POST", "/forms", { body: { ...forms.main, version: old + 1 } });
    server.checks.publish = published.status === 201 && published.body.version === old + 1;
    const cur = (await http.get(tokens.reporter, "/forms/current")).body;
    server.checks.current_is_new = cur.version === old + 1;
    server.checks.stale_version_conflicts = (await http.call(tokens.system_admin, "POST", "/forms", { body: { ...forms.main, version: old + 1 } })).status === 409;
    const oldForm = await http.get(tokens.reporter, `/forms/${old}`);
    server.checks.old_version_readable = oldForm.status === 200 && oldForm.body.version === old;
    const still = (await http.get(tokens.reporter, `/materials/${oldMaterial.id}`)).body;
    server.checks.old_record_unchanged = still.form_version === old;
    const sens = { version: old + 2, fields: [{ key: "secret_src", type: "short_text", label: { ar: "م", en: "S" }, required: false, sensitive: true }] };
    const loc = { version: old + 2, fields: [{ key: "where", type: "location", label: { ar: "م", en: "W" }, required: false }] };
    server.checks.v0_gate_sensitive = (await http.call(tokens.system_admin, "POST", "/forms", { body: sens })).body?.code === "sensitive_fields_not_supported_v0";
    server.checks.v0_gate_location = (await http.call(tokens.system_admin, "POST", "/forms", { body: loc })).body?.code === "sensitive_fields_not_supported_v0";

    for (const c of suite.cases) {
      server.cases++;
      const r = await http.call(tokens.reporter, "POST", "/materials", { body: { ...materialBody(old + 1, `dyn-${c.id}-${randomUUID().slice(0, 6)}`.slice(0, 80)), material_types: [c.material_type], dynamic_fields: c.values } });
      const got = r.status === 201 ? { valid: true, errors: [] } : r.status === 422 && r.body?.code === "dynamic_fields_invalid" ? { valid: false, errors: r.body.details?.errors ?? [] } : { valid: null, errors: [] };
      const ok = got.valid === c.expect.valid && norm(got.errors) === norm(c.expect.errors);
      if (ok) server.matching++; else console.log(`FAIL server case ${c.id}: expected ${JSON.stringify(c.expect)} got status ${r.status} ${JSON.stringify(r.body?.details ?? r.body?.code ?? "")}`);
    }
    // an old draft (made under the old version) is completed with the newer version and its values
    const good = suite.cases.find((c) => c.id === "all-fields-valid");
    const bad = await http.call(tokens.reporter, "PATCH", `/materials/${oldMaterial.id}`, { body: { form_version: old + 1, dynamic_fields: { headline: "x" } } });
    server.checks.old_draft_invalid_completion_rejected = bad.status === 422;
    const done = await http.call(tokens.reporter, "PATCH", `/materials/${oldMaterial.id}`, { body: { form_version: old + 1, dynamic_fields: good.values } });
    server.checks.old_draft_completed_with_new_version = done.status === 200 && done.body.form_version === old + 1;
    for (const [k, v] of Object.entries(server.checks)) if (!v) console.log(`FAIL server check ${k}`);
  }
  const serverFailed = server.ran && (server.matching !== server.cases || Object.values(server.checks).some((v) => !v));

  const names = verdicts.map((v) => v.platform);
  console.log(`reference ${suite.cases.length - refWrong.length}/${suite.cases.length}; platforms: ${verdicts.map((v) => `${v.platform} ${suite.cases.length - v.wrong.length}/${suite.cases.length}`).join(", ") || "none supplied"}`);

  const failed = serverFailed || formProblems.length + refWrong.length + verdicts.reduce((n, v) => n + v.wrong.length, 0) > 0;
  const threeClients = ["web", "ios", "android"].every((p) => names.includes(p));
  const threeIdentical = !failed && ["web", "ios", "android"].every((p) => names.includes(p));
  finish(doc, failed ? "fail" : server.ran && threeIdentical ? "pass" : "partial", {
    conformance_cases: suite.cases.length,
    reference_cases_matching: suite.cases.length - refWrong.length,
    platforms_judged: names.join(",") || "none",
    all_three_clients_identical: !failed && threeClients,
    server_checked_live: server.ran,
    server_cases_matching: server.ran ? server.matching : "n/a",
    ...Object.fromEntries(Object.entries(server.checks).map(([k, v]) => [`server_${k}`, v])),
  }, [server.ran ? "الخادم الحي: النشر والبوابة v0 والتاريخ المقروء وإكمال المسودة القديمة وكل حالات المطابقة المشتركة عبر POST /materials" : "الجزء الخادمي الحي لم يُشغَّل (DYN_API_URL)",
      threeIdentical ? null : "لم تُقدَّم نتائج الواجهات الثلاث (web وios وandroid) متطابقة بعد، فلا يُدّعى المعيار كاملًا"].filter(Boolean).join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: names.length ? names.join("-") : "reference" }));
  return { code: failed ? 1 : 0, doc };
}
