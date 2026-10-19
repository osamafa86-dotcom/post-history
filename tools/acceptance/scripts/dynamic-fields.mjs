// dynamic-fields: new form version publishes with old records still readable, old phone drafts complete,
// and the conformance result is identical on the three clients.
// This script covers the shared-conformance part: it judges every platform result file given with
//   --platforms=web.json,ios.json,android.json   (each produced by that client from form-conformance/cases.json)
// The server parts (publish with readable history, completing old drafts) need the API and are not claimed here.
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { readFileSync } from "node:fs";
import { loadSuite, checkForms, judge, runReference } from "../form-conformance/run.mjs";

export async function run(argv = process.argv.slice(2)) {
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
  const names = verdicts.map((v) => v.platform);
  console.log(`reference ${suite.cases.length - refWrong.length}/${suite.cases.length}; platforms: ${verdicts.map((v) => `${v.platform} ${suite.cases.length - v.wrong.length}/${suite.cases.length}`).join(", ") || "none supplied"}`);

  const failed = formProblems.length + refWrong.length + verdicts.reduce((n, v) => n + v.wrong.length, 0) > 0;
  const threeClients = ["web", "ios", "android"].every((p) => names.includes(p));
  finish(doc, failed ? "fail" : "partial", {
    conformance_cases: suite.cases.length,
    reference_cases_matching: suite.cases.length - refWrong.length,
    platforms_judged: names.join(",") || "none",
    all_three_clients_identical: !failed && threeClients,
    server_publish_and_old_drafts_checked: false,
  }, "الجزء المشترك فقط (اختبار المطابقة)؛ نشر الإصدار مع بقاء السجلات القديمة قابلة للقراءة وإكمال المسودات القديمة يحتاجان الخادم ولم يُقاسا بعد");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: names.length ? names.join("-") : "reference" }));
  return { code: failed ? 1 : 0, doc };
}
