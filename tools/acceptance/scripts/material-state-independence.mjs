// اختبار القبول 14 (الحقوق والحصرية): الحالات الفنية والتحريرية والحقوق مستقلة ولكل انتقال سجل خاص.
// لا يستدعي انتقالات فنية يملكها الخادم؛ يثبت أن الانتقالين التحريري والحقوقي لا يغيّران المسارين الآخرين.
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody } from "../lib/live.mjs";

export async function checkStateIndependence({ http, tokens }) {
  const fails = [];
  const check = (name, ok, detail = "") => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ""}`); };
  const form = await http.get(tokens.reporter, "/forms/current");
  check("current form", form.status === 200, `status ${form.status}`);
  if (form.status !== 200) return { fails, metrics: { transitions_checked: 0, failures: fails.length } };
  const created = await http.call(tokens.reporter, "POST", "/materials", {
    body: materialBody(form.body.version, `state-independence-${randomUUID()}`), key: randomUUID(),
  });
  check("material created", created.status === 201, `status ${created.status}`);
  if (created.status !== 201) return { fails, metrics: { transitions_checked: 0, failures: fails.length } };
  const id = created.body.id;
  check("three initial states", created.body.technical_state === "pending" && created.body.editorial_state === "inbox" && created.body.rights_state === "unknown",
    `${created.body.technical_state}/${created.body.editorial_state}/${created.body.rights_state}`);

  const editorial = await http.call(tokens.supervisor, "POST", `/materials/${id}/transitions`, {
    body: { track: "editorial", to: "acknowledged", reason: "synthetic editorial acceptance" }, key: randomUUID(),
  });
  check("editorial transition", editorial.status === 200, `status ${editorial.status}`);
  check("editorial changes only editorial", editorial.body?.editorial_state === "acknowledged" && editorial.body?.technical_state === "pending" && editorial.body?.rights_state === "unknown",
    `${editorial.body?.technical_state}/${editorial.body?.editorial_state}/${editorial.body?.rights_state}`);

  const rights = await http.call(tokens.rights_officer, "POST", `/materials/${id}/transitions`, {
    body: { track: "rights", to: "documented", reason: "synthetic rights documentation" }, key: randomUUID(),
  });
  check("rights transition", rights.status === 200, `status ${rights.status}`);
  check("rights changes only rights", rights.body?.rights_state === "documented" && rights.body?.technical_state === "pending" && rights.body?.editorial_state === "acknowledged",
    `${rights.body?.technical_state}/${rights.body?.editorial_state}/${rights.body?.rights_state}`);

  const read = await http.get(tokens.reporter, `/materials/${id}`);
  check("states persist independently", read.status === 200 && read.body?.technical_state === "pending" && read.body?.editorial_state === "acknowledged" && read.body?.rights_state === "documented",
    `status ${read.status}`);
  const log = await http.get(tokens.reporter, `/materials/${id}/transitions`);
  const items = log.body?.items ?? [];
  check("transition log", log.status === 200 && items.length === 2, `status ${log.status}, entries ${items.length}`);
  check("transition log keeps tracks separate", items.some((t) => t.track === "editorial" && t.to === "acknowledged") && items.some((t) => t.track === "rights" && t.to === "documented"));
  return {
    fails,
    metrics: {
      transitions_checked: 2,
      technical_state_unchanged: read.body?.technical_state === "pending",
      editorial_state: read.body?.editorial_state ?? "unknown",
      rights_state: read.body?.rights_state ?? "unknown",
      transition_records: items.length,
      failures: fails.length,
    },
  };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("material-state-independence"));
  if (!env.STATE_API_URL || !env.STATE_TOKENS) {
    console.error("ENVIRONMENT: STATE_API_URL and STATE_TOKENS are required; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.STATE_TOKENS);
  if (!tokens.reporter || !tokens.supervisor || !tokens.rights_officer) throw new Error("STATE_TOKENS needs reporter, supervisor and rights_officer tokens");
  const outcome = await checkStateIndependence({ http: client(env.STATE_API_URL), tokens });
  const failed = outcome.fails.length > 0;
  outcome.fails.forEach((f) => console.log(`FAIL ${f}`));
  const doc = newResult("material-state-independence", { device: { platform: "server" }, upload_path: "n/a" });
  finish(doc, failed ? "fail" : "pass", outcome.metrics,
    "ينشئ مادة اصطناعية ويُجري انتقالًا تحريريًا ثم حقوقيًا، ويقرأ المادة وسجل الانتقالات للتحقق من بقاء الحالة الفنية وعدم دمج المسارات.");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "three-tracks" }));
  return { code: failed ? 1 : 0, doc };
}
