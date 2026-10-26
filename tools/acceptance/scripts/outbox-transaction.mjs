// ثابت معاملة Outbox: كل كتابة مغطاة تترك حدثًا واحدًا، وفشل الحدث يعيد الكتابة كلها.
// يقرأ قاعدة محلية فقط. إثبات الذرّية يحتاج OUTBOX_FAULT_INJECTION=1 وصلاحية إنشاء مشغّل مؤقت في القاعدة المؤقتة.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { canon, client, createUploadSession, materialBody } from "../lib/live.mjs";

const eventRows = (db, aggregateType, aggregateId) => db.query(
  "SELECT type, idempotency_key FROM outbox_events WHERE aggregate_type = $1 AND aggregate_id = $2 ORDER BY id",
  [aggregateType, aggregateId],
);
const types = (rows) => rows.map((r) => r.type);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const TEMP_DATABASE = /(?:^|_)(?:acceptance|test|tmp|temp)(?:_|$)/i;

/** حارس ما قبل الاتصال: لا حقن إلا في loopback أو خدمة compose معلنة صراحة، وقاعدة اسمها مؤقت. */
export function assertOutboxFaultTarget(databaseUrl, composeService = "") {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("OUTBOX_DATABASE_URL must be PostgreSQL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const declaredService = composeService && host === composeService && /^[a-z0-9][a-z0-9_-]*$/i.test(composeService);
  if (!LOOPBACK.has(host) && !declaredService) {
    throw new Error("REFUSED: outbox fault injection needs a loopback database or OUTBOX_COMPOSE_SERVICE matching its host");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!TEMP_DATABASE.test(database)) throw new Error("REFUSED: outbox fault injection needs a temporary/test database name");
  return { host, database };
}

/** حارس المحتوى بعد الاتصال وقبل DDL: حسابات الاختبار المصطنعة وحدها. */
export async function assertSyntheticOutboxDatabase(db) {
  const result = await db.query("SELECT count(*)::int AS count FROM users WHERE email !~* '@(example\\.test|example\\.invalid)$'");
  if (result.rows[0].count !== 0) throw new Error("REFUSED: outbox fault injection requires a database containing synthetic test users only");
}

export async function injectMaterialOutboxFailure({ db, http, token, formVersion }) {
  const me = await http.get(token, "/auth/me");
  if (me.status !== 200 || !/^[0-9a-f-]{36}$/i.test(me.body?.user_id ?? "")) throw new Error("cannot identify the synthetic reporter for fault injection");
  const actorId = me.body.user_id;
  await assertSyntheticOutboxDatabase(db);
  const suffix = randomUUID().replaceAll("-", "");
  const fn = `acceptance_outbox_fault_${suffix}`;
  const tr = `acceptance_outbox_fault_${suffix}`;
  const title = `outbox-rollback-${randomUUID()}`;
  const body = materialBody(formVersion, title);
  const before = await db.query("SELECT count(*)::int AS count FROM outbox_events WHERE actor_id = $1 AND type = 'material.created'", [actorId]);
  let status = null;
  try {
    await db.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $acceptance$
      BEGIN
        IF NEW.type = 'material.created' AND NEW.actor_id = '${actorId}'::uuid THEN
          RAISE EXCEPTION 'injected acceptance outbox failure';
        END IF;
        RETURN NEW;
      END
    $acceptance$`);
    await db.query(`CREATE TRIGGER ${tr} BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    const response = await http.call(token, "POST", "/materials", { body, key: randomUUID() });
    status = response.status;
  } finally {
    try {
      await db.query(`DROP TRIGGER IF EXISTS ${tr} ON public.outbox_events`);
    } finally {
      await db.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
    }
  }
  const materials = await db.query("SELECT count(*)::int AS count FROM materials WHERE title = $1", [title]);
  const after = await db.query("SELECT count(*)::int AS count FROM outbox_events WHERE actor_id = $1 AND type = 'material.created'", [actorId]);
  const rejected = status !== null && status >= 400;
  const rolledBack = materials.rows[0].count === 0 && after.rows[0].count === before.rows[0].count;
  return { ok: rejected && rolledBack, status, material_count: materials.rows[0].count, event_delta: after.rows[0].count - before.rows[0].count };
}

export async function checkOutbox({ http, db, tokens, faultInjection = false }) {
  const fails = [];
  const check = (name, ok, detail = "") => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ""}`); };
  const form = await http.get(tokens.reporter, "/forms/current");
  check("current form", form.status === 200, `status ${form.status}`);
  if (form.status !== 200) return { fails, metrics: { writes_checked: 0 }, atomicity: null };

  const title = `outbox-${randomUUID()}`;
  const key = randomUUID();
  const body = materialBody(form.body.version, title);
  const first = await http.call(tokens.reporter, "POST", "/materials", { body, key });
  const replay = await http.call(tokens.reporter, "POST", "/materials", { body, key });
  check("material created", first.status === 201, `status ${first.status}`);
  check("material replay identical", replay.status === first.status && canon(replay.body) === canon(first.body));
  if (first.status !== 201) return { fails, metrics: { writes_checked: 0 }, atomicity: null };
  const materialId = first.body.id;
  let materialEvents = (await eventRows(db, "material", materialId)).rows;
  check("material.created persisted once", types(materialEvents).filter((t) => t === "material.created").length === 1, types(materialEvents).join(","));

  const bytes = Buffer.alloc(1024, 3);
  const uploadKey = randomUUID();
  const upload = await createUploadSession(http, tokens.reporter, { materialId, bytes, filename: "synthetic.bin", key: uploadKey });
  const uploadReplay = await createUploadSession(http, tokens.reporter, { materialId, bytes, filename: "synthetic.bin", key: uploadKey });
  check("upload created", upload.status === 201, `status ${upload.status}`);
  check("upload replay returns same session", uploadReplay.status === upload.status && uploadReplay.body?.id === upload.body?.id);
  let uploadEvents = [];
  if (upload.status === 201) {
    uploadEvents = (await eventRows(db, "upload", upload.body.id)).rows;
    check("upload.started persisted once", types(uploadEvents).filter((t) => t === "upload.started").length === 1, types(uploadEvents).join(","));
  }

  const transitionKey = randomUUID();
  const transitionBody = { track: "editorial", to: "acknowledged", reason: "acceptance synthetic transition" };
  const transition = await http.call(tokens.supervisor, "POST", `/materials/${materialId}/transitions`, { body: transitionBody, key: transitionKey });
  const transitionReplay = await http.call(tokens.supervisor, "POST", `/materials/${materialId}/transitions`, { body: transitionBody, key: transitionKey });
  check("editorial transition written", transition.status === 200, `status ${transition.status}`);
  check("transition replay identical", transitionReplay.status === transition.status && canon(transitionReplay.body) === canon(transition.body));
  materialEvents = (await eventRows(db, "material", materialId)).rows;
  check("transition event persisted once", types(materialEvents).filter((t) => t === "material.editorial_transition").length === 1, types(materialEvents).join(","));
  check("material.created remains unique after all replays", types(materialEvents).filter((t) => t === "material.created").length === 1);
  check("upload.started remains unique after replay", types(uploadEvents).filter((t) => t === "upload.started").length <= 1);

  let atomicity = null;
  if (faultInjection) atomicity = await injectMaterialOutboxFailure({ db, http, token: tokens.reporter, formVersion: form.body.version });
  if (atomicity) check("outbox failure rolls back material write", atomicity.ok, JSON.stringify(atomicity));
  const duplicateEvents = [
    types(materialEvents).filter((t) => t === "material.created").length,
    types(materialEvents).filter((t) => t === "material.editorial_transition").length,
    types(uploadEvents).filter((t) => t === "upload.started").length,
  ].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return {
    fails,
    atomicity,
    metrics: {
      writes_checked: 3,
      material_outbox_rows: materialEvents.length,
      upload_outbox_rows: uploadEvents.length,
      replay_duplicate_events: duplicateEvents,
      atomicity_checked: Boolean(atomicity),
      atomicity_rollback: atomicity?.ok ?? "unmeasured",
      failures: fails.length,
    },
  };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("outbox-transaction"));
  if (!env.OUTBOX_API_URL || !env.OUTBOX_TOKENS || !env.OUTBOX_DATABASE_URL) {
    console.error("ENVIRONMENT: OUTBOX_API_URL, OUTBOX_TOKENS and OUTBOX_DATABASE_URL are required; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.OUTBOX_TOKENS);
  if (!tokens.reporter || !tokens.supervisor) throw new Error("OUTBOX_TOKENS needs reporter and supervisor tokens");
  const faultInjection = env.OUTBOX_FAULT_INJECTION === "1";
  if (faultInjection) assertOutboxFaultTarget(env.OUTBOX_DATABASE_URL, env.OUTBOX_COMPOSE_SERVICE ?? "");
  const db = new pg.Client({ connectionString: env.OUTBOX_DATABASE_URL });
  await db.connect();
  try {
    const outcome = await checkOutbox({ http: client(env.OUTBOX_API_URL), db, tokens, faultInjection });
    const failed = outcome.fails.length > 0;
    outcome.fails.forEach((f) => console.log(`FAIL ${f}`));
    const doc = newResult("outbox-transaction", { device: { platform: "server" }, upload_path: "n/a" });
    finish(doc, failed ? "fail" : outcome.atomicity ? "pass" : "partial", outcome.metrics,
      outcome.atomicity ? "تحقق حي من أحداث إنشاء المادة والرفع والانتقال، ومن عدم تكرارها، ومن رجوع المادة عند إخفاق إدراج الحدث بمشغّل مؤقت في قاعدة اصطناعية." : "تحقق حي من وجود الأحداث وعدم تكرارها؛ إثبات الذرّية بحقن الفشل لم يُنفَّذ، لذا النتيجة جزئية. فعّله فقط على قاعدة محلية مؤقتة.");
    if (args["dry-run"]) writeResult(doc, { dryRun: true });
    else console.log("wrote", writeResult(doc, { slug: outcome.atomicity ? "atomicity" : "events" }));
    return { code: failed ? 1 : 0, doc };
  } finally {
    await db.end();
  }
}
