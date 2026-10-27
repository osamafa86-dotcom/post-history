// خادم بيانات اصطناعية للاختبار والقياس المحلي فقط؛ لا يدخل حزمة التطبيق.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { form, material, me, tokens } from "../tests/fixtures";
import assets from "../tests/media-fixture.json";
import type { Form, Me, Material, Notification, TransitionRecord, PermissionHistoryEntry, ReporterIdentitySetting, ReporterIdentitySettingUpdate, Permission } from "../src/lib/types";
const materials: Material[] = [], notifications: Notification[] = [], history = new Map<string, TransitionRecord[]>();
const writes: { path: string; method: string; key: string; body: Record<string, unknown> }[] = [];
const applied = new Map<string, { fingerprint: string; value: unknown; status: number }>();
const formVersions = new Map<number, Form>();
let dropNextWrite = false, extraUploadsInProgress = 0;
let identitySetting: ReporterIdentitySetting, historyUnavailable = false, auditSequence = 21;
const permissionAudit: { target: string | null; entry: PermissionHistoryEntry }[] = [];
function reset() {
  formVersions.clear(); formVersions.set(form.version, { ...structuredClone(form), published_at: "2026-10-20T12:00:00Z", published_by: me.user_id });
  materials.splice(0, materials.length, ...Array.from({ length: 200 }, (_, i) => ({ ...material(i + 1), row_version: 17, reserved_by: null, reserved_at: null, contributors: [{ user_id: me.user_id, role: "reporter" as const, share_percent: 100 }] })));
  Object.assign(materials[4], { reserved_by: "10000000-0000-4000-8000-000000000002", reserved_by_name: "Synthetic staff", acknowledgement_due_at: new Date(Date.now() - 123000).toISOString() });
  materials[1].editorial_state = "accepted"; materials[2].technical_state = "failed";
  notifications.splice(0, notifications.length, ...Array.from({ length: 3 }, (_, i) => ({ id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, type: "never-display-canary", title: "never-display-canary", material_id: materials[i].id, priority: "normal" as const, state: "sent" as const, created_at: "2026-10-20T12:00:00Z" })));
  history.clear(); writes.length = 0; applied.clear(); dropNextWrite = false; extraUploadsInProgress = 0;
  identitySetting = { access: "separate", updated_at: "2026-10-21T10:00:00Z", updated_by: null }; historyUnavailable = false; auditSequence = 21;
  permissionAudit.splice(0, permissionAudit.length, ...Array.from({ length: 21 }, (_, i) => ({ target: "10000000-0000-4000-8000-000000000002", entry: { id: String(21 - i), kind: i % 2 ? "permission_revoked" as const : "permission_granted" as const, permission: "reporter_identity:read" as const, actor_id: me.user_id, occurred_at: new Date(Date.parse(identitySetting.updated_at) - i * 1000).toISOString(), reason_code: null } })));
}
// الرفع من الحاسوب (#88): جلسات رفع وخادم tus اصطناعي بفحص رمز ingest كالبوابة، وCORS لأصل الويب وحده.
type FixtureUpload = { session: Record<string, unknown> & { id: string; material_id: string; state: string; size_bytes: number; bytes_received: number; receipt_number: string | null; failure_reason: string | null }; sha: string; token: string; tus?: string };
const uploads = new Map<string, FixtureUpload>(), tusFiles = new Map<string, { sid: string; length: number; offset: number; hash: ReturnType<typeof createHash>; patches: number; resent: number; cuts: number }>();
const ingestTokens = new Map<string, { sid: string; expires: number }>();
const tusFaults = { rejectIngest: 0, failPatches: 0, cutNext: false, revoked: false };
const webOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3100", fixtureOrigin = `http://127.0.0.1:${process.env.WEB_FIXTURE_PORT ?? 3201}`;
function resetUploads() { uploads.clear(); tusFiles.clear(); ingestTokens.clear(); Object.assign(tusFaults, { rejectIngest: 0, failPatches: 0, cutNext: false, revoked: false }); }
function finishUpload(upload: FixtureUpload, digest: string) {
  const item = materials.find(m => m.id === upload.session.material_id);
  if (digest !== upload.sha) { Object.assign(upload.session, { state: "failed", failure_reason: "checksum_mismatch" }); if (item) item.technical_state = "failed"; return; }
  const receipt = `R-261021-${String(uploads.size).padStart(6, "0")}`;
  Object.assign(upload.session, { state: "verified", receipt_number: receipt, bytes_received: upload.session.size_bytes });
  if (item) { item.technical_state = "verified"; item.files = [{ id: randomUUID(), kind: "original", state: "verified", mime_type: "video/quicktime", receipt_number: receipt, created_at: new Date().toISOString() }]; }
}
async function tus(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) {
  res.setHeader("Access-Control-Allow-Origin", webOrigin); res.setHeader("Vary", "Origin"); res.setHeader("Tus-Resumable", "1.0.0");
  res.setHeader("Access-Control-Expose-Headers", "Location, Upload-Offset, Upload-Length, Tus-Resumable");
  const end = (status: number, headers: Record<string, string | number> = {}) => { res.statusCode = status; for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(); };
  if (req.method === "OPTIONS") return end(204, { "Access-Control-Allow-Methods": "POST, HEAD, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Ingest-Token, Tus-Resumable, Upload-Length, Upload-Metadata, Upload-Offset, Content-Type", "Access-Control-Max-Age": 600 });
  const id = url.pathname.slice("/files/".length), file = tusFiles.get(id);
  const metadata = Object.fromEntries(String(req.headers["upload-metadata"] ?? "").split(",").filter(Boolean).map(pair => { const [k, v = ""] = pair.trim().split(" "); return [k, Buffer.from(v, "base64").toString()]; }));
  const sid = file?.sid ?? metadata.upload_session_id, grant = ingestTokens.get(String(req.headers["ingest-token"] ?? ""));
  // البوابة: رمز ingest صالح لهذه الجلسة وحدها، وإلا 401 (يطلب العميل رمزًا جديدًا).
  if (tusFaults.rejectIngest > 0 && req.method === "PATCH") { tusFaults.rejectIngest--; return end(401); }
  if (!grant || grant.sid !== sid || grant.expires < Date.now()) return end(401);
  // فحص حالة الجلسة عند البوابة (SEC-01): جلسة دخول مبطلة 403 حتى مع رمز صالح.
  if (tusFaults.revoked) return end(403);
  const upload = uploads.get(sid);
  if (!upload || ["failed", "verified"].includes(upload.session.state)) return end(403);
  if (req.method === "POST" && !id) {
    if (req.headers.authorization !== `Bearer ${upload.token}` || upload.tus) return end(403);
    const created = randomUUID(); upload.tus = created; upload.session.state = "in_progress";
    tusFiles.set(created, { sid, length: Number(req.headers["upload-length"]), offset: 0, hash: createHash("sha256"), patches: 0, resent: 0, cuts: 0 });
    return end(201, { Location: `${fixtureOrigin}/files/${created}` });
  }
  if (!file) return end(404);
  if (req.method === "HEAD") return end(200, { "Upload-Offset": file.offset, "Upload-Length": file.length, "Cache-Control": "no-store" });
  if (req.method === "DELETE") { tusFiles.delete(id); Object.assign(upload.session, { state: "failed", failure_reason: "aborted" }); return end(204); }
  if (req.method !== "PATCH") return end(405);
  const offset = Number(req.headers["upload-offset"]);
  if (offset !== file.offset) { file.resent++; return end(409); }
  if (tusFaults.failPatches > 0 && file.offset > 0) { tusFaults.failPatches--; req.resume(); return end(503); }
  file.patches++;
  let received = 0; const cut = tusFaults.cutNext; tusFaults.cutNext = false;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    file.hash.update(chunk); file.offset += chunk.length; received += chunk.length;
    upload.session.bytes_received = file.offset;
    // قطع متعمد للاتصال بعد بعض الجزء: ما وصل يُحفظ والإزاحة تتقدم بقدره، كما في tusd.
    if (cut && received >= 65536) { file.cuts++; req.socket.destroy(); return; }
  }
  if (file.offset === file.length) { upload.session.state = "completed"; finishUpload(upload, file.hash.copy().digest("hex")); }
  return end(204, { "Upload-Offset": file.offset });
}
// قواعد التنبيه (#203 بند 7): مراجعة صف لكل قاعدة كما في العقد.
const rules = new Map<string, Record<string, unknown> & { id: string; row_version: number }>();
// قوالب التراخيص: كل إصدار محفوظ، والحالي آخرها.
const listings = new Map<string, Record<string, unknown> & { row: number; state: string }>();
// مؤسسات المشترين: مؤسسة اصطناعية واحدة بمديرها وعضوها، وأخرى لا يراها أعضاء الأولى.
const buyerOrg = "90000000-0000-4000-8000-000000000001", otherOrg = "90000000-0000-4000-8000-000000000002";
const organizations = new Map<string, Record<string, unknown> & { id: string; row: number; seats: number }>(), members = new Map<string, (Record<string, unknown> & { user_id: string; role: string; status: string })[]>();
function seedOrganizations() {
  organizations.clear(); members.clear();
  const base = { country: "QA", billing_email: "billing@example.test", verified_at: "2026-10-22T10:00:00Z", created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-22T10:00:00Z" };
  organizations.set(buyerOrg, { ...base, id: buyerOrg, legal_name: "شبكة الأخبار الاصطناعية ذ.م.م", display_name: { ar: "شبكة الأخبار", en: "News Network" }, seats: 3, status: "active", row: 1 });
  organizations.set(otherOrg, { ...base, id: otherOrg, legal_name: "never-display-canary", display_name: { ar: "مؤسسة أخرى", en: "Other organization" }, seats: 5, status: "pending_verification", verified_at: null, row: 1 });
  members.set(buyerOrg, [{ user_id: "91000000-0000-4000-8000-000000000001", email: "buyeradmin@example.test", role: "buyer_admin", status: "active", totp_enabled: true, created_at: base.created_at }, { user_id: "91000000-0000-4000-8000-000000000002", email: "buyer@example.test", role: "buyer_member", status: "active", totp_enabled: true, created_at: base.created_at }]);
  members.set(otherOrg, []);
}
// تراخيص اصطناعية لمؤسسة المشتري: ساري جاهز للتنزيل بثلاث مرات، ومُبطل.
const issued = new Map<string, Record<string, unknown> & { id: string; organization_id: string; status: string; downloads: number }>();
function seedLicenses() {
  issued.clear();
  const terms = { type: "editorial_single", name: { ar: "تحريري لاستخدام واحد", en: "Editorial single use" }, terms: { ar: "استخدام تحريري واحد في نشرة إخبارية.", en: "One editorial use in a news bulletin." }, usage_media: ["tv", "web"], territory: { kind: "worldwide" }, term_days: null, exclusivity_hours: null, deliverables: ["original"], attribution: { ar: "فلسطين بوست", en: "Palestine Post" }, prohibitions: ["resale", "ai_training"] };
  const base = { order_id: "92000000-0000-4000-8000-000000000001", organization_id: "90000000-0000-4000-8000-000000000001", listing_id: "71000000-0000-4000-8000-000000000001", material_version: 1, license_template_id: "70000000-0000-4000-8000-000000000001", license_version: 1, terms, delivery_contents: [{ deliverable: "produced", mime_type: "video/mp4", count: 1, duration_ms: 65000, width: 1920, height: 1080 }], delivery_size_bytes: 1048576, price: { amount_minor: 15000, currency: "USD" }, valid_from: "2026-10-26T10:00:00Z", valid_until: null, exclusive_until: null, issued_at: "2026-10-26T10:00:00Z", internal_note: "never-display-canary" };
  issued.set("93000000-0000-4000-8000-000000000001", { ...base, id: "93000000-0000-4000-8000-000000000001", order_item_id: randomUUID(), license_number: "PH-2026-7K3M9Q2XRT", title: { ar: "لقطات اصطناعية 1", en: "Synthetic footage 1" }, status: "active", revoked_reason: null, delivery_ready: true, downloads: 3 });
  issued.set("93000000-0000-4000-8000-000000000002", { ...base, id: "93000000-0000-4000-8000-000000000002", order_item_id: randomUUID(), license_number: "PH-2026-4HJ8NP0WVZ", title: { ar: "لقطات اصطناعية 2", en: "Synthetic footage 2" }, status: "revoked", revoked_reason: "refunded", delivery_ready: true, downloads: 3 });
}
const conflicts: (Record<string, unknown> & { id: string; state: string })[] = [];
function seedConflicts() {
  conflicts.length = 0;
  const base = { organization_id: "90000000-0000-4000-8000-000000000001", invited_by: me.user_id, invite_expires_at: "2026-11-02T10:00:00Z", resolved_at: null, resolved_by: null, internal_note: "never-display-canary" };
  conflicts.push({ ...base, id: "96000000-0000-4000-8000-000000000001", email: "existing.reporter@example.test", existing_user_id: randomUUID(), role: "buyer_member", state: "pending", created_at: "2026-10-26T09:00:00Z" });
  conflicts.push({ ...base, id: "96000000-0000-4000-8000-000000000002", email: "existing.staff@example.test", existing_user_id: randomUUID(), role: "buyer_admin", state: "suspended", created_at: "2026-10-25T09:00:00Z" });
}
// الأرباح والصرف التجريبي: محفظة المراسل الاصطناعي بالدولار، وطلبات مساهم آخر كي تعتمدها المالية دون اعتماد ذاتي.
const otherContributor = "10000000-0000-4000-8000-000000000009";
const wallet = { pending: 0, available: 0, in_payout: 0, paid: 0 }, payouts: (Record<string, unknown> & { id: string; user_id: string; state: string; amount: { amount_minor: number; currency: string }; approvals: { approver_id: string; approved_at: string }[]; approvals_required: number })[] = [], ledger: Record<string, unknown>[] = [], policies: Record<string, unknown>[] = [];
function seedEarnings() {
  Object.assign(wallet, { pending: 5000, available: 30000, in_payout: 0, paid: 10000 }); payouts.length = 0; ledger.length = 0; policies.length = 0;
  const line = (n: number, kind: string, state: string, amount: number, at: string) => ({ id: String(n), entry_id: randomUUID(), kind, state, amount: { amount_minor: amount, currency: "USD" }, reference_type: kind === "payout" ? "payout_request" : "order", reference_id: randomUUID(), occurred_at: at, buyer_name: "never-display-canary" });
  ledger.push(line(3, "sale", "pending", 5000, "2026-10-25T10:00:00Z"), line(2, "sale", "available", 30000, "2026-10-01T10:00:00Z"), line(1, "payout", "paid", -10000, "2026-09-20T10:00:00Z"));
  const at = "2026-10-24T10:00:00Z", base = { channel: "sandbox", reason_code: null, decided_at: null, completed_at: null, requested_at: at };
  payouts.push({ ...base, id: "97000000-0000-4000-8000-000000000001", user_id: otherContributor, amount: { amount_minor: 150000, currency: "USD" }, state: "requested", approvals_required: 2, approvals: [] });
  payouts.push({ ...base, id: "97000000-0000-4000-8000-000000000002", user_id: otherContributor, amount: { amount_minor: 8000, currency: "USD" }, state: "requested", approvals_required: 1, approvals: [], requested_at: "2026-10-23T10:00:00Z" });
  const policy = (id: string, currency: string, min: number, dual: number, bps: number, from: string) => ({ id, currency, minimum: { amount_minor: min, currency }, dual_approval_above: { amount_minor: dual, currency }, reserve_bps: bps, effective_from: from, created_by: me.user_id, created_at: from });
  policies.push(policy("98000000-0000-4000-8000-000000000002", "USD", 5000, 100000, 1000, "2026-06-01T00:00:00Z"), policy("98000000-0000-4000-8000-000000000001", "USD", 10000, 100000, 2000, "2026-01-01T00:00:00Z"), policy("98000000-0000-4000-8000-000000000003", "ILS", 20000, 400000, 1000, "2026-06-01T00:00:00Z"));
}
function summary(user: string) {
  const usd = (n: number) => ({ amount_minor: n, currency: "USD" }), reserve = Math.round(wallet.available * 0.1);
  const balances = user === me.user_id ? [{ currency: "USD", pending: usd(wallet.pending), available: usd(wallet.available), in_payout: usd(wallet.in_payout), paid: usd(wallet.paid), reserve: usd(reserve), requestable: usd(wallet.available - reserve), minimum: usd(5000) }] : [];
  return { user_id: user, balances, as_of: new Date().toISOString(), internal_note: "never-display-canary" };
}
const commissionRules: (Record<string, unknown> & { id: string; scope: string; scope_id: string | null; license_type: string | null; effective_from: string })[] = [];
function seedCommission() {
  commissionRules.length = 0;
  const base = { created_by: me.user_id, created_at: "2026-01-01T10:00:00Z", internal_note: "never-display-canary" };
  commissionRules.push({ ...base, id: "94000000-0000-4000-8000-000000000001", scope: "default", scope_id: null, license_type: null, platform_basis_points: 3500, effective_from: "2026-01-01T00:00:00Z" });
  commissionRules.push({ ...base, id: "94000000-0000-4000-8000-000000000002", scope: "default", scope_id: null, license_type: null, platform_basis_points: 3000, effective_from: "2026-06-01T00:00:00Z" });
  commissionRules.push({ ...base, id: "94000000-0000-4000-8000-000000000003", scope: "material_type", scope_id: "aerial", license_type: "commercial", platform_basis_points: 4000, effective_from: "2026-03-01T00:00:00Z" });
}
// الطلبات والدفع التجريبي: أسعار عروض الكتالوج الاصطناعي، وصفحة مزوّد مستضافة تؤكد الدفع بعد العودة كما يفعل الإشعار الموقّع.
const orders = new Map<string, Record<string, unknown> & { id: string; organization_id: string; status: string; created_by: string }>();
const refunds = new Map<string, Record<string, unknown>[]>();
// طلب مدفوع لمؤسسة أخرى غير مؤسسة المشتري الاصطناعي، كي تسترد منه المالية دون أن يظهر في طلبات المشتري.
function seedOrders() {
  orders.clear(); refunds.clear();
  const stamp = "2026-10-25T10:00:00Z", line = (n: number, amount: number) => ({ id: `95000000-0000-4000-8000-00000000000${n}`, listing_id: `71000000-0000-4000-8000-00000000000${n}`, material_version: 1, license_template_id: "70000000-0000-4000-8000-000000000001", license_version: 1, license_type: "editorial_single", license_name: { ar: "تحريري لاستخدام واحد", en: "Editorial single use" }, title: { ar: `لقطات اصطناعية ${n}`, en: `Synthetic footage ${n}` }, price: { amount_minor: amount, currency: "USD" }, license_id: randomUUID() });
  orders.set("92000000-0000-4000-8000-000000000009", { id: "92000000-0000-4000-8000-000000000009", organization_id: "90000000-0000-4000-8000-000000000009", created_by: randomUUID(), status: "paid", cancel_reason: null, total: { amount_minor: 40000, currency: "USD" }, items: [line(1, 15000), line(2, 25000)], expires_at: stamp, paid_at: stamp, created_at: stamp, updated_at: stamp });
}
const offerPrices: Record<string, { amount: number; type: string; name: { ar: string; en: string } }> = {
  "70000000-0000-4000-8000-000000000001": { amount: 15000, type: "editorial_single", name: { ar: "تحريري لاستخدام واحد", en: "Editorial single use" } },
  "70000000-0000-4000-8000-000000000002": { amount: 90000, type: "exclusive_temporary", name: { ar: "حصري 48 ساعة", en: "Exclusive 48 h" } },
};
const templates = new Map<string, (Record<string, unknown> & { id: string; version: number; enabled: boolean })[]>();
function seedTemplates() {
  templates.clear();
  const base = { usage_media: ["tv", "web"], territory: { kind: "worldwide" }, term_days: null, exclusivity_hours: null, deliverables: ["original"], attribution: { ar: "فلسطين بوست", en: "Palestine Post" }, prohibitions: ["resale", "ai_training"], created_at: "2026-10-21T10:00:00Z", created_by: me.user_id };
  templates.set("81000000-0000-4000-8000-000000000001", [{ ...base, id: "81000000-0000-4000-8000-000000000001", version: 1, type: "editorial_single", name: { ar: "تحريري لاستخدام واحد", en: "Editorial single use" }, terms: { ar: "شروط الاستخدام الواحد", en: "Single use terms" }, base_price: { amount_minor: 15000, currency: "USD" }, enabled: true, internal_note: "never-display-canary" }]);
  templates.set("81000000-0000-4000-8000-000000000002", [{ ...base, id: "81000000-0000-4000-8000-000000000002", version: 3, type: "editorial_term", term_days: 365, name: { ar: "تحريري سنوي قديم", en: "Old annual editorial" }, terms: { ar: "شروط", en: "Terms" }, base_price: { amount_minor: 40000, currency: "ILS" }, enabled: false }]);
}
reset(); seedTemplates(); seedOrganizations(); seedLicenses(); seedCommission(); seedOrders(); seedConflicts(); seedEarnings();
const signed = new Map<string, { kind: "proxy" | "thumbnail"; expires: number }>();
let expireNextProxy = false;
const access = new Map<string, Me>(), refresh = new Map<string, Me>();
function profile(email: string): Me {
  const names: Record<string, Me["roles"]> = { chief: [{ name: "editor_in_chief", scopes: [] }], reviewer: ["supervisor", "rights_officer", "producer"].map(name => ({ name: name as Me["roles"][number]["name"], scopes: [] })), admin: [{ name: "system_admin", scopes: [] }], reporter: [{ name: "reporter", scopes: [] }], buyeradmin: [{ name: "buyer_admin", scopes: [] }], buyer: [{ name: "buyer_member", scopes: [] }], finance: [{ name: "finance", scopes: [] }] };
  const local = email.split("@")[0], buyer = local === "buyeradmin" || local === "buyer";
  return { ...me, ...(buyer ? { user_id: local === "buyer" ? "91000000-0000-4000-8000-000000000002" : "91000000-0000-4000-8000-000000000001", organization_id: buyerOrg } : {}), roles: names[local] ?? [], permissions: email.startsWith("permissions@") ? ["sensitive_location:read", "protected_source:read", "reporter_identity:read"] : [] };
}
function session(user: Me) {
  const value = { ...tokens(), access_token: randomUUID(), refresh_token: randomUUID(), roles: user.roles };
  access.set(value.access_token, user); refresh.set(value.refresh_token, user); return value;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(status === 204 ? "" : JSON.stringify(value)); };
  if (url.pathname === "/health") return send({ ok: true });
  const delivery = /^\/delivery\/([^/]+)$/.exec(url.pathname);
  if (delivery) { res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", `attachment; filename="delivery-${delivery[1].slice(0, 8)}.zip"`); res.end("synthetic delivery package"); return; }
  if (url.pathname.startsWith("/files/")) { res.removeHeader("Content-Type"); return tus(req, res, url); }
  if (url.pathname === "/__test/tus" && req.method === "POST") { const query = url.searchParams; Object.assign(tusFaults, { rejectIngest: Number(query.get("reject_ingest") ?? 0), failPatches: Number(query.get("fail_patches") ?? 0), cutNext: query.get("cut") === "1", revoked: tusFaults.revoked }); return send({ ok: true }); }
  if (url.pathname === "/__test/uploads") return send([...uploads.values()].map(u => ({ state: u.session.state, receipt: u.session.receipt_number, ingest_tokens: [...ingestTokens.values()].filter(t => t.sid === u.session.id).length, ...(u.tus ? (({ length, offset, patches, resent, cuts }) => ({ length, offset, patches, resent, cuts }))(tusFiles.get(u.tus) ?? { length: 0, offset: 0, patches: 0, resent: 0, cuts: 0 }) : {}) })));
  if (url.pathname === "/__test/reset" && req.method === "POST") { rules.clear(); listings.clear(); seedOrders(); seedLicenses(); seedTemplates(); seedOrganizations(); seedCommission(); seedConflicts(); seedEarnings(); reset(); resetUploads(); return send({ ok: true }); }
  const sandbox = /^\/sandbox\/(checkout|pay)\/([^/]+)$/.exec(url.pathname);
  if (sandbox) {
    const order = orders.get(sandbox[2]); if (!order) return send({}, 404);
    if (sandbox[1] === "checkout") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(`<!doctype html><title>Sandbox checkout</title><h1>Sandbox provider</h1><a href="/sandbox/pay/${order.id}">Pay (sandbox)</a>`); return; }
    setTimeout(() => { if (order.status === "pending_payment") Object.assign(order, { status: "paid", paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }); }, 1500);
    res.statusCode = 302; res.setHeader("Location", `http://127.0.0.1:3100/ar/store/orders/${order.id}?returned=1`); res.end(); return;
  }
  if (url.pathname === "/__test/state") return send({ writes, applied: applied.size, identitySetting, auditCount: permissionAudit.length });
  if (url.pathname === "/__test/request-changes" && req.method === "POST") {
    // مادة بطلب تعديل وأخرى مرفوضة وثالثة فشل رفعها، وسبب داخلي لا يصل المراسل.
    const supervisor = "10000000-0000-4000-8000-000000000002", stamp = "2026-10-21T10:00:00Z";
    Object.assign(materials[0], { editorial_state: "needs_changes" }); Object.assign(materials[1], { editorial_state: "rejected" }); Object.assign(materials[2], { technical_state: "failed" });
    history.set(materials[0].id, [{ id: randomUUID(), track: "editorial", from: "inbox", to: "acknowledged", reason: "never-display-canary", note_timecode_ms: null, actor_id: supervisor, occurred_at: "2026-10-21T09:00:00Z" }, { id: randomUUID(), track: "editorial", from: "reviewing", to: "needs_changes", reason: "أعد اللقطة الافتتاحية بإضاءة أفضل", note_timecode_ms: 42000, actor_id: supervisor, occurred_at: stamp }]);
    history.set(materials[1].id, [{ id: randomUUID(), track: "editorial", from: "reviewing", to: "rejected", reason: "مكررة مع مادة سابقة", note_timecode_ms: null, actor_id: supervisor, occurred_at: stamp }]);
    return send({ ok: true });
  }
  if (url.pathname === "/__test/board-mix" && req.method === "POST") {
    // مزيج للوحة الأعمدة الأربعة (ADR 0078): فوق المقبولة [1] والفاشلة فنيًا [2] من الإعادة الافتراضية.
    Object.assign(materials[3], { editorial_state: "acknowledged" }); Object.assign(materials[5], { editorial_state: "reviewing" });
    Object.assign(materials[6], { technical_state: "pending" });                                              // واردة لكن الاستلام لم يبدأ: قيد التحقق
    Object.assign(materials[7], { editorial_state: "accepted", technical_state: "original_received" });      // مقبولة والتحقق الفني جارٍ: قيد التحقق لا جاهزة
    Object.assign(materials[8], { editorial_state: "needs_changes" }); Object.assign(materials[9], { editorial_state: "rejected" });
    Object.assign(materials[10], { editorial_state: "accepted", technical_state: "failed" });                // مقبولة وفشل فني: متوقفة
    Object.assign(materials[11], { editorial_state: "in_production" }); Object.assign(materials[12], { editorial_state: "final_review" });
    Object.assign(materials[13], { editorial_state: "published" });                                          // خارج اللوحة
    return send({ ok: true });
  }
  if (url.pathname === "/__test/board-cap" && req.method === "POST") {
    // أكثر من 500 مادة في حالة فنية واحدة غير مكتملة (سقف جلب اللوحة): 560 واردة قيد الاستلام، وخمس جلسات رفع جارية (ثلاث خانات ثم «n أخرى»).
    materials.push(...Array.from({ length: 560 }, (_, i) => ({ ...material(1001 + i), technical_state: "pending" as const, row_version: 17, reserved_by: null, reserved_at: null, contributors: [{ user_id: me.user_id, role: "reporter" as const, share_percent: 100 }] })));
    extraUploadsInProgress = 4;
    return send({ ok: true });
  }
  if (url.pathname === "/__test/history-unavailable" && req.method === "POST") { historyUnavailable = true; return send({ ok: true }); }
  if (url.pathname === "/__test/bump-rule" && req.method === "POST") { for (const rule of rules.values()) rule.row_version++; return send({ ok: true }); }
  if (url.pathname === "/__test/bump" && req.method === "POST") { materials[0].row_version!++; return send({ ok: true }); }
  if (url.pathname === "/__test/drop-write" && req.method === "POST") { dropNextWrite = true; return send({ ok: true }); }
  if (url.pathname === "/__test/revoke-role" && req.method === "POST") { for (const user of access.values()) user.roles = []; return send({ ok: true }); }
  if (url.pathname === "/__test/revoke" && req.method === "POST") { access.clear(); refresh.clear(); tusFaults.revoked = true; return send({ ok: true }); }
  if (url.pathname === "/__test/expire-media" && req.method === "POST") { expireNextProxy = true; return send({ ok: true }); }
  if (url.pathname === "/derived/fixture") {
    const grant = signed.get(url.searchParams.get("signature") ?? "");
    if (!grant || grant.expires <= Date.now() || req.headers.authorization || req.headers.cookie) return send({}, 403);
    const bytes = Buffer.from(grant.kind === "proxy" ? assets.mp4 : assets.png, "base64");
    res.setHeader("Content-Type", grant.kind === "proxy" ? "video/mp4" : "image/png"); res.setHeader("Accept-Ranges", "bytes");
    let start = 0, end = bytes.length - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) return send({}, 416);
      start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end) return send({}, 416);
      res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    }
    res.setHeader("Content-Length", end - start + 1); return res.end(bytes.subarray(start, end + 1));
  }
  let body: Record<string, unknown> = {};
  if (["POST", "PUT", "DELETE"].includes(req.method ?? "")) {
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return send({}, 413); }
    try { body = JSON.parse(raw || "{}"); } catch { return send({}, 400); }
    if (!req.headers["idempotency-key"]) return send({ code: "missing_idempotency_key" }, 400);
  }
  if (url.pathname === "/v1/auth/login" && req.method === "POST") {
    if (body.password !== "synthetic-password") return send({ code: "unauthorized" }, 401);
    if (body.totp_code !== "123456") return send({ code: "totp_required" }, 401);
    return send(session(profile(String(body.email))));
  }
  if (url.pathname === "/v1/auth/refresh" && req.method === "POST") {
    const user = refresh.get(String(body.refresh_token));
    if (!user || !refresh.delete(String(body.refresh_token))) return send({ code: "unauthorized" }, 401);
    return send(session(user));
  }
  // التحقق العام من ترخيص بلا مصادقة؛ يعيد أبعاد الترخيص كما في العقد وحقلًا زائدًا للتأكد أن الـBFF يقصّها.
  const verification = /^\/v1\/license-verifications\/([^/]+)$/.exec(url.pathname);
  if (verification && req.method === "GET") {
    const found = [...issued.values()].find(l => l.license_number === verification[1]);
    if (!found) return send({ code: "not_found" }, 404);
    return send({ license_number: found.license_number, status: found.status, license_type: "editorial_single", title: found.title, usage_media: ["web"], territory: { kind: "worldwide" }, valid_from: "2026-10-21T10:00:00Z", valid_until: null, exclusive_until: null, organization: "never-display-canary" });
  }
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  if (!access.has(token)) return send({ code: "unauthorized" }, 401);
  if (url.pathname === "/v1/auth/logout" && req.method === "POST") { if (body.all_sessions) { access.clear(); refresh.clear(); } else access.delete(token); return send(null, 204); }
  const user = access.get(token)!;
  if (url.pathname === "/v1/auth/me") return send(user);
  const isWrite = ["POST", "PUT", "DELETE"].includes(req.method ?? "");
  if (isWrite) {
    const path = decodeURIComponent(url.pathname), key = String(req.headers["idempotency-key"]), fingerprint = JSON.stringify([path, req.method, body]);
    writes.push({ path, method: req.method!, key, body });
    const cached = applied.get(key);
    if (cached) return cached.fingerprint === fingerprint ? send(cached.value, cached.status) : send({}, 409);
    const has = (...roles: string[]) => user.roles.some(role => roles.includes(role.name));
    const commit = (value: unknown, status = 204) => { applied.set(key, { fingerprint, value: structuredClone(value), status }); if (dropNextWrite) { dropNextWrite = false; return send({ message: "never-display-canary" }, 503); } return send(value, status); };
    if (path === "/v1/forms" && req.method === "POST") {
      if (!has("system_admin")) return send({}, 403);
      const current = Math.max(0, ...formVersions.keys());
      if (req.headers["if-match"] !== `"${current}"`) return send({ message: "never-display-canary" }, 412);
      if (body.version !== current + 1) return send({}, 409);
      const snapshot = { ...structuredClone(body), published_at: new Date().toISOString(), published_by: user.user_id } as Form;
      formVersions.set(snapshot.version, snapshot); return commit(snapshot, 201);
    }
    const match = /^\/v1\/materials\/([^/]+)\/(transitions|reservation|contributors)$/.exec(path);
    if (match) {
      const item = materials.find(m => m.id === match[1]); if (!item) return send({}, 404);
      if (req.method !== "DELETE" && req.headers["if-match"] !== `"${item.row_version}"`) return send({}, 412);
      const stamp = new Date().toISOString();
      if (match[2] === "transitions") {
        const track = body.track as "technical" | "editorial" | "rights", column = `${track}_state` as const;
        if (track === "editorial" && !has("supervisor", "producer") || track === "rights" && !has("rights_officer") || track === "technical" && !has("reporter")) return send({}, 403);
        const from = item[column]; Object.assign(item, { [column]: body.to }); item.row_version!++;
        history.set(item.id, [...(history.get(item.id) ?? []), { id: randomUUID(), track, from, to: String(body.to), reason: String(body.reason), note_timecode_ms: typeof body.note_timecode_ms === "number" ? body.note_timecode_ms : null, actor_id: user.user_id, actor_name: has("reporter") ? null : "Synthetic staff", occurred_at: stamp }]);
        return commit(item, 200);
      }
      if (match[2] === "contributors" && req.method === "PUT") { if (!has("rights_officer", "system_admin")) return send({}, 403); item.contributors = body.contributors as Material["contributors"]; item.row_version!++; return commit(item, 200); }
      if (match[2] === "reservation") {
        if (req.method === "DELETE") { if (!has("producer", "supervisor", "editor_in_chief", "system_admin")) return send({}, 403); item.reserved_by = null; item.reserved_at = null; item.row_version!++; return commit(null); }
        if (!has("producer", "editor_in_chief")) return send({}, 403);
        if (!["accepted", "in_production"].includes(item.editorial_state) || item.reserved_by && item.reserved_by !== user.user_id) return send({}, 409);
        item.reserved_by = user.user_id; item.reserved_at = stamp; item.editorial_state = "in_production"; item.row_version!++;
        return commit({ material_id: item.id, reserved_by: user.user_id, reserved_at: stamp, releases_at: new Date(Date.now() + 1800000).toISOString() }, 200);
      }
    }
    if (path === "/v1/admin/settings/reporter-identity" && req.method === "PUT") {
      if (!has("system_admin")) return send({}, 403);
      const input = body as ReporterIdentitySettingUpdate;
      if (input.access !== identitySetting.access) {
        identitySetting = { access: input.access, updated_by: user.user_id, updated_at: new Date().toISOString() };
        permissionAudit.unshift({ target: null, entry: { id: String(++auditSequence), kind: "setting_changed", setting: "reporter_legal_name_access", value: input.access, actor_id: user.user_id, occurred_at: identitySetting.updated_at, reason_code: input.reason_code } });
      }
      return commit(identitySetting, 200);
    }
    const permissionPath = /^\/v1\/users\/([^/]+)\/permissions\/([^/]+)$/.exec(path);
    if (permissionPath) {
      if (!has("system_admin")) return send({}, 403);
      permissionAudit.unshift({ target: permissionPath[1], entry: { id: String(++auditSequence), kind: req.method === "PUT" ? "permission_granted" : "permission_revoked", permission: permissionPath[2] as Permission, actor_id: user.user_id, occurred_at: new Date().toISOString(), reason_code: null } });
      return commit(null);
    }
    if (path === "/v1/materials" && req.method === "POST") {
      if (!has("reporter", "supervisor", "producer", "editor_in_chief")) return send({}, 403);
      const stamp = new Date().toISOString(), base = material(materials.length + 1);
      const created: Material = { ...base, id: randomUUID(), ...(body as Partial<Material>), reporter_id: user.user_id, technical_state: "pending", editorial_state: "inbox", rights_state: "unknown", files: [], row_version: 1, reserved_by: null, reserved_at: null, created_at: stamp, updated_at: stamp };
      materials.unshift(created); return commit(created, 201);
    }
    if (path === "/v1/uploads" && req.method === "POST") {
      if (!has("reporter", "supervisor", "producer", "editor_in_chief")) return send({}, 403);
      if (!materials.some(m => m.id === body.material_id)) return send({}, 404);
      const id = randomUUID(), now = Date.now();
      const session = { id, material_id: String(body.material_id), kind: "original", state: "created", size_bytes: Number(body.size_bytes), tus_endpoint: process.env.FIXTURE_TUS_ENDPOINT ?? `${fixtureOrigin}/files/`,
        tus_metadata: { upload_session_id: id, filename: String(body.filename) }, part_size_bytes: Number(process.env.FIXTURE_PART_SIZE ?? 1048576), bytes_received: 0, ingest_token_required: !process.env.FIXTURE_TUS_ENDPOINT,
        ietf_resumable: false, checksum_algorithm: "sha256", expires_at: new Date(now + 86400000).toISOString(), file_id: null, duplicate_of_file_id: null, failure_reason: null, receipt_number: null, created_at: new Date(now).toISOString() };
      const token = randomUUID(); uploads.set(id, { session, sha: String(body.client_sha256), token });
      return commit({ ...session, upload_token: token, upload_token_expires_at: new Date(now + 3600000).toISOString() }, 201);
    }
    const abortPath = /^\/v1\/uploads\/([^/]+)$/.exec(path);
    if (abortPath && req.method === "DELETE") {
      const upload = uploads.get(abortPath[1]); if (!upload) return send({}, 404);
      if (["verified", "deduplicated"].includes(upload.session.state)) return send({ code: "upload_state_conflict" }, 409);
      Object.assign(upload.session, { state: "failed", failure_reason: "aborted" }); return commit(null);
    }
    const ingestPath = /^\/v1\/uploads\/([^/]+)\/web-ingest-token$/.exec(path);
    if (ingestPath) {
      const upload = uploads.get(ingestPath[1]);
      if (!upload) return send({}, 404);
      if (upload.session.state !== "created" && upload.session.state !== "in_progress") return send({}, 409);
      const token = randomUUID(), expires = Date.now() + 600000; ingestTokens.set(token, { sid: upload.session.id, expires });
      return commit({ token, expires_at: new Date(expires).toISOString() }, 200);
    }
    if (path === "/v1/notification-rules" && req.method === "POST") {
      if (!has("system_admin")) return send({}, 403);
      const stamp = new Date().toISOString(), rule = { ...body, id: randomUUID(), row_version: 1, created_by: user.user_id, updated_by: user.user_id, created_at: stamp, updated_at: stamp };
      rules.set(rule.id, rule); res.setHeader("ETag", '"1"'); return commit(rule, 201);
    }
    const listingPath = /^\/v1\/materials\/([^/]+)\/listing$/.exec(path);
    if (listingPath) {
      if (!has("system_admin", "rights_officer")) return send({}, 403);
      const item = materials.find(m => m.id === listingPath[1]); if (!item) return send({}, 404);
      const current = listings.get(item.id), stamp = new Date().toISOString();
      if (req.method === "POST" ? !!current : !current) return send({ code: "conflict" }, current ? 409 : 404);
      if (current && req.headers["if-match"] !== `"${current.row}"`) return send({}, 412);
      if (body.state === "listed" && item.rights_state !== "sellable") return send({ code: "rights_not_sellable" }, 409);
      if (body.commercial_allowed && !has("system_admin")) return send({ code: "forbidden_role" }, 403);
      const next = { ...body, id: current?.id ?? randomUUID(), material_id: item.id, material_version: item.version, suspended_reason: body.state === "suspended" ? "manual" : null, listed_at: current?.listed_at ?? (body.state === "listed" ? stamp : null), created_at: current?.created_at ?? stamp, updated_at: stamp, updated_by: user.user_id, row: (current?.row ?? 0) + 1, state: String(body.state) };
      listings.set(item.id, next); res.setHeader("ETag", `"${next.row}"`); return commit(Object.fromEntries(Object.entries(next).filter(([key]) => key !== "row")), current ? 200 : 201);
    }
    const download = /^\/v1\/licenses\/([^/]+)\/download-url$/.exec(path);
    if (download) {
      if (!has("buyer_admin", "buyer_member")) return send({}, 403);
      const found = issued.get(download[1]); if (!found || found.organization_id !== user.organization_id) return send({}, 404);
      if (found.status !== "active") return send({ code: "license_not_active" }, 409);
      if (found.downloads < 1) return send({ code: "download_limit_reached" }, 409);
      found.downloads--;
      return commit({ url: `http://127.0.0.1:${process.env.WEB_FIXTURE_PORT ?? 3201}/delivery/${found.id}?signature=${randomUUID()}`, expires_at: new Date(Date.now() + 3600000).toISOString(), downloads_remaining: found.downloads }, 200);
    }
    const refundWrite = /^\/v1\/orders\/([^/]+)\/refunds$/.exec(path);
    if (refundWrite) {
      if (!has("system_admin", "finance")) return send({}, 403);
      const order = orders.get(refundWrite[1]) as (Record<string, unknown> & { status: string; items: { id: string; price: { amount_minor: number } }[]; total: { currency: string } }) | undefined; if (!order) return send({}, 404);
      if (order.status !== "paid") return send({ code: "order_state_conflict" }, 409);
      const ids = body.order_item_ids as string[], list = refunds.get(refundWrite[1]) ?? [], held = new Set(list.filter(r => r.status !== "failed").flatMap(r => r.order_item_ids as string[]));
      if (!ids.every(id => order.items.some(i => i.id === id))) return send({ code: "validation_failed" }, 422);
      if (ids.some(id => held.has(id))) return send({ code: "already_refunded" }, 409);
      const refund: Record<string, unknown> = { id: randomUUID(), order_id: refundWrite[1], order_item_ids: ids, amount: { amount_minor: order.items.filter(i => ids.includes(i.id)).reduce((sum, i) => sum + i.price.amount_minor, 0), currency: order.total.currency }, reason_code: body.reason_code, status: "pending", created_by: user.user_id, created_at: new Date().toISOString(), completed_at: null, provider_reference: "never-display-canary" };
      list.unshift(refund); refunds.set(refundWrite[1], list);
      // كالإشعار الموقّع: النجاح بعد لحظة، والطلب مسترد حين تُسترد كل بنوده.
      setTimeout(() => { Object.assign(refund, { status: "succeeded", completed_at: new Date().toISOString() }); const done = new Set(list.filter(r => r.status === "succeeded").flatMap(r => r.order_item_ids as string[])); if (order.items.every(i => done.has(i.id))) Object.assign(order, { status: "refunded", updated_at: new Date().toISOString() }); }, 1500);
      return commit(refund, 201);
    }
    const orderWrite = /^\/v1\/orders(?:\/([^/]+)\/(checkout|cancel))?$/.exec(path);
    if (orderWrite) {
      if (!has("buyer_admin", "buyer_member") || !user.organization_id) return send({}, 403);
      if (!orderWrite[1]) {
        const items = (body.items as { listing_id: string; license_template_id: string }[]).map(i => { const o = offerPrices[i.license_template_id]; return { id: randomUUID(), listing_id: i.listing_id, material_version: 1, license_template_id: i.license_template_id, license_version: 1, license_type: o.type, license_name: o.name, title: { ar: `لقطات اصطناعية ${i.listing_id.slice(-1)}`, en: `Synthetic footage ${i.listing_id.slice(-1)}` }, price: { amount_minor: o.amount, currency: "USD" }, license_id: null }; });
        const total = items.reduce((sum, i) => sum + i.price.amount_minor, 0), expected = body.expected_total as { amount_minor: number } | undefined;
        if (expected && expected.amount_minor !== total) return send({ code: "price_changed" }, 409);
        const stamp = new Date().toISOString(), exclusive = items.some(i => i.license_type === "exclusive_temporary");
        const order = { id: randomUUID(), organization_id: user.organization_id, created_by: user.user_id, status: "pending_payment", cancel_reason: null, total: { amount_minor: total, currency: "USD" }, items, expires_at: new Date(Date.now() + (exclusive ? 900000 : 86400000)).toISOString(), paid_at: null, created_at: stamp, updated_at: stamp };
        orders.set(order.id, order); return commit(order, 201);
      }
      const order = orders.get(orderWrite[1]); if (!order || order.organization_id !== user.organization_id) return send({}, 404);
      if (order.status !== "pending_payment") return send({ code: "order_state_conflict" }, 409);
      if (orderWrite[2] === "cancel") { Object.assign(order, { status: "cancelled", cancel_reason: "buyer", updated_at: new Date().toISOString() }); return commit(order, 200); }
      return commit({ checkout_url: `http://127.0.0.1:${process.env.WEB_FIXTURE_PORT ?? 3201}/sandbox/checkout/${order.id}`, provider: "sandbox", expires_at: order.expires_at, session_secret: "never-display-canary" }, 200);
    }
    const orgWrite = /^\/v1\/buyer-organizations(?:\/([^/]+)(\/members)?(?:\/([^/]+))?)?$/.exec(path);
    if (orgWrite) {
      const [, id, isMembers, userId] = orgWrite, mine = (orgId: string) => !user.organization_id || user.organization_id === orgId;
      if (!id) {
        if (!has("system_admin")) return send({}, 403);
        const created = { ...body, id: randomUUID(), status: "pending_verification", active_members: 1, verified_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), row: 1 } as unknown as Record<string, unknown> & { id: string; row: number; seats: number };
        delete created.first_admin_email; organizations.set(created.id, created); members.set(created.id, [{ user_id: randomUUID(), email: String(body.first_admin_email), role: "buyer_admin", status: "invited", totp_enabled: false, created_at: String(created.created_at) }]);
        res.setHeader("ETag", '"1"'); return commit({ ...Object.fromEntries(Object.entries(created).filter(([key]) => key !== "row")), invite_token: "synthetic-invite-token-organization-0001", invite_token_expires_at: new Date(Date.now() + 86400000).toISOString() }, 201);
      }
      const current = organizations.get(id); if (!current || !mine(id)) return send({}, 404);
      if (!isMembers) {
        if (!has("system_admin", "buyer_admin")) return send({}, 403);
        if (req.headers["if-match"] !== `"${current.row}"`) return send({}, 412);
        if (!has("system_admin") && (body.status !== current.status || body.seats !== current.seats)) return send({ code: "forbidden_role" }, 403);
        const next = { ...current, ...body, row: current.row + 1, updated_at: new Date().toISOString() }; organizations.set(id, next);
        res.setHeader("ETag", `"${next.row}"`); return commit(Object.fromEntries(Object.entries(next).filter(([key]) => key !== "row")), 200);
      }
      if (!has("system_admin", "buyer_admin")) return send({}, 403);
      const list = members.get(id)!, active = list.filter(m => m.status !== "suspended").length;
      if (!userId) {
        if (list.some(m => m.email === body.email)) return send({ code: "conflict" }, 409);
        if (active >= current.seats) return send({ code: "seats_exhausted" }, 409);
        const added = { user_id: randomUUID(), email: String(body.email), role: String(body.role), status: "invited", totp_enabled: false, created_at: new Date().toISOString() }; list.push(added);
        return commit({ ...added, invite_token: "synthetic-invite-token-member-000000001", invite_token_expires_at: new Date(Date.now() + 86400000).toISOString() }, 201);
      }
      const target = list.find(m => m.user_id === userId); if (!target) return send({}, 404);
      if (target.role === "buyer_admin" && (body.role !== "buyer_admin" || body.status === "suspended") && list.filter(m => m.role === "buyer_admin" && m.status === "active").length === 1) return send({ code: "last_buyer_admin" }, 409);
      Object.assign(target, { role: body.role, status: body.status }); return commit(target, 200);
    }
    const resolve = /^\/v1\/buyer-invite-conflicts\/([^/]+)\/resolve$/.exec(path);
    if (resolve) {
      if (!has("system_admin")) return send({ code: "forbidden_role" }, 403);
      const found = conflicts.find(c => c.id === resolve[1]); if (!found) return send({}, 404);
      if (body.totp_code !== "123456") return send({ code: "totp_required" }, 401);
      if (!(found.state === "pending" || found.state === "suspended" && body.state === "dismissed")) return send({ code: "invalid_transition" }, 409);
      Object.assign(found, { state: body.state, resolved_at: new Date().toISOString(), resolved_by: user.user_id }); return commit(found, 200);
    }
    if (path === "/v1/me/payout-requests") {
      if (!has("reporter")) return send({}, 403);
      const amount = (body.amount as { amount_minor: number }).amount_minor, requestable = wallet.available - Math.round(wallet.available * 0.1);
      if (amount < 5000) return send({ code: "payout_below_minimum" }, 422);
      if (amount > requestable) return send({ code: "insufficient_available" }, 422);
      wallet.available -= amount; wallet.in_payout += amount;
      const created = { id: randomUUID(), user_id: user.user_id, amount: { amount_minor: amount, currency: "USD" }, channel: "sandbox", state: "requested", reason_code: null, approvals_required: amount > 100000 ? 2 : 1, approvals: [] as { approver_id: string; approved_at: string }[], requested_at: new Date().toISOString(), decided_at: null, completed_at: null };
      payouts.unshift(created); return commit(created, 201);
    }
    const payoutAction = /^\/v1\/payout-requests\/([^/]+)\/(approve|reject|cancel)$/.exec(path);
    if (payoutAction) {
      const found = payouts.find(p => p.id === payoutAction[1]); if (!found) return send({}, 404);
      const mine = found.user_id === user.user_id, amount = found.amount.amount_minor, back = () => { if (found.user_id === me.user_id) { wallet.available += amount; wallet.in_payout -= amount; } };
      if (payoutAction[2] === "cancel") { if (!has("reporter") || !mine) return send({}, 404); if (found.state !== "requested") return send({ code: "payout_state_conflict" }, 409); back(); Object.assign(found, { state: "cancelled", decided_at: new Date().toISOString() }); return commit(found, 200); }
      if (!has("system_admin", "finance")) return send({}, 403);
      if (payoutAction[2] === "reject") { if (!["requested", "approved"].includes(found.state)) return send({ code: "payout_state_conflict" }, 409); back(); Object.assign(found, { state: "rejected", reason_code: body.reason_code, decided_at: new Date().toISOString() }); return commit(found, 200); }
      if (found.state !== "requested") return send({ code: "payout_state_conflict" }, 409);
      if (mine) return send({ code: "self_approval_forbidden" }, 409);
      if (found.approvals.some(a => a.approver_id === user.user_id)) return send({ code: "already_approved" }, 409);
      found.approvals.push({ approver_id: user.user_id, approved_at: new Date().toISOString() });
      if (found.approvals.length >= found.approvals_required) {
        Object.assign(found, { state: "approved", decided_at: new Date().toISOString() });
        setTimeout(() => { if (found.state === "approved") { Object.assign(found, { state: "paid", completed_at: new Date().toISOString() }); if (found.user_id === me.user_id) { wallet.in_payout -= amount; wallet.paid += amount; } } }, 1000);
      }
      return commit(found, 200);
    }
    if (path === "/v1/payout-policies") {
      if (!has("system_admin")) return send({}, 403);
      if (policies.some(p => p.currency === body.currency && p.effective_from === body.effective_from)) return send({ code: "payout_policy_exists" }, 409);
      const created = { ...body, id: randomUUID(), created_by: user.user_id, created_at: new Date().toISOString() }; policies.unshift(created); return commit(created, 201);
    }
    if (path === "/v1/commission-rules") {
      if (!has("system_admin")) return send({}, 403);
      if (commissionRules.some(r => r.scope === body.scope && r.scope_id === body.scope_id && r.license_type === body.license_type && r.effective_from === body.effective_from)) return send({ code: "commission_rule_exists" }, 409);
      const created = { ...body, id: randomUUID(), created_by: user.user_id, created_at: new Date().toISOString() } as unknown as (typeof commissionRules)[number]; commissionRules.push(created); return commit(created, 201);
    }
    const templatePath = /^\/v1\/license-templates(?:\/([^/]+))?$/.exec(path);
    if (templatePath) {
      if (!has("system_admin", "rights_officer")) return send({}, 403);
      if (!templatePath[1]) { const id = randomUUID(), created = { ...body, id, version: 1, created_at: new Date().toISOString(), created_by: user.user_id } as unknown as Record<string, unknown> & { id: string; version: number; enabled: boolean }; templates.set(id, [created]); res.setHeader("ETag", '"1"'); return commit(created, 201); }
      const versions = templates.get(templatePath[1]); if (!versions) return send({}, 404);
      const current = versions.at(-1)!;
      if (req.headers["if-match"] !== `"${current.version}"`) return send({}, 412);
      if (body.type !== current.type) return send({ code: "validation_failed" }, 422);
      const next = { ...body, id: current.id, version: current.version + 1, created_at: new Date().toISOString(), created_by: user.user_id } as unknown as typeof current; versions.push(next);
      res.setHeader("ETag", `"${next.version}"`); return commit(next, 200);
    }
    const rulePath = /^\/v1\/notification-rules\/([^/]+)$/.exec(path);
    if (rulePath) {
      if (!has("system_admin")) return send({}, 403);
      const rule = rules.get(rulePath[1]); if (!rule) return send({}, 404);
      if (req.headers["if-match"] !== `"${rule.row_version}"`) return send({}, 412);
      if (req.method === "DELETE") { rules.delete(rule.id); return commit(null); }
      const next = { ...rule, ...body, row_version: rule.row_version + 1, updated_at: new Date().toISOString() }; rules.set(rule.id, next);
      res.setHeader("ETag", `"${next.row_version}"`); return commit(next, 200);
    }
    if (/^\/v1\/users\/[^/]+\/status$/.test(path)) { if (!has("system_admin")) return send({}, 403); return commit(null); }
    const staffName = /^\/v1\/users\/([^/]+)\/work-name$/.exec(path);
    if (staffName && req.method === "PUT") {
      if (!has("system_admin")) return send({}, 403);
      if (staffName[1] === me.user_id || staffName[1].startsWith("91000000")) return send({}, 422);
      return commit(null);
    }
    if (path === "/v1/notifications/read-all" && req.method === "POST") {
      const stamp = new Date().toISOString();
      let read_count = 0;
      for (const item of notifications) if (!item.read_at && Date.parse(item.created_at) <= Date.parse(String(body.before))) { item.read_at = stamp; if (item.state !== "acknowledged") item.state = "read"; read_count++; }
      return commit({ read_count }, 200);
    }
    const notice = /^\/v1\/notifications\/([^/]+)\/(read|ack)$/.exec(path);
    if (notice) { const item = notifications.find(n => n.id === notice[1]); if (!item) return send({}, 404); item.read_at = new Date().toISOString(); item.state = notice[2] === "ack" ? "acknowledged" : "read"; if (notice[2] === "ack") item.acknowledged_at = item.read_at; return commit(null); }
    return send({}, 405);
  }
  if (url.pathname === "/v1/admin/settings/reporter-identity") {
    if (!user.roles.some(role => role.name === "system_admin")) return send({}, 403);
    return send({ ...identitySetting, reporter_legal_name: "never-display-canary" });
  }
  const permissionTrail = /^\/v1\/users\/([^/]+)\/permissions\/history$/.exec(url.pathname);
  if (permissionTrail) {
    if (!user.roles.some(role => role.name === "system_admin")) return send({}, 403);
    if (historyUnavailable) return send({ message: "never-display-canary" }, 404);
    const items = permissionAudit.filter(row => row.target === null || row.target === permissionTrail[1]);
    const start = Number(url.searchParams.get("cursor") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
    return send({ items: items.slice(start, start + limit).map(row => ({ ...row.entry, reason: "never-display-canary", legal_name: "never-display-canary" })), next_cursor: start + limit < items.length ? String(start + limit) : null });
  }
  if (url.pathname === "/v1/uploads") {
    const states = url.searchParams.getAll("state"), wanted = states.length ? states : ["created", "in_progress", "completed"];
    return send({ items: [...uploads.values()].map(u => u.session).filter(s => wanted.includes(s.state)).map(s => ({ ...s, upload_token: "never-display-canary" })).reverse(), next_cursor: null });
  }
  const uploadRead = /^\/v1\/uploads\/([^/]+)$/.exec(url.pathname);
  if (uploadRead) { const upload = uploads.get(uploadRead[1]); return upload ? send(upload.session) : send({}, 404); }
  const listingRead = /^\/v1\/materials\/([^/]+)\/listing$/.exec(url.pathname);
  if (listingRead) {
    if (!user.roles.some(role => ["system_admin", "rights_officer", "editor_in_chief", "finance"].includes(role.name))) return send({}, 403);
    const found = listings.get(listingRead[1]); if (!found) return send({ code: "not_found" }, 404);
    res.setHeader("ETag", `"${found.row}"`); return send({ ...Object.fromEntries(Object.entries(found).filter(([key]) => key !== "row")), internal_note: "never-display-canary" });
  }
  const licenseRead = /^\/v1\/licenses(?:\/([^/]+))?$/.exec(url.pathname);
  if (licenseRead) {
    if (!user.roles.some(role => ["system_admin", "finance", "rights_officer", "buyer_admin", "buyer_member"].includes(role.name))) return send({}, 403);
    const visible = [...issued.values()].filter(l => !user.organization_id || l.organization_id === user.organization_id).map(l => Object.fromEntries(Object.entries(l).filter(([key]) => key !== "downloads")));
    if (!licenseRead[1]) return send({ items: visible, next_cursor: null });
    const found = visible.find(l => l.id === licenseRead[1]); return found ? send(found) : send({}, 404);
  }
  const refundRead = /^\/v1\/orders\/([^/]+)\/refunds$/.exec(url.pathname);
  if (refundRead) {
    if (!user.roles.some(role => ["system_admin", "finance", "buyer_admin"].includes(role.name))) return send({}, 403);
    const order = orders.get(refundRead[1]); if (!order || (user.organization_id && order.organization_id !== user.organization_id)) return send({}, 404);
    return send({ items: refunds.get(order.id) ?? [] });
  }
  const orderRead = /^\/v1\/orders(?:\/([^/]+))?$/.exec(url.pathname);
  if (orderRead) {
    if (!user.roles.some(role => ["system_admin", "finance", "buyer_admin", "buyer_member"].includes(role.name))) return send({}, 403);
    const visible = [...orders.values()].filter(o => !user.organization_id || o.organization_id === user.organization_id).reverse();
    if (!orderRead[1]) return send({ items: visible, next_cursor: null });
    const found = visible.find(o => o.id === orderRead[1]); return found ? send({ ...found, provider_reference: "never-display-canary" }) : send({}, 404);
  }
  const orgRead = /^\/v1\/buyer-organizations(?:\/([^/]+)(\/members)?)?$/.exec(url.pathname);
  if (orgRead) {
    const [, id, isMembers] = orgRead, roles = (...names: string[]) => user.roles.some(role => names.includes(role.name));
    const view = (o: Record<string, unknown>) => ({ ...Object.fromEntries(Object.entries(o).filter(([key]) => key !== "row")), active_members: members.get(String(o.id))!.filter(m => m.status === "active").length });
    if (!id) { if (!roles("system_admin", "finance")) return send({}, 403); const status = url.searchParams.get("status"); return send({ items: [...organizations.values()].filter(o => !status || o.status === status).map(view), next_cursor: null }); }
    const found = organizations.get(id); if (!found || (user.organization_id && user.organization_id !== id)) return send({}, 404);
    if (isMembers) { if (!roles("system_admin", "buyer_admin")) return send({}, 403); return send({ items: members.get(id)!.map(m => ({ ...m, password_hash: "never-display-canary" })) }); }
    if (!roles("system_admin", "finance", "buyer_admin", "buyer_member")) return send({}, 403);
    res.setHeader("ETag", `"${found.row}"`); return send({ ...view(found), internal_note: "never-display-canary" });
  }
  if (url.pathname === "/v1/buyer-invite-conflicts") {
    if (!user.roles.some(role => role.name === "system_admin")) return send({ code: "forbidden_role" }, 403);
    const state = url.searchParams.get("state");
    return send({ items: conflicts.filter(c => !state || c.state === state).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))), next_cursor: null });
  }
  if (url.pathname === "/v1/me/earnings" || url.pathname === "/v1/me/earnings/entries" || url.pathname === "/v1/me/payout-requests") {
    if (!user.roles.some(role => role.name === "reporter")) return send({}, 403);
    if (url.pathname === "/v1/me/earnings") return send(summary(user.user_id));
    if (url.pathname === "/v1/me/payout-requests") return send({ items: payouts.filter(p => p.user_id === user.user_id).map(p => ({ ...p, approvals: p.approvals.map(a => ({ approved_at: a.approved_at })) })), next_cursor: null });
    const state = url.searchParams.get("state"), currency = url.searchParams.get("currency");
    return send({ items: ledger.filter(l => (!state || l.state === state) && (!currency || (l.amount as { currency: string }).currency === currency)), next_cursor: null });
  }
  const userEarnings = /^\/v1\/users\/([^/]+)\/earnings$/.exec(url.pathname);
  if (userEarnings || url.pathname === "/v1/payout-requests" || url.pathname === "/v1/payout-policies") {
    if (!user.roles.some(role => ["system_admin", "finance"].includes(role.name))) return send({}, 403);
    if (userEarnings) return send(summary(userEarnings[1]));
    if (url.pathname === "/v1/payout-policies") return send({ items: [...policies].sort((a, b) => Date.parse(String(b.effective_from)) - Date.parse(String(a.effective_from))) });
    const state = url.searchParams.get("state");
    return send({ items: payouts.filter(p => !state || p.state === state).sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at))).map(p => ({ ...p, provider_reference: "never-display-canary" })), next_cursor: null });
  }
  if (url.pathname === "/v1/commission-rules") {
    if (!user.roles.some(role => ["system_admin", "finance"].includes(role.name))) return send({}, 403);
    const scope = url.searchParams.get("scope");
    return send({ items: commissionRules.filter(r => !scope || r.scope === scope).sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from)) });
  }
  if (url.pathname === "/v1/license-templates" || url.pathname.startsWith("/v1/license-templates/")) {
    if (!user.roles.some(role => ["system_admin", "rights_officer", "editor_in_chief", "finance"].includes(role.name))) return send({}, 403);
    if (url.pathname === "/v1/license-templates") return send({ items: [...templates.values()].map(v => v.at(-1)!).filter(t => t.enabled || url.searchParams.get("include_disabled") === "true") });
    const versions = templates.get(url.pathname.slice("/v1/license-templates/".length)); if (!versions) return send({}, 404);
    const wanted = url.searchParams.get("version"), found = wanted ? versions.find(v => v.version === Number(wanted)) : versions.at(-1);
    if (!found) return send({}, 404); res.setHeader("ETag", `"${found.version}"`); return send(found);
  }
  if (url.pathname === "/v1/notification-rules" || url.pathname.startsWith("/v1/notification-rules/")) {
    if (!user.roles.some(role => ["system_admin", "editor_in_chief"].includes(role.name))) return send({}, 403);
    if (url.pathname === "/v1/notification-rules") return send({ items: [...rules.values()].map(rule => ({ ...rule, secret_note: "never-display-canary" })) });
    const rule = rules.get(url.pathname.slice("/v1/notification-rules/".length)); if (!rule) return send({}, 404);
    res.setHeader("ETag", `"${rule.row_version}"`); return send(rule);
  }
  if (url.pathname === "/v1/dashboard/newsroom") {
    if (!user.roles.some(role => ["supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin"].includes(role.name))) return send({}, 403);
    const count = (key: "editorial_state" | "technical_state" | "rights_state") => Object.entries(materials.reduce<Record<string, number>>((all, m) => ({ ...all, [m[key]]: (all[m[key]] ?? 0) + 1 }), {})).map(([state, count]) => ({ state, count }));
    return send({ generated_at: new Date().toISOString(), editorial: [...count("editorial_state"), { state: "never-display-canary", count: 1 }], technical: count("technical_state"), rights: count("rights_state"),
      urgent_open: materials.filter(m => m.priority === "urgent" && !["published", "rejected"].includes(m.editorial_state)).length,
      reserved: materials.filter(m => m.reserved_by).map(m => ({ material_id: m.id, reserved_by: m.reserved_by, reserved_by_name: m.reserved_by_name ?? null, reserved_at: m.reserved_at, priority: m.priority, editorial_state: m.editorial_state, title: "never-display-canary" })),
      recent_receipts: materials.slice(0, 3).map(m => ({ material_id: m.id, receipt_number: `R-261021-${m.id.slice(-6)}`, verified_at: m.created_at, priority: m.priority })),
      overdue_acknowledgements: 2, oldest_overdue_acknowledgement_at: materials[4].acknowledgement_due_at,
      uploads_in_progress: Array.from({ length: 1 + extraUploadsInProgress }, (_, i) => ({ upload_session_id: `90000000-0000-4000-8000-00000000000${i + 1}`, material_id: materials[4].id, kind: "original", priority: i ? "normal" : "urgent", state: "in_progress", size_bytes: 4000, bytes_received: 1000, updated_at: new Date().toISOString(), filename: "never-display-canary", reporter_id: "never-display-canary" })) });
  }
  if (url.pathname === "/v1/catalog" || url.pathname.startsWith("/v1/catalog/")) {
    if (!user.roles.some(role => ["system_admin", "rights_officer", "editor_in_chief", "finance", "buyer_admin", "buyer_member"].includes(role.name))) return send({}, 403);
    // كتالوج اصطناعي: مادتان، بحقول خارج القائمة البيضاء للتأكد أنها لا تصل إلى المتصفح.
    const text = (ar: string, en: string) => ({ ar, en });
    const offer = (id: string, type: string, amount: number) => ({ license_template_id: `70000000-0000-4000-8000-00000000000${id}`, license_version: 1, type, name: text(type === "exclusive_temporary" ? "حصري 48 ساعة" : "تحريري لاستخدام واحد", type === "exclusive_temporary" ? "Exclusive 48 h" : "Editorial single use"), price: { amount_minor: amount, currency: "USD" }, terms: { type, name: text("شروط اصطناعية", "Synthetic terms"), terms: text("استخدام اصطناعي قبل الشراء", "Synthetic use before purchase"), usage_media: ["tv", "web"], territory: { kind: "worldwide" }, term_days: type === "exclusive_temporary" ? 365 : null, exclusivity_hours: type === "exclusive_temporary" ? 48 : null, deliverables: ["original"], attribution: text("شبكة اصطناعية", "Synthetic network"), prohibitions: ["resale"] } });
    const catalog = [1, 2].map(i => ({ listing_id: `71000000-0000-4000-8000-00000000000${i}`, material_version: 1, title: text(`لقطات اصطناعية ${i}`, `Synthetic footage ${i}`), description: text("وصف اصطناعي", "Synthetic description"),
      shot_list: [{ start_ms: 0, label: text("لقطة عامة", "Wide shot") }, { start_ms: 65000, label: text("لقطة قريبة", "Close-up") }], material_types: ["raw_footage"], governorate: "غزة", shot_on: "2026-10-19T13:45:00Z", duration_ms: 125000, width: 3840, height: 2160,
      verified_on: i === 1 ? "2026-10-21" : null, editorial_approved_on: i === 1 ? "2026-10-22" : null, exclusive_unavailable_until: i === 2 ? "2026-10-29T10:00:00Z" : null, credit: "فلسطين بوست", offers: [offer("1", "editorial_single", 15000), offer("2", "exclusive_temporary", 90000)], exclusive_available: i === 1, listed_at: "2026-10-21T10:00:00Z", reporter_id: "never-display-canary", city: "never-display-canary", gps: { lat: 31.5, lng: 34.4 } }));
    if (url.pathname === "/v1/catalog") { const q = url.searchParams.get("q"); return send({ items: catalog.filter(item => !q || item.title.ar.includes(q) || item.title.en.toLowerCase().includes(q.toLowerCase())), next_cursor: null }); }
    const preview = /^\/v1\/catalog\/([^/]+)\/preview-url$/.exec(url.pathname), id = preview?.[1] ?? url.pathname.slice("/v1/catalog/".length), item = catalog.find(c => c.listing_id === id);
    if (!item) return send({ code: "not_found" }, 404);
    if (!preview) return send(item);
    const signature = randomUUID(), expires = Date.now() + 300000; signed.set(signature, { kind: "proxy", expires });
    return send({ url: `${fixtureOrigin}/derived/fixture?signature=${signature}`, expires_at: new Date(expires).toISOString() });
  }
  if (url.pathname === "/v1/notifications") { const items = url.searchParams.get("unread_only") === "true" ? notifications.filter(n => !n.read_at) : notifications; return send({ items, next_cursor: null, unread_count: notifications.filter(n => !n.read_at).length }); }
  const trail = /^\/v1\/materials\/([^/]+)\/transitions$/.exec(url.pathname);
  if (trail) return send({ items: history.get(trail[1]) ?? [] });
  if (url.pathname === "/v1/forms") {
    if (!user.roles.some(role => ["system_admin", "editor_in_chief"].includes(role.name))) return send({}, 403);
    const current = Math.max(0, ...formVersions.keys());
    return send({ items: [...formVersions.values()].sort((a, b) => b.version - a.version).map(f => ({ version: f.version, field_count: f.fields.length, published_at: f.published_at, is_current: f.version === current })) });
  }
  if (url.pathname === "/v1/forms/current" || /^\/v1\/forms\/[1-9]\d*$/.test(url.pathname)) {
    const version = url.pathname.endsWith("/current") ? Math.max(0, ...formVersions.keys()) : Number(url.pathname.split("/").pop());
    const snapshot = formVersions.get(version); if (!snapshot) return send({}, 404);
    const type = url.searchParams.get("material_type");
    return send({ ...snapshot, fields: snapshot.fields.filter(f => !type || !f.material_types?.length || f.material_types.includes(type as never)) });
  }
  const derivative = /^\/v1\/materials\/([^/]+)\/files\/([^/]+)\/download-url$/.exec(url.pathname);
  if (derivative) {
    const file = materials.find(m => m.id === derivative[1])?.files.find(f => f.id === derivative[2] && f.state === "verified");
    if (!file || (file.kind !== "proxy" && file.kind !== "thumbnail")) return send({ code: "not_found" }, 404);
    const signature = randomUUID(), expires = Date.now() + 300000;
    signed.set(signature, { kind: file.kind, expires: file.kind === "proxy" && expireNextProxy ? 0 : expires });
    if (file.kind === "proxy") expireNextProxy = false;
    return send({ url: `http://127.0.0.1:${process.env.WEB_FIXTURE_PORT ?? 3201}/derived/fixture?signature=${signature}`, expires_at: new Date(expires).toISOString() });
  }
  if (url.pathname === "/v1/materials") {
    let filtered = materials;
    for (const key of ["governorate", "reporter_id", "technical_state", "editorial_state", "rights_state", "priority"] as const) {
      const value = url.searchParams.get(key); if (value) filtered = filtered.filter(m => m[key] === value);
    }
    const after = url.searchParams.get("shot_after"), before = url.searchParams.get("shot_before");
    if (after) filtered = filtered.filter(m => Date.parse(m.shot_at!) >= Date.parse(after));
    if (before) filtered = filtered.filter(m => Date.parse(m.shot_at!) < Date.parse(before));
    const start = Number(url.searchParams.get("cursor") ?? 0), limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
    return send({ items: filtered.slice(start, start + limit).map(m => ({ ...m, gps: { lat: 12.345678, lng: 23.456789 }, protected_source: "never-display-canary", device_id: "never-display-canary" })), next_cursor: start + limit < filtered.length ? String(start + limit) : null });
  }
  const found = materials.find(m => `/v1/materials/${m.id}` === url.pathname);
  if (found) { res.setHeader("ETag", `"${found.row_version}"`); return send(found); }
  return send({ code: "not_found" }, 404);
});
server.listen(Number(process.env.WEB_FIXTURE_PORT ?? 3201), "127.0.0.1", () => console.log("Synthetic API ready"));
process.once("SIGTERM", () => server.close());
