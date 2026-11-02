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
// السجل أعداد فقط: لا معرّف ولا عنوان ولا اسم ملف.
import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import pg from "pg";
import Redis from "ioredis";

const STREAM = "media:events", GROUP = "media", DEAD = "media:dead";
const env = process.env;
const GIB = 2 ** 30, MIB = 2 ** 20;
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

// أصل متحقق لمادة، ملفه verified، فيديو أو بلا نوع معلن (الصور يتحقق منها الخادم ولا يصنع لها العامل شيئًا)،
// وليس له نسخة خفيفة متحققة من الخادم. العاجل أولًا (ADR 0075)، ثم الأقدم تحققًا.
const ELIGIBLE = `
  SELECT us.id AS session_id, us.material_id
  FROM upload_sessions us
  JOIN material_files f ON f.id = us.file_id AND f.state = 'verified'
  JOIN materials m ON m.id = us.material_id
  WHERE us.kind = 'original' AND us.state = 'verified'
    AND (f.mime_type IS NULL OR f.mime_type LIKE 'video/%')
    AND NOT EXISTS (SELECT 1 FROM material_files d
                    WHERE d.derived_from_id = f.id AND d.kind = 'proxy' AND d.state = 'verified')
  ORDER BY (m.priority = 'urgent') DESC, f.verified_at, us.id`;

const fields = (flat) => Object.fromEntries(Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]));

/** ما في الطابور للعامل: ما لم يأخذه بعد، وما أخذه ولم يُقرّه. null = العامل لم ينشئ مجموعته بعد. */
async function backlog(r) {
  let groups;
  try {
    groups = (await r.xinfo("GROUPS", STREAM)).map(fields);
  } catch {
    return null;
  }
  const g = groups.find((x) => x.name === GROUP);
  if (!g) return null;
  const next = await r.xrange(STREAM, `(${g["last-delivered-id"]}`, "+", "COUNT", 1);
  return { waiting: next.length, in_progress: Number(g.pending) };
}

/** الجلسات التي عزلها العامل في media:dead: لا تُعاد آليًا (requeue-dead يعيدها يدويًا). */
async function deadSessions(r) {
  const out = new Set();
  for (const [, flat] of await r.xrange(DEAD, "-", "+")) {
    try {
      const id = JSON.parse(fields(flat).event ?? "{}")?.payload?.upload_session_id;
      if (id) out.add(id);
    } catch {
      /* حدث تالف في الموتى لا يخص الموزّع */
    }
  }
  return out;
}

async function enqueue(r, row) {
  if ((await r.set(`media:feed:${row.session_id}`, "1", "EX", retryS, "NX")) !== "OK") return false;
  const event = {
    id: `feed-${randomUUID()}`, type: "upload.original_received", aggregate_type: "upload", aggregate_id: row.session_id,
    occurred_at: new Date().toISOString(), payload: { material_id: row.material_id, upload_session_id: row.session_id, kind: "original" },
  };
  try {
    await r.xadd(STREAM, "MAXLEN", "~", "1000", "*", "event_id", event.id, "event", JSON.stringify(event));
  } catch (err) {
    await r.del(`media:feed:${row.session_id}`).catch(() => {});
    throw err;
  }
  return true;
}

function freeBytes() {
  const s = statfsSync(diskPath);
  return s.bavail * s.bsize;
}

let lastState = "";
async function cycle(db, r) {
  const free = freeBytes();
  const dead = await deadSessions(r);
  const rows = (await db.query(ELIGIBLE)).rows.filter((x) => !dead.has(x.session_id));
  const b = await backlog(r);
  const stats = {
    eligible: rows.length, waiting: b?.waiting ?? 0, in_progress: b?.in_progress ?? 0, dead: dead.size, enqueued: 0,
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
  // الحلقة تسجّل عند التغيّر وحده (إيقاف القرص واستئنافه، وكل حدث جديد)، والدورة الواحدة تطبع دائمًا
  if (mode === "--once" || stats.enqueued || (stats.state !== lastState && stats.state !== "worker_busy")) {
    say({ msg: stats.state === "paused_low_disk" ? "free disk under the threshold: no new media job" : "media feed", ...stats });
  }
  lastState = stats.state;
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
