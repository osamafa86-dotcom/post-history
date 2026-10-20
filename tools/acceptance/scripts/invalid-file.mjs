// invalid-file: an invalid upload is rejected clearly, without hanging the system or losing the rest of the batch.
// Server side only: it drives the internal tusd hook (ADR SEC-06) with the requests tusd would send. What a
// corrupt or unsupported media file does after upload belongs to the media worker and is not measured here.
//   HOOK_BASE_URL=http://127.0.0.1:13000  HOOK_TOKEN=<TUSD_HOOK_SECRET>  HOOK_SESSIONS='{"ok":[{id,token,size}×4],"expired":{…},"finished":{…}}'
//   HOOK_OBJECT_PREFIX=tus/  HOOK_BUCKET=uploads
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, eventsOfType, materialBody, percentile } from "../lib/live.mjs";
import { hookClient, simulateUpload, waitFor } from "../lib/hooks.mjs";
import { s3FromEnv } from "../lib/s3.mjs";
import { createHash } from "node:crypto";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("invalid-file"));
  const doc = newResult("invalid-file", { device: { platform: "server" }, upload_path: "tusd" });
  if (!env.HOOK_BASE_URL || !env.HOOK_TOKEN) {
    console.error("ENVIRONMENT: HOOK_BASE_URL and HOOK_TOKEN are required; nothing measured");
    return { code: 2, doc: null };
  }
  const S = JSON.parse(env.HOOK_SESSIONS ?? "{}");
  const prefix = env.HOOK_OBJECT_PREFIX ?? "tus/", bucket = env.HOOK_BUCKET ?? "uploads";
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } };

  const hc = hookClient({ baseUrl: env.HOOK_BASE_URL, token: env.HOOK_TOKEN });
  const latencies = hc.latencies;
  const hook = (type, { id, token: bearer, ...rest } = {}) => hc.call(type, { id, bearer, ...rest });
  const rejected = (r) => r.status === 200 && r.body?.RejectUpload === true;
  const accepted = (r) => r.status === 200 && r.body?.RejectUpload === false;
  const [ok1, ok2, ok3, ok4] = S.ok ?? [];
  const wrongToken = "not-the-token-" + randomUUID();

  // each invalid shape is rejected with a clear 4xx-style hook response, never a 5xx or a hang
  check("wrong upload token is rejected", rejected(await hook("pre-create", { id: ok4.id, token: wrongToken, size: ok4.size })));
  check("missing Authorization is rejected", rejected(await hook("pre-create", { id: ok4.id, size: ok4.size })));
  check("unknown session is rejected", rejected(await hook("pre-create", { id: randomUUID(), token: ok4.token, size: ok4.size })));
  check("size that differs from the session is rejected", rejected(await hook("pre-create", { id: ok4.id, token: ok4.token, size: ok4.size + 1 })));
  check("expired session is rejected", rejected(await hook("pre-create", { id: S.expired.id, token: S.expired.token, size: S.expired.size })));
  check("already finished session is rejected", rejected(await hook("pre-create", { id: S.finished.id, token: S.finished.token, size: S.finished.size })));
  const malformed = await hook("pre-create", { raw: { Type: "pre-create" } });
  check("malformed hook body is 422, not a server error", malformed.status === 422, `status ${malformed.status}`);
  const badPath = await hook("pre-create", { id: ok4.id, token: ok4.token, size: ok4.size, path: "wrong-" + randomUUID() });
  check("wrong hook path token is 401", badPath.status === 401, `status ${badPath.status}`);

  // a batch mixing bad and good files: the bad ones fail, every good one is still accepted and bound to its own session
  const order = [
    ["bad token", { id: ok4.id, token: wrongToken, size: ok4.size }, false],
    ["good 1", ok1, true], ["bad size", { id: ok4.id, token: ok4.token, size: 5 }, false],
    ["good 2", ok2, true], ["bad session", { id: randomUUID(), token: ok3.token, size: ok3.size }, false], ["good 3", ok3, true],
  ];
  let accepted3 = 0;
  for (const [label, s, good] of order) {
    const r = await hook("pre-create", { id: s.id, token: s.token, size: s.size });
    if (good) { check(`batch: ${label} still accepted`, accepted(r) && r.body?.ChangeFileInfo?.ID === s.id, JSON.stringify(r.body)); if (accepted(r)) accepted3++; }
    else check(`batch: ${label} rejected`, rejected(r));
  }
  // a storage mismatch on post-finish fails that session only; its neighbours still complete
  const mismatch = await hook("post-finish", { id: ok2.id, size: ok2.size, storage: { Type: "s3store", Bucket: bucket, Key: `${prefix}someone-elses-object` } });
  check("post-finish with a foreign storage key is handled (200), not a 5xx", mismatch.status === 200, `status ${mismatch.status}`);
  const good1 = await hook("post-finish", { id: ok1.id, size: ok1.size, storage: { Type: "s3store", Bucket: bucket, Key: `${prefix}${ok1.id}` } });
  check("post-finish for the good neighbour completes", good1.status === 200 && good1.body?.RejectUpload !== true, `status ${good1.status}`);
  const retry = await hook("post-finish", { id: ok1.id, size: ok1.size, storage: { Type: "s3store", Bucket: bucket, Key: `${prefix}${ok1.id}` } });
  check("tusd retrying post-finish is harmless (200)", retry.status === 200);
  const reuse = await hook("pre-create", { id: ok2.id, token: ok2.token, size: ok2.size });
  check("a session failed with storage_error cannot be created again", rejected(reuse));

  // Phase 2 (needs S3, the database and the API): files that arrive and then turn out to be invalid end in `failed`
  // with the right reason, the material's original track fails, and a good file in the same batch is still verified.
  const s3 = s3FromEnv(env);
  const full = s3 && env.INVALID_API_URL;
  const reasons = {};
  if (full) {
    const tokens = JSON.parse(env.INVALID_TOKENS ?? "{}");
    const http = client(env.INVALID_API_URL);
    try {
      await s3.ensureBucket(bucket);
      const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
      const mk = async (tag) => { const r = await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `invalid-${tag}-${randomUUID().slice(0, 8)}`) }); if (r.status !== 201) throw new Error(`create material failed: ${r.status} ${r.text.slice(0, 200)}`); return r.body; };
      const good = Buffer.alloc(300_000, 7), sha = (b) => createHash("sha256").update(b).digest("hex");
      const cases = [
        // `declared` is the file the phone says it is sending (its size and SHA-256 go to POST /uploads); `bytes` is what arrives
        ["good", { size: good.length, declared: good, bytes: good }, null],
        ["checksum_mismatch", { size: good.length, declared: good, bytes: good, clientSha256: sha(Buffer.from("something else")) }, "checksum_mismatch"],
        ["storage_error", { size: good.length, declared: good, bytes: null }, "storage_error"],
        ["invalid_file", { size: good.length + 10, declared: good, bytes: good }, "invalid_file"],
        ["good again", { size: good.length, declared: good, bytes: good }, null],
      ];
      const made = [];
      for (const [label, c, expected] of cases) {
        const mat = await mk(label.replace(/\W/g, ""));
        const session = await createUploadSession(http, tokens.reporter, { materialId: mat.id, size: c.size, clientSha256: c.clientSha256 ?? sha(c.declared) });
        await simulateUpload({ hooks: hc, s3, bucket, prefix, session, bytes: c.bytes });
        made.push({ label, mat, session, expected });
      }
      for (const x of made) {
        const outcome = await waitFor(async () => {
          for (const type of ["upload.failed", "upload.verified"]) {
            const hit = (await eventsOfType(http, tokens.system_admin, type)).find((e) => e.aggregate_id === x.session.id);
            if (hit) return hit;
          }
          return null;
        }, { timeoutMs: 30_000 });
        const ev = outcome.value;
        if (x.expected) {
          reasons[x.expected] = ev?.type === "upload.failed" && ev.payload.failure_reason === x.expected;
          check(`${x.label}: upload.failed with reason ${x.expected}`, reasons[x.expected], ev ? `${ev.type} ${ev.payload.failure_reason ?? ""}` : "no event");
          const orig = (await http.get(tokens.reporter, `/materials/${x.mat.id}`)).body;
          check(`${x.label}: the material's technical state is failed`, orig.technical_state === "failed", `state ${orig.technical_state}`);
        } else check(`${x.label}: still verified in the same batch`, ev?.type === "upload.verified", ev ? ev.type : "no event");
      }
    } finally { /* nothing to close: no direct database access */ }
  }

  latencies.sort((a, b) => a - b);
  const p95 = percentile(latencies, 95);
  check("no hook call is slow (p95 under 2000 ms)", p95 < 2000, `p95 ${p95} ms`);

  finish(doc, fails.length ? "fail" : "partial", {
    hook_calls: latencies.length, hook_latency_ms_p50: percentile(latencies, 50), hook_latency_ms_p95: p95, hook_latency_ms_max: latencies.at(-1),
    batch_good_files_accepted: accepted3, batch_good_files_expected: 3, failures: fails.length,
    failed_reasons_checked: full ? Object.keys(reasons).join(",") : "none",
  }, [full ? "المرحلة 2: ملفات وصلت ثم ثبت أنها غير صالحة (بصمة العميل، غياب الكائن، اختلاف الحجم) انتهت إلى failed بسببها الصحيح مع بقاء الجيد في الدفعة نفسها" : "المرحلة 2 (الوصول إلى failed) لم تُشغَّل: تحتاج S3 وواجهة الخادم", "لم يُقَس رفض الملف التالف أو الترميز غير المدعوم (عامل الوسائط)، ولا رسالة الرفض على الهاتف؛ فالنتيجة جزئية"].join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "tusd-hook" }));
  return { code: fails.length ? 1 : 0, doc };
}
