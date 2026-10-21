// Minimal tus 1.0.0 client with deterministic fault injection: it drops the socket mid-PATCH at planned byte
// positions and resumes from whatever the server reports in HEAD, over a fresh connection pool each time.
import http from "node:http";
import https from "node:https";
import { createHash, createCipheriv } from "node:crypto";
import { createWriteStream, openSync, readSync, closeSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { resolveLookup } from "./ingest.mjs";

const TUS = { "Tus-Resumable": "1.0.0" };

/** Writes a deterministic synthetic file (AES-CTR keystream; no real footage) and returns its path and SHA-256. */
export async function makeSyntheticFile(size, seed = "post-history-acceptance") {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-"));
  const path = join(dir, "synthetic.bin");
  const key = createHash("sha256").update(seed).digest().subarray(0, 16);
  const cipher = createCipheriv("aes-128-ctr", key, Buffer.alloc(16));
  const hash = createHash("sha256");
  const out = createWriteStream(path);
  const block = Buffer.alloc(1 << 20);
  for (let written = 0; written < size; ) {
    const n = Math.min(block.length, size - written);
    const buf = cipher.update(block.subarray(0, n));
    hash.update(buf);
    if (!out.write(buf)) await once(out, "drain");
    written += n;
  }
  out.end();
  await once(out, "finish");
  return { path, sha256: hash.digest("hex"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function request(url, { method, headers = {}, agent, body, abortAfter }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method, headers, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", (e) => (req.__aborted ? resolve({ aborted: true }) : reject(e)));
    if (body && abortAfter != null) {
      // send `abortAfter` bytes, then drop the connection as a lost network would
      req.write(body.subarray(0, abortAfter), () => {
        req.__aborted = true;
        req.socket?.destroy();
        req.destroy();
        resolve({ aborted: true, sentBytes: abortAfter });
      });
    } else req.end(body);
  });
}

const freshAgent = (url) => new (url.startsWith("https") ? https : http).Agent({ keepAlive: false, lookup: resolveLookup() });

/** One tus request without pooling, honouring ACCEPTANCE_RESOLVE; answers { status, headers: { get } } like fetch for the callers that only read those. */
export async function tusFetch(url, { method = "GET", headers = {}, body } = {}) {
  const r = await request(url, { method, headers: { ...headers, ...(body ? { "Content-Length": String(body.length) } : {}) }, agent: freshAgent(url), body });
  return { status: r.status, headers: { get: (k) => r.headers?.[String(k).toLowerCase()] ?? null } };
}

function readRange(path, offset, length) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

/**
 * Uploads `file` with interruptions at the absolute byte positions in `interruptAt`.
 * Returns the facts the acceptance criterion is judged on; never throws on a server-side protocol surprise
 * that is itself a finding (it reports it in `violations`).
 */
export async function resumableUpload({ endpoint, file, size, chunkSize, interruptAt, metadata = {}, headers: headersArg = {} }) {
  const hdr = () => (typeof headersArg === "function" ? headersArg() : headersArg);
  const violations = [];
  const log = { interruptions: 0, networkSwitches: 0, resumeOffsets: [], bytesSent: 0, headCalls: 0, patchCalls: 0, restartsFromZero: 0 };
  const meta = Object.entries({ filename: "synthetic.bin", ...metadata }).map(([k, v]) => `${k} ${Buffer.from(String(v)).toString("base64")}`).join(",");
  let agent = freshAgent(endpoint);

  const created = await request(endpoint, { method: "POST", agent, headers: { ...TUS, ...hdr(), "Upload-Length": String(size), "Upload-Metadata": meta, "Content-Length": "0" } });
  if (created.status !== 201 || !created.headers.location) throw new Error(`tus create failed: HTTP ${created.status}`);
  const location = new URL(created.headers.location, endpoint).toString();

  const pending = [...interruptAt].sort((a, b) => a - b);
  let highWater = 0;
  let justCut = false;
  const t0 = Date.now();
  for (let guard = 0; guard < 10_000; guard++) {
    const head = await request(location, { method: "HEAD", agent, headers: { ...TUS, ...hdr() } });
    log.headCalls++;
    if (head.status !== 200) throw new Error(`tus HEAD failed: HTTP ${head.status}`);
    const offset = Number(head.headers["upload-offset"]);
    if (justCut) log.resumeOffsets.push(offset);
    justCut = false;
    if (offset === 0 && highWater > 0) log.restartsFromZero++;
    if (offset < highWater) violations.push(`server offset went backwards: ${offset} < ${highWater}`);
    highWater = Math.max(highWater, offset);
    if (offset === size) break;

    const len = Math.min(chunkSize, size - offset);
    const body = readRange(file, offset, len);
    const next = pending[0];
    // a planned cut that the resume offset already passed or sits on is taken mid-chunk instead of skipped
    const cutAt = next !== undefined && next < offset + len && len > 1 ? Math.min(Math.max(next - offset, Math.floor(len / 2) * (next <= offset ? 1 : 0), 1), len - 1) : null;
    log.patchCalls++;
    const res = await request(location, {
      method: "PATCH", agent, body, abortAfter: cutAt,
      headers: { ...TUS, ...hdr(), "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset), "Content-Length": String(len) },
    });
    if (res.aborted) {
      log.bytesSent += cutAt;
      log.interruptions++;
      justCut = true;
      pending.shift();
      agent.destroy();
      agent = freshAgent(endpoint); // new pool = new source port; a real IP change is covered by netlab / field tests
      log.networkSwitches++;
      await new Promise((r) => setTimeout(r, 50)); // let the server notice the dropped connection
      continue;
    }
    log.bytesSent += len;
    if (res.status !== 204) violations.push(`PATCH at ${offset} answered HTTP ${res.status}`);
  }
  return { location, durationMs: Date.now() - t0, violations, ...log, agentClose: () => agent.destroy() };
}

/** Downloads the stored object and returns its SHA-256, or null when the server does not serve GET. */
export async function serverSha256(location) {
  const res = await request(location, { method: "GET", agent: freshAgent(location), headers: TUS });
  if (res.status !== 200) return { status: res.status, sha256: null };
  return { status: 200, sha256: createHash("sha256").update(res.body).digest("hex"), bytes: res.body.length };
}
