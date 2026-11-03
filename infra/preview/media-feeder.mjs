// موزّع مهام عامل الوسائط على المعاينة الخفيفة (ADR 0092)، داخل صورة الخادم (pg وioredis من اعتمادياته):
//   node preview/media-feeder.mjs --loop    # الخدمة media-feeder: دورة كل MEDIA_FEED_INTERVAL_S ثانية
//   node preview/media-feeder.mjs --once    # دورة واحدة تطبع أعدادها (backfill-media.sh)
// الخادم يبقى المتحقق (UPLOAD_VERIFIER=in_process) فلا تنكسر الصور ولا يتوقف الرفع إن توقف العامل. الموزّع يجد الأصول
// المتحققة من نوع فيديو بلا نسخة خفيفة متحققة، العاجل أولًا، ويضع لكل منها حدث upload.original_received على media:events
// (الطابور الداخلي نفسه): العامل يجد الجلسة verified فيسلك مسار الاستئناف (ينزّل الأصل ويطابق بصمته المسجلة ثم يبني
// النسخة الخفيفة والمصغّرات ويسجّلها عبر /internal/media). متكرر بأمان:
// - حدث واحد ينتظر على الأكثر: لا يُضاف جديد ما دام في الطابور ما لم يأخذه العامل؛
// - مفتاح media:feed:<الجلسة> (NX، يعيش MEDIA_FEED_RETRY_S) يمنع تكرار الجلسة، وما نُقل إلى media:dead لا يُعاد؛
// - حارس القرص: لا مهمة جديدة والمساحة الحرة على قرص الحجوم (MEDIA_DISK_PATH) دون MEDIA_MIN_FREE_GIB، فتبقى المادة
//   معلّقة في القاعدة وتُعاد في الدورة التالية حين تتسع المساحة.
// - الأصل الذي له نسخته الخفيفة ولا بيانات فنية له (عولج قبل أن يسجّل الخادم فحص العامل، ملحق ADR 0092) يُعطى مرة بعد
//   الأصول التي بلا نسخة، بمفتاح media:feed:probe:<الجلسة>: العامل يعيد فحصه فيسجّل الخادم بياناته، ويسجّل النسخة
//   الموجودة كما هي بلا ترميز جديد.
// ونسخ قالب «مواد متداولة» (ADR 0091، ملحق ADR 0092): الخادم لا ينشر render.requested إلى Redis مع in_process، فالموزّع
// يعطي حاوية media-render النسخة المطلوبة (requested) الأقدم على media:renders، بالقواعد نفسها (حدث واحد ينتظر على الأكثر،
// ومفتاح media:feed:render:<النسخة>، وما في media:dead لا يُعاد)، وحارس قرص لكل مهمة: ميزانية ADR 0091 (حجم الأصل + 1 GiB)
// فوق MEDIA_MIN_FREE_GIB، وإلا تبقى requested وتُعاد في الدورة التالية.
// السجل أعداد فقط: لا معرّف ولا عنوان ولا اسم ملف.
import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import pg from "pg";
import Redis from "ioredis";

const STREAM = "media:events", GROUP = "media", DEAD = "media:dead";
const RENDER_STREAM = "media:renders", RENDER_GROUP = "render";
const env = process.env;
const GIB = 2 ** 30, MIB = 2 ** 20;
// ميزانية القرص لنسخة القالب فوق حجم أصلها: الطبقة القصيرة والناتج وهامش (ADR 0091 البند 5)
const RENDER_MARGIN = GIB;
const minFree = Number(env.MEDIA_MIN_FREE_GIB ?? 8) * GIB;
const diskPath = env.MEDIA_DISK_PATH ?? "/disk";
const intervalMs = Number(env.MEDIA_FEED_INTERVAL_S ?? 10) * 1000;
const retryS = Number(env.MEDIA_FEED_RETRY_S ?? 86400);
const mode = process.argv[2];
if (!["--loop", "--once"].includes(mode) || !(minFree > 0) || !(intervalMs >= 1000) || !(retryS >= 60)) {
  console.error("usage: media-feeder.mjs --loop|--once (MEDIA_MIN_FREE_GIB > 0, MEDIA_FEED_INTERVAL_S >= 1, MEDIA_FEED_RETRY_S >= 60)");
  process.exit(2);
}
const say = (fields) => console.log(JSON.stringify({ logger: "media_feeder", ...fields }));

// أصل متحقق لمادة، ملفه verified، فيديو أو بلا نوع معلن (الصور يتحقق منها الخادم ولا يصنع لها العامل شيئًا)، وليس له
// نسخة خفيفة متحققة من الخادم، أو له ولا بيانات فنية له (probe). ما بلا نسخة أولًا، ثم العاجل (ADR 0075)، ثم الأقدم تحققًا.
const ELIGIBLE = `
  SELECT * FROM (
    SELECT us.id AS session_id, us.material_id, m.priority, f.verified_at,
           EXISTS (SELECT 1 FROM material_files d
                   WHERE d.derived_from_id = f.id AND d.kind = 'proxy' AND d.state = 'verified') AS has_proxy,
           (f.technical IS NULL OR f.duration_ms IS NULL) AS unprobed
    FROM upload_sessions us
    JOIN material_files f ON f.id = us.file_id AND f.state = 'verified'
    JOIN materials m ON m.id = us.material_id
    WHERE us.kind = 'original' AND us.state = 'verified'
      AND (f.mime_type IS NULL OR f.mime_type LIKE 'video/%')
  ) x
  WHERE NOT has_proxy OR unprobed
  ORDER BY has_proxy, (priority = 'urgent') DESC, verified_at, session_id`;

// النسخ المطلوبة التي لم يلتقطها العامل، الأقدم أولًا، بحجم أصلها المتحقق (ميزانية القرص).
const RENDERS = `
  SELECT r.id AS render_id, r.material_id, r.source_file_id, r.requested_by, coalesce(f.size_bytes, 0) AS size_bytes
  FROM material_renders r
  JOIN material_files f ON f.id = r.source_file_id
  WHERE r.state = 'requested'
  ORDER BY r.requested_at, r.id`;

const fields = (flat) => Object.fromEntries(Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]));

/** ما في الطابور لعامله: ما لم يأخذه بعد، وما أخذه ولم يُقرّه. null = العامل لم ينشئ مجموعته بعد. */
async function backlog(r, stream = STREAM, group = GROUP) {
  let groups;
  try {
    groups = (await r.xinfo("GROUPS", stream)).map(fields);
  } catch {
    return null;
  }
  const g = groups.find((x) => x.name === group);
  if (!g) return null;
  const next = await r.xrange(stream, `(${g["last-delivered-id"]}`, "+", "COUNT", 1);
  return { waiting: next.length, in_progress: Number(g.pending) };
}

/** الجلسات والنسخ التي عزلها العاملان في media:dead: لا تُعاد آليًا (requeue-dead يعيدها يدويًا). */
async function deadIds(r) {
  const sessions = new Set(), renders = new Set();
  for (const [, flat] of await r.xrange(DEAD, "-", "+")) {
    try {
      const payload = JSON.parse(fields(flat).event ?? "{}")?.payload ?? {};
      if (payload.upload_session_id) sessions.add(payload.upload_session_id);
      if (payload.render_id) renders.add(payload.render_id);
    } catch {
      /* حدث تالف في الموتى لا يخص الموزّع */
    }
  }
  return { sessions, renders };
}

async function enqueue(r, row) {
  const key = row.has_proxy ? `media:feed:probe:${row.session_id}` : `media:feed:${row.session_id}`;
  if ((await r.set(key, "1", "EX", retryS, "NX")) !== "OK") return false;
  const event = {
    id: `feed-${randomUUID()}`, type: "upload.original_received", aggregate_type: "upload", aggregate_id: row.session_id,
    occurred_at: new Date().toISOString(), payload: { material_id: row.material_id, upload_session_id: row.session_id, kind: "original" },
  };
  try {
    await r.xadd(STREAM, "MAXLEN", "~", "1000", "*", "event_id", event.id, "event", JSON.stringify(event));
  } catch (err) {
    await r.del(key).catch(() => {});
    throw err;
  }
  return true;
}

// حدث render.requested كما ينشره الخادم مع العامل الخارجي (المعرّفات وحدها)؛ العامل يقرأ المعاملات من /internal/media/renders.
async function enqueueRender(r, row) {
  const key = `media:feed:render:${row.render_id}`;
  if ((await r.set(key, "1", "EX", retryS, "NX")) !== "OK") return false;
  const event = {
    id: `feed-${randomUUID()}`, type: "render.requested", aggregate_type: "material", aggregate_id: row.material_id,
    occurred_at: new Date().toISOString(),
    payload: { material_id: row.material_id, render_id: row.render_id, source_file_id: row.source_file_id, requested_by: row.requested_by },
  };
  try {
    await r.xadd(RENDER_STREAM, "MAXLEN", "~", "1000", "*", "event_id", event.id, "event", JSON.stringify(event));
  } catch (err) {
    await r.del(key).catch(() => {});
    throw err;
  }
  return true;
}

/** نسخة واحدة على الأكثر لحاوية media-render، والقرص يتسع لميزانيتها فوق الحد الأدنى؛ الأعداد وحدها. */
async function renderCycle(db, r, free, dead) {
  const rows = (await db.query(RENDERS)).rows.filter((x) => !dead.has(x.render_id));
  const b = await backlog(r, RENDER_STREAM, RENDER_GROUP);
  const need = rows.length ? minFree + Number(rows[0].size_bytes) + RENDER_MARGIN : minFree + RENDER_MARGIN;
  const stats = {
    eligible: rows.length, waiting: b?.waiting ?? 0, in_progress: b?.in_progress ?? 0, enqueued: 0, need_mb: Math.floor(need / MIB),
    state: b === null ? "worker_not_ready" : b.waiting > 0 ? "worker_busy" : "ready",
  };
  if (stats.state !== "ready") return stats;
  for (const row of rows) {
    const budget = minFree + Number(row.size_bytes) + RENDER_MARGIN;
    stats.need_mb = Math.floor(budget / MIB);
    if (free < budget) {
      stats.state = "paused_low_disk";
      break;
    }
    if (await enqueueRender(r, row)) {
      stats.enqueued = 1;
      break;
    }
  }
  return stats;
}

function freeBytes() {
  const s = statfsSync(diskPath);
  return s.bavail * s.bsize;
}

let lastState = "", lastRenderState = "";
async function cycle(db, r) {
  const free = freeBytes();
  const dead = await deadIds(r);
  const rows = (await db.query(ELIGIBLE)).rows.filter((x) => !dead.sessions.has(x.session_id));
  const b = await backlog(r);
  const stats = {
    eligible: rows.length, waiting: b?.waiting ?? 0, in_progress: b?.in_progress ?? 0, dead: dead.sessions.size + dead.renders.size, enqueued: 0,
    free_mb: Math.floor(free / MIB), min_free_mb: Math.floor(minFree / MIB),
    state: free < minFree ? "paused_low_disk" : b === null ? "worker_not_ready" : b.waiting > 0 ? "worker_busy" : "ready",
  };
  if (stats.state === "ready") {
    for (const row of rows) {
      if (await enqueue(r, row)) {
        stats.enqueued = 1;
        break;
      }
    }
  }
  stats.renders = await renderCycle(db, r, free, dead.renders);
  const rs = stats.renders.state;
  // الحلقة تسجّل عند التغيّر وحده (إيقاف القرص واستئنافه، وكل حدث جديد)، والدورة الواحدة تطبع دائمًا
  const changed = (s, last) => s !== last && s !== "worker_busy";
  if (mode === "--once" || stats.enqueued || stats.renders.enqueued || changed(stats.state, lastState) || changed(rs, lastRenderState)) {
    const low = [stats.state === "paused_low_disk" && "media job", rs === "paused_low_disk" && "render"].filter(Boolean);
    say({ msg: low.length ? `free disk under the threshold: no new ${low.join(" or ")}` : "media feed", ...stats });
  }
  lastState = stats.state;
  lastRenderState = rs;
  return stats;
}

// مجمّع باتصال واحد يعيد الاتصال بعد إعادة تشغيل القاعدة؛ وأخطاء الاتصال الخاملة لا تُسقط العملية
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, idleTimeoutMillis: 30000 });
db.on("error", () => {});
const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
r.on("error", () => {});
let stopped = false;
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { stopped = true; });
if (mode === "--once") {
  try {
    await cycle(db, r);
  } finally {
    await db.end();
    r.disconnect();
  }
} else {
  say({ msg: "media feeder started", interval_s: intervalMs / 1000, min_free_mb: Math.floor(minFree / MIB) });
  while (!stopped) {
    try {
      await cycle(db, r);
    } catch (err) {
      // اسم الخطأ وحده: رسائل الأخطاء قد تحمل قيمًا
      say({ msg: "media feed cycle failed", error: err?.name ?? "Error" });
    }
    for (let waited = 0; waited < intervalMs && !stopped; waited += 500) await new Promise((res) => setTimeout(res, 500));
  }
  await db.end().catch(() => {});
  r.disconnect();
}
