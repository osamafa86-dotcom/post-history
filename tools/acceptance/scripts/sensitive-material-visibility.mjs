// اختبار القبول 10 (كشف البيانات الكاشفة): المادة الموسومة بالحساسية لا تظهر في القوائم ولا تُتاح للتصدير.
// يستخدم علم حساسية اصطناعيًا فقط، بلا موقع أو اسم مصدر أو ملف حقيقي، ويفحص معرّف المادة في كل استجابة قائمة متاحة.
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody } from "../lib/live.mjs";

const containsId = (body, id) => JSON.stringify(body)?.includes(id) ?? false;

export async function checkSensitiveVisibility({ http, tokens }) {
  const fails = [];
  let listChecks = 0;
  let exportChecks = 0;
  let occurrences = 0;
  const check = (name, ok, detail = "") => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ""}`); };
  const form = await http.get(tokens.reporter, "/forms/current");
  check("current form", form.status === 200, `status ${form.status}`);
  if (form.status !== 200) return { fails, metrics: { list_endpoints_checked: 0, export_endpoints_checked: 0, failures: fails.length } };
  const created = await http.call(tokens.reporter, "POST", "/materials", {
    body: materialBody(form.body.version, `sensitive-visibility-${randomUUID()}`, { sensitivity: { minors: false, injured: false, graphic: true } }), key: randomUUID(),
  });
  check("sensitive synthetic material created", created.status === 201, `status ${created.status}`);
  if (created.status !== 201) return { fails, metrics: { list_endpoints_checked: 0, export_endpoints_checked: 0, failures: fails.length } };
  const id = created.body.id;
  check("sensitivity flag persisted", created.body.sensitivity?.graphic === true);

  for (const [role, token] of Object.entries(tokens)) {
    for (const path of ["/materials?limit=100", "/catalog?limit=100", "/dashboard/newsroom"]) {
      const response = await http.get(token, path);
      if (response.status === 401 || response.status === 403 || response.status === 404) continue;
      listChecks++;
      check(`${role} list ${path}`, response.status === 200, `status ${response.status}`);
      if (containsId(response.body, id)) {
        occurrences++;
        check(`${role} hides sensitive material from ${path}`, false, "material id present");
      }
    }
  }

  const exportRole = ["producer", "editor_in_chief", "rights_officer", "system_admin"].find((r) => tokens[r]);
  if (exportRole) {
    const token = tokens[exportRole];
    for (const path of [`/materials/${id}/export`, `/materials/${id}/export/download-url`]) {
      const response = await http.get(token, path);
      exportChecks++;
      check(`sensitive material has no readable export via ${path}`, response.status === 403 || response.status === 404 || response.status === 422, `status ${response.status}`);
      if (containsId(response.body, id) && response.status === 200) occurrences++;
    }
    const requested = await http.call(token, "POST", `/materials/${id}/export`, { body: {}, key: randomUUID() });
    exportChecks++;
    check("sensitive material export request rejected", [403, 404, 422].includes(requested.status), `status ${requested.status}`);
  } else {
    check("export role available", false, "one of producer, editor_in_chief, rights_officer or system_admin is required");
  }
  return {
    fails,
    metrics: {
      roles_checked: Object.keys(tokens).length,
      list_endpoints_checked: listChecks,
      export_endpoints_checked: exportChecks,
      sensitive_id_occurrences: occurrences,
      failures: fails.length,
    },
  };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("sensitive-material-visibility"));
  if (!env.SENSITIVE_API_URL || !env.SENSITIVE_TOKENS) {
    console.error("ENVIRONMENT: SENSITIVE_API_URL and SENSITIVE_TOKENS are required; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.SENSITIVE_TOKENS);
  if (!tokens.reporter) throw new Error("SENSITIVE_TOKENS needs the reporter token and at least one export-capable role");
  const outcome = await checkSensitiveVisibility({ http: client(env.SENSITIVE_API_URL), tokens });
  const failed = outcome.fails.length > 0;
  outcome.fails.forEach((f) => console.log(`FAIL ${f}`));
  const doc = newResult("sensitive-material-visibility", { device: { platform: "server" }, upload_path: "n/a" });
  finish(doc, failed ? "fail" : "pass", outcome.metrics,
    "ينشئ مادة اصطناعية موسومة بالحساسية ويفحص ظهور معرّفها في قوائم الأدوار المتاحة، ويرفض أي حالة تصدير أو رابط تنزيل أو طلب تصدير ناجح.");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "lists-and-export" }));
  return { code: failed ? 1 : 0, doc };
}
