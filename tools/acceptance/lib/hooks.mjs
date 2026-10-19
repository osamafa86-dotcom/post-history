// Plays tusd for the live runs: the internal hook requests tusd would send, and the S3 object it would have written.
import { randomUUID } from "node:crypto";
import { sleep } from "./live.mjs";

export function hookClient({ baseUrl, token }) {
  const latencies = [];
  const call = async (type, { id, bearer, size, storage, path = token, raw } = {}) => {
    const body = raw ?? {
      Type: type,
      Event: {
        Upload: { ID: type === "post-finish" ? id : "", Size: size ?? 1000, Offset: type === "post-finish" ? size ?? 1000 : 0, MetaData: { upload_session_id: id ?? randomUUID() }, ...(storage ? { Storage: storage } : {}) },
        HTTPRequest: { Method: "POST", URI: "/files/", RemoteAddr: "203.0.113.7", Header: bearer ? { Authorization: [`Bearer ${bearer}`] } : {} },
      },
    };
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/internal/tusd-hooks/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    latencies.push(Date.now() - t0);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  };
  return { call, latencies };
}

/**
 * A whole tusd upload as the server sees it: pre-create (token checked), the object written to storage,
 * post-finish (storage key checked). `bytes` null = tusd reported finished but wrote nothing (storage_error).
 */
export async function simulateUpload({ hooks, s3, bucket, prefix, session, bytes, key }) {
  const pre = await hooks.call("pre-create", { id: session.id, bearer: session.token, size: session.size });
  if (pre.body?.RejectUpload !== false) throw new Error(`pre-create rejected unexpectedly: ${pre.text}`);
  const objectKey = key ?? `${prefix}${session.id}`;
  if (bytes) await s3.put(bucket, objectKey, bytes);
  const t0 = Date.now();
  const post = await hooks.call("post-finish", { id: session.id, size: session.size, storage: { Type: "s3store", Bucket: bucket, Key: objectKey } });
  if (post.status !== 200) throw new Error(`post-finish answered ${post.status}`);
  return { finishedAt: t0, returnedAt: Date.now() };
}

/** Polls `probe()` until it returns something truthy or the budget runs out. */
export async function waitFor(probe, { timeoutMs = 20_000, everyMs = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return { value: v, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { value: null, waitedMs: Date.now() - t0 };
    await sleep(everyMs);
  }
}
