// tenant-isolation: every attempt to reach another scope's files, search results and invoices fails.
// Three layers, all derived from the contract so a new operation without an x-roles line, or a role missing from RoleName,
// fails here before any server exists: role access (x-roles), ownership/office scope and buyer organizations (out of scope
// = 404, never 403), and permission masking (x-permissions). Organization isolation (v0.3): a buyer of one organization
// reaches no order, invoice (the order and its refunds), licence, download link, organization profile or member list of
// another, and no listing that is not on sale (draft or suspended: staff-only catalog views); its lists carry none of them.
//
// Live mode: TENANT_BASE_URL=http://127.0.0.1:3000/v1
//   TENANT_TOKENS='{"reporter":"…","supervisor":"…","producer":"…","finance":"…","buyer_admin":"…",…}'  one token per RoleName
//   TENANT_FIXTURES='{"other_reporter_material_id":"…","other_reporter_upload_id":"…","other_reporter_notification_id":"…","out_of_scope_material_id":"…",
//     "other_org_id":"…","other_org_order_id":"…","other_org_license_id":"…","unlisted_listing_id":"…","sensitive_field_keys":["…"]}'
//   (live/seed.mjs seeds the second organization, live/tenant-commerce.mjs its order, licence and a listing not on sale)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { loadWaivers } from "../lib/waivers.mjs";

const SELF_SESSION = new Set(["POST /auth/logout", "DELETE /auth/sessions"]);
const METHODS = ["get", "post", "put", "patch", "delete"];
// Resources whose out-of-scope access must answer 404 (never 403, which would confirm existence). `method` defaults to get;
// the writes listed here take no body, so a refusal cannot be mistaken for a validation error.
const SCOPED = [
  { prefix: "/materials/{id}", fixture: "other_reporter_material_id", actor: "reporter" },
  { prefix: "/uploads/{id}", fixture: "other_reporter_upload_id", actor: "reporter" },
  { prefix: "/notifications/{id}", fixture: "other_reporter_notification_id", actor: "reporter" },
  { prefix: "/materials/{id}", fixture: "out_of_scope_material_id", actor: "supervisor" },
  // buyer organizations (v0.3): another organization's order, invoice (the order and its refunds), licence and profile
  { prefix: "/orders/{order_id}", fixture: "other_org_order_id", actor: "buyer_admin" },
  { prefix: "/orders/{order_id}", fixture: "other_org_order_id", actor: "buyer_member" },
  { prefix: "/orders/{order_id}/refunds", fixture: "other_org_order_id", actor: "buyer_admin" },
  { prefix: "/orders/{order_id}/checkout", method: "post", fixture: "other_org_order_id", actor: "buyer_member" },
  { prefix: "/orders/{order_id}/cancel", method: "post", fixture: "other_org_order_id", actor: "buyer_member" },
  { prefix: "/licenses/{license_id}", fixture: "other_org_license_id", actor: "buyer_admin" },
  { prefix: "/licenses/{license_id}", fixture: "other_org_license_id", actor: "buyer_member" },
  { prefix: "/licenses/{license_id}/download-url", method: "post", fixture: "other_org_license_id", actor: "buyer_admin" },
  { prefix: "/buyer-organizations/{org_id}", fixture: "other_org_id", actor: "buyer_member" },
  { prefix: "/buyer-organizations/{org_id}/members", fixture: "other_org_id", actor: "buyer_admin" },
  // catalog views private to staff: a listing that is not on sale is missing for every buyer
  { prefix: "/catalog/{listing_id}", fixture: "unlisted_listing_id", actor: "buyer_member" },
  { prefix: "/catalog/{listing_id}/preview-url", fixture: "unlisted_listing_id", actor: "buyer_member" },
];
// Lists that must carry nothing of another scope: [path, role, fixtures whose ids must be absent]
const LISTS = [
  ["/materials", "reporter", ["other_reporter_material_id", "other_reporter_notification_id"]],
  ["/notifications", "reporter", ["other_reporter_material_id", "other_reporter_notification_id"]],
  ["/orders", "buyer_admin", ["other_org_order_id", "other_org_license_id"]],
  ["/licenses", "buyer_member", ["other_org_order_id", "other_org_license_id"]],
  ["/catalog", "buyer_member", ["unlisted_listing_id"]],
];

export function buildMatrix(api) {
  const problems = [];
  const roles = api.components?.schemas?.RoleName?.enum ?? [];
  if (!roles.length) problems.push({ source: "components.schemas.RoleName", path: "enum", kind: "missing-role-enum" });
  const cases = [];
  const ops = [];

  for (const [path, item] of Object.entries(api.paths ?? {})) {
    for (const method of METHODS.filter((m) => item[m])) {
      const op = item[method];
      const id = `${method.toUpperCase()} ${path}`;
      if (path.startsWith("/internal/")) continue; // network-isolated hooks, covered by the SEC-06 tests
      // these revoke the caller's own session(s): sending them in a role sweep would log the test tokens out.
      // Their access rules are covered by the server's auth tests.
      if (SELF_SESSION.has(id)) continue;
      if (!Array.isArray(op["x-roles"])) { problems.push({ source: id, path: "x-roles", kind: "missing-x-roles" }); continue; }
      const allowed = op["x-roles"];
      const unknown = allowed.filter((r) => r !== "authenticated" && !roles.includes(r));
      if (unknown.length) problems.push({ source: id, path: "x-roles", kind: `unknown-role:${unknown.join(",")}` });
      if (allowed.length && !op.responses?.["401"]) problems.push({ source: id, path: "responses.401", kind: "missing-response" });
      if (allowed.length && !allowed.includes("authenticated") && !op.responses?.["403"]) problems.push({ source: id, path: "responses.403", kind: "missing-response" });
      ops.push({ id, method, path, allowed, permissions: op["x-permissions"] ?? [] });
    }
  }

  for (const op of ops) {
    if (!op.allowed.length) continue; // public operation: covered by rate-limit and auth tests, not isolation
    cases.push({ kind: "anonymous", op: op.id, method: op.method, path: op.path, role: null, expect: "401" });
    for (const role of roles) {
      const permitted = op.allowed.includes("authenticated") || op.allowed.includes(role);
      cases.push({ kind: "role", op: op.id, method: op.method, path: op.path, role, expect: permitted ? "not-401-403" : "403" });
    }
    if (op.permissions.length) {
      cases.push({ kind: "permission-masking", op: op.id, method: op.method, path: op.path, role: "reporter", expect: "no-sensitive-values", permissions: op.permissions });
    }
  }
  for (const s of SCOPED) {
    const method = s.method ?? "get";
    for (const op of ops.filter((o) => o.path === s.prefix && o.method === method)) {
      cases.push({ kind: "scope", op: op.id, method, path: op.path, role: s.actor, fixture: s.fixture, expect: "404" });
    }
  }
  for (const [listPath, role, fixtures] of LISTS) {
    if (ops.some((o) => o.path === listPath && o.method === "get")) {
      cases.push({ kind: "list-leak", op: `GET ${listPath}`, method: "get", path: listPath, role, expect: "no-foreign-items", fixtures });
    }
  }
  return { cases, problems, roles, operations: ops.length };
}

export async function execute(cases, { baseUrl, tokens, fixtures, fetchImpl = fetch }) {
  const results = [];
  const url = (p, id) => baseUrl.replace(/\/$/, "") + p.replace(/\{[^}]+\}/g, () => id ?? randomUUID());
  // A route the server does not have answers 404 even without credentials; an implemented, protected one answers 401.
  // Such operations are reported as unimplemented rather than failed, and they keep the result at "partial".
  const exists = new Map();
  const routeExists = async (c) => {
    const key = `${c.method} ${c.path}`;
    if (!exists.has(key)) {
      const write = c.method !== "get";
      const res = await fetchImpl(url(c.path), { method: c.method.toUpperCase(), headers: write ? { "idempotency-key": randomUUID(), "content-type": "application/json" } : {}, body: write ? "{}" : undefined });
      await res.text();
      exists.set(key, res.status !== 404);
    }
    return exists.get(key);
  };
  for (const c of cases) {
    if (!(await routeExists(c))) { results.push({ ...c, outcome: "unimplemented", why: "route not served (404 without credentials)" }); continue; }
    if (c.kind !== "anonymous" && !tokens[c.role]) { results.push({ ...c, outcome: "skipped", why: `no token for ${c.role}` }); continue; }
    if (c.fixture && !fixtures[c.fixture]) { results.push({ ...c, outcome: "skipped", why: `no fixture ${c.fixture}` }); continue; }
    const headers = { accept: "application/json" };
    if (c.role) headers.authorization = `Bearer ${tokens[c.role]}`;
    const write = c.method !== "get";
    if (write) { headers["idempotency-key"] = randomUUID(); headers["content-type"] = "application/json"; }
    const res = await fetchImpl(url(c.path, c.fixture && fixtures[c.fixture]), { method: c.method.toUpperCase(), headers, body: write ? "{}" : undefined });
    const text = await res.text();
    let ok;
    let why = `status ${res.status}`;
    if (c.expect === "401") ok = res.status === 401;
    else if (c.expect === "403") ok = res.status === 403;
    else if (c.expect === "404") ok = res.status === 404;
    else if (c.expect === "not-401-403") ok = res.status !== 401 && res.status !== 403 && res.status < 500;
    else if (c.expect === "no-sensitive-values") {
      const keys = fixtures.sensitive_field_keys ?? [];
      ok = !keys.some((k) => text.includes(`"${k}"`));
      why = keys.length ? "sensitive key present" : "no sensitive_field_keys fixture";
      if (!keys.length) { results.push({ ...c, outcome: "skipped", why }); continue; }
    } else if (c.expect === "no-foreign-items") {
      const foreign = (c.fixtures ?? []).map((f) => fixtures[f]).filter(Boolean);
      if (!foreign.length) { results.push({ ...c, outcome: "skipped", why: `no fixture ${c.fixtures.join("/")}` }); continue; }
      ok = !foreign.some((id) => text.includes(id));
      why = "foreign item id present in list";
    }
    results.push({ ...c, outcome: ok ? "pass" : "fail", why: ok ? undefined : why });
  }
  return results;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  banner(byName("tenant-isolation"));
  const doc = newResult("tenant-isolation", { device: { platform: "server" }, upload_path: "n/a" });
  const api = YAML.parse(readFileSync(join(ROOT, "contracts/openapi.yaml"), "utf8"));
  const m = buildMatrix(api);
  const W = loadWaivers("tenant-isolation");
  const open = m.problems.filter((p) => !W.isWaived(p));
  const stale = W.stale(m.problems);
  m.problems.forEach((p) => console.log(`${W.isWaived(p) ? "WAIVED" : "CONTRACT"} ${p.kind} ${p.source} ${p.path}`));
  stale.forEach((w) => console.log(`STALE WAIVER (remove it): ${w.kind} ${w.source} ${w.path}`));
  const byKind = Object.fromEntries([...new Set(m.cases.map((c) => c.kind))].map((k) => [k, m.cases.filter((c) => c.kind === k).length]));
  console.log(`matrix: ${m.operations} operations, ${m.cases.length} cases`, byKind);
  if (args["emit-matrix"]) { (await import("node:fs")).writeFileSync(args["emit-matrix"], JSON.stringify(m.cases, null, 2)); }

  let exec = null;
  if (process.env.TENANT_BASE_URL) {
    exec = await execute(m.cases, {
      baseUrl: process.env.TENANT_BASE_URL,
      tokens: JSON.parse(process.env.TENANT_TOKENS ?? "{}"),
      fixtures: JSON.parse(process.env.TENANT_FIXTURES ?? "{}"),
    });
    exec.filter((r) => r.outcome === "fail").forEach((r) => console.log(`FAIL ${r.kind} ${r.op} as ${r.role ?? "anonymous"} expected ${r.expect}: ${r.why}`));
  }
  const failed = exec?.filter((r) => r.outcome === "fail").length ?? 0;
  const skipped = exec?.filter((r) => r.outcome === "skipped").length ?? 0;
  const unimplemented = exec?.filter((r) => r.outcome === "unimplemented").length ?? 0;
  const executed = exec ? exec.length - skipped - unimplemented : 0;
  const waivedCount = m.problems.length - open.length;
  const result = open.length || stale.length || failed ? "fail" : exec && executed === m.cases.length && !waivedCount ? "pass" : "partial";
  finish(doc, result, {
    operations: m.operations, cases_total: m.cases.length, ...Object.fromEntries(Object.entries(byKind).map(([k, v]) => [`cases_${k.replace(/-/g, "_")}`, v])),
    contract_problems_open: open.length, contract_problems_waived: waivedCount, cases_executed: executed, cases_failed: failed, cases_skipped: skipped, cases_unimplemented: unimplemented, live_checked: Boolean(exec),
  }, [exec ? null : "هيكل الحالات من العقد فقط؛ التنفيذ ضد الخادم لم يجرِ بعد فالنتيجة جزئية",
      waivedCount ? `${waivedCount} ثغرة توثيق في العقد مُستثناة بإذن مكتوب في waivers/tenant-isolation.json` : null,
      "عزل المؤسسات: مؤسسة مشترية ثانية بطلب وترخيص لها وإدراج غير معروض؛ طلبها وفاتورتها (الطلب واستردادته) وترخيصها ورابط تنزيله وملفها وأعضاؤها والإدراج غير المعروض 404 لمشتري المؤسسة الأولى، وقوائمه بلا شيء منها",
      "لم يُقَس: فهارس البحث والنسخ المؤقتة خارج الواجهة لا وجود لها في الخادم اليوم (البحث استعلام على القاعدة نفسها)، فالعزل يُقاس على ما تعيده الواجهة"].filter(Boolean).join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: exec ? "live" : "matrix" }));
  return { code: result === "fail" ? 1 : 0, doc };
}
