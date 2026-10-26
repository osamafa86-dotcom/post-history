// ثابت الكتالوج التجاري: وسم الحساسية يعلّق الإدراج المعروض، فلا يظهر في بحث المشتري ولا في قراءته المباشرة.
// لا يشترط إخفاء المادة عن المراسل أو المشرف؛ الحساسية التحريرية تخص التمويه والتحذير ومسار المعالجة.
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { canon, client, materialBody } from "../lib/live.mjs";

const hasListing = (body, id) => (body?.items ?? []).some((item) => item.listing_id === id);

export async function checkSensitiveVisibility({ http, tokens }) {
  const fails = [];
  let catalogChecks = 0;
  let positiveControlVisible = false;
  let sensitiveOccurrences = 0;
  const check = (name, ok, detail = "") => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ""}`); };
  const expect = async (name, response, status) => {
    check(name, response.status === status, `status ${response.status}, expected ${status}`);
    return response;
  };
  const required = ["reporter", "rights_officer", "system_admin", "buyer_admin"];
  for (const role of required) check(`required role ${role}`, Boolean(tokens[role]), "token missing");
  if (required.some((role) => !tokens[role])) {
    return { fails, metrics: { catalog_checks: 0, positive_control_visible: false, failures: fails.length } };
  }

  const me = await expect("buyer identity", await http.get(tokens.buyer_admin, "/auth/me"), 200);
  const organizationId = me.body?.organization_id;
  check("buyer belongs to an organization", typeof organizationId === "string" && organizationId.length > 0);
  if (organizationId) {
    const organization = await expect("buyer organization readable", await http.get(tokens.buyer_admin, `/buyer-organizations/${organizationId}`), 200);
    check("buyer organization active", organization.body?.status === "active", `status ${organization.body?.status}`);
  }

  const form = await expect("current form", await http.get(tokens.reporter, "/forms/current"), 200);
  if (form.status !== 200) return { fails, metrics: { catalog_checks: 0, positive_control_visible: false, failures: fails.length } };
  const marker = `catalog-sensitive-${randomUUID()}`;
  const createMaterial = async (suffix) => {
    const response = await http.call(tokens.reporter, "POST", "/materials", {
      body: materialBody(form.body.version, `${marker}-${suffix}`), key: randomUUID(),
    });
    await expect(`${suffix} synthetic material`, response, 201);
    return response.body?.id;
  };
  const controlId = await createMaterial("control");
  const sensitiveId = await createMaterial("sensitive");
  if (!controlId || !sensitiveId) return { fails, metrics: { catalog_checks: 0, positive_control_visible: false, failures: fails.length } };

  for (const id of [controlId, sensitiveId]) {
    for (const to of ["documented", "sellable"]) {
      await expect(`rights ${to}`, await http.call(tokens.rights_officer, "POST", `/materials/${id}/transitions`, {
        body: { track: "rights", to, reason: "synthetic catalog invariant" }, key: randomUUID(),
      }), 200);
    }
  }

  const template = await http.call(tokens.rights_officer, "POST", "/license-templates", {
    body: {
      type: "editorial_single", name: { ar: "ترخيص اختبار", en: "Acceptance licence" },
      terms: { ar: "شروط اصطناعية", en: "Synthetic terms" }, usage_media: ["web"],
      territory: { kind: "worldwide" }, term_days: null, exclusivity_hours: null,
      deliverables: ["original"], attribution: { ar: "الشبكة", en: "Network" }, prohibitions: [],
      base_price: { amount_minor: 1000, currency: "USD" }, enabled: true,
    }, key: randomUUID(),
  });
  await expect("editorial licence template", template, 201);

  const createListing = async (id, suffix) => {
    const response = await http.call(tokens.rights_officer, "POST", `/materials/${id}/listing`, {
      body: {
        title: { ar: `${marker}-${suffix}`, en: `${marker}-${suffix}` },
        description: { ar: "وصف اصطناعي", en: "Synthetic description" }, shot_list: [],
        offers: [{ license_template_id: template.body?.id, price_override: null }], state: "listed",
      }, key: randomUUID(),
    });
    await expect(`${suffix} listed with an offer`, response, 201);
    return response.body?.id;
  };
  const controlListing = await createListing(controlId, "control");
  const sensitiveListing = await createListing(sensitiveId, "sensitive");

  if (controlListing && sensitiveListing) {
    const flagged = await http.call(tokens.system_admin, "PATCH", `/materials/${sensitiveId}`, {
      body: { sensitivity: { minors: false, injured: false, graphic: true } }, key: randomUUID(),
    });
    await expect("sensitivity flag applied", flagged, 200);
    check("sensitivity flag persisted", flagged.body?.sensitivity?.graphic === true);
    const staffListing = await expect("staff listing remains readable", await http.get(tokens.rights_officer, `/materials/${sensitiveId}/listing`), 200);
    check("sensitive listing suspended", staffListing.body?.state === "suspended" && staffListing.body?.suspended_reason === "sensitive_flagged");

    const search = await expect("buyer catalog search", await http.get(tokens.buyer_admin, `/catalog?q=${encodeURIComponent(marker)}&limit=100`), 200);
    if (search.status === 200) catalogChecks++;
    const controlVisible = search.status === 200 && hasListing(search.body, controlListing);
    positiveControlVisible = controlVisible;
    if (search.status === 200 && hasListing(search.body, sensitiveListing)) sensitiveOccurrences++;
    check("non-sensitive offered control appears in search", controlVisible);
    check("sensitive listing absent from the same search", search.status === 200 && !hasListing(search.body, sensitiveListing));

    const controlDirect = await expect("offered control direct read", await http.get(tokens.buyer_admin, `/catalog/${controlListing}`), 200);
    if (controlDirect.status === 200) catalogChecks++;
    check("direct control is the same listing", controlDirect.body?.listing_id === controlListing);

    const sensitiveDirect = await http.get(tokens.buyer_admin, `/catalog/${sensitiveListing}`);
    const unknownDirect = await http.get(tokens.buyer_admin, `/catalog/${randomUUID()}`);
    await expect("sensitive direct read is not found", sensitiveDirect, 404);
    await expect("unknown-listing route control", unknownDirect, 404);
    if (sensitiveDirect.status === 404 && unknownDirect.status === 404) catalogChecks += 2;
    check("sensitive 404 has the missing-listing shape", canon(sensitiveDirect.body) === canon(unknownDirect.body));
  } else {
    check("both catalog fixtures created", false, "cannot run buyer reads without two listing ids");
  }

  // لا نجاح فارغ: البحث والقراءة المباشرة والضابط الإيجابي وضابط 404 كلها إلزامية.
  check("minimum real catalog checks", catalogChecks >= 4, `only ${catalogChecks} executed`);
  return {
    fails,
    metrics: {
      catalog_checks: catalogChecks,
      positive_control_visible: positiveControlVisible,
      sensitive_id_occurrences: sensitiveOccurrences,
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
  const outcome = await checkSensitiveVisibility({ http: client(env.SENSITIVE_API_URL), tokens });
  const failed = outcome.fails.length > 0;
  outcome.fails.forEach((f) => console.log(`FAIL ${f}`));
  const doc = newResult("sensitive-material-visibility", { device: { platform: "server" }, upload_path: "n/a" });
  finish(doc, failed ? "fail" : "pass", outcome.metrics,
    "يثبت الثابت التجاري فقط: مادتان اصطناعيتان معروضتان بعرض ترخيص؛ بعد وسم إحداهما بالحساسية تغيب من بحث المشتري وقراءته المباشرة بشكل 404 نفسه، بينما تبقى المادة الضابطة غير الموسومة ظاهرة. لا يقيس إخفاءها التحريري أو التصدير.");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "catalog" }));
  return { code: failed ? 1 : 0, doc };
}
