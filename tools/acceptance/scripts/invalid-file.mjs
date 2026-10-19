// invalid-file: an invalid upload is rejected clearly, without hanging the system or losing the rest of the batch.
// Server side only: it drives the internal tusd hook (ADR SEC-06) with the requests tusd would send. What a
// corrupt or unsupported media file does after upload belongs to the media worker and is not measured here.
//   HOOK_BASE_URL=http://127.0.0.1:13000  HOOK_TOKEN=<TUSD_HOOK_SECRET>  HOOK_SESSIONS='{"ok":[{id,token,size}×4],"expired":{…},"finished":{…}}'
//   HOOK_OBJECT_PREFIX=tus/  HOOK_BUCKET=uploads
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { percentile } from "../lib/live.mjs";

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
  const fails = [], latencies = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } };

  const hook = async (type, { id, token, size, storage, path = env.HOOK_TOKEN, raw } = {}) => {
    const body = raw ?? {
      Type: type,
      Event: {
        Upload: { ID: type === "post-finish" ? id : "", Size: size ?? 1000, Offset: type === "post-finish" ? size ?? 1000 : 0, MetaData: { upload_session_id: id ?? randomUUID() }, ...(storage ? { Storage: storage } : {}) },
        HTTPRequest: { Method: "POST", URI: "/files/", RemoteAddr: "203.0.113.7", Header: token ? { Authorization: [`Bearer ${token}`] } : {} },
      },
    };
    const t0 = Date.now();
    const res = await fetch(`${env.HOOK_BASE_URL}/internal/tusd-hooks/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    latencies.push(Date.now() - t0);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  };
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

  latencies.sort((a, b) => a - b);
  const p95 = percentile(latencies, 95);
  check("no hook call is slow (p95 under 2000 ms)", p95 < 2000, `p95 ${p95} ms`);

  finish(doc, fails.length ? "fail" : "partial", {
    hook_calls: latencies.length, hook_latency_ms_p50: percentile(latencies, 50), hook_latency_ms_p95: p95, hook_latency_ms_max: latencies.at(-1),
    batch_good_files_accepted: accepted3, batch_good_files_expected: 3, failures: fails.length,
  }, "الجزء الخادمي عبر الخطّاف الداخلي فقط؛ رفض الملف التالف أو غير المدعوم بعد الرفع (عامل الوسائط) ورسالة الرفض على الهاتف لم يُقاسا بعد، فالنتيجة جزئية");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "tusd-hook" }));
  return { code: fails.length ? 1 : 0, doc };
}
