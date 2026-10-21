// download-url (core gate): the signed read link exists for verified derivatives only, lives at most 10 minutes, reveals nothing, and the original is a 404.
//   DL_API_URL  DL_TUS_URL  DL_TOKENS {reporter, reporter_b}  DL_TIMEOUT_S (240)  DL_WAIT_EXPIRY=1 (wait for the link to expire and check it stops working)
// A synthetic phone clip is uploaded (original only); the worker's proxy appears in the material's files. Then:
//   proxy file      -> 200 {url, expires_at}, Cache-Control: no-store, expires_at within 10 minutes (and X-Amz-Expires when the link is an S3 signature)
//   the link        -> its path holds ids only (no original filename, no planted revealing value, no query beyond the signature); the bytes it serves hash to the proxy's sha256
//                      (when the link is reachable from here; otherwise said, not failed)
//   original file   -> 404, the same body as a file that does not exist, another material's file, and another reporter's request (no telling them apart); no token -> 401
// `pass` needs the link to have been fetched and, with DL_WAIT_EXPIRY=1, refused after it expired; otherwise partial.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, materialBody, sleep } from "../lib/live.mjs";
import { waitFor } from "../lib/hooks.mjs";
import { resumableUpload } from "../lib/tus.mjs";
import { tusAuth } from "../lib/ingest.mjs";
import { LEAK_VALUES, sha256File, synthClip } from "../lib/media-clips.mjs";
import { checker, gateOff } from "../lib/core-gate.mjs";
import { freshFetch } from "../lib/http.mjs";
import { readFileSync } from "node:fs";

const ID_SEGMENT = /^(derived|uploads|[0-9a-f-]{36}|[A-Za-z0-9_-]{1,40}\.(mp4|jpg|json|m3u8|m4s))$/;

/** What a link may and may not carry; returns the problems. */
export function inspectLink(link, { filenameStems = [] } = {}) {
  const u = new URL(link), problems = [];
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.slice(1).some((s) => !ID_SEGMENT.test(s))) problems.push(`path segments are not ids: ${u.pathname}`);
  for (const stem of [...filenameStems, ...LEAK_VALUES]) if (stem && link.toLowerCase().includes(String(stem).toLowerCase())) problems.push("a name or planted value is in the link");
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => !/^(x-amz-|signature|expires|key-pair-id|token|policy|sig|se|sp|sv|sr|sip|spr|st)/i.test(k))) problems.push(`unexpected query parameters: ${keys.join(",")}`);
  return problems;
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("download-url"));
  const off = gateOff("download-url", env);
  if (off) return off;
  if (!env.DL_API_URL || !env.DL_TUS_URL) { console.error("ENVIRONMENT: DL_API_URL and DL_TUS_URL are required; nothing measured"); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.DL_TOKENS ?? "{}");
  const http = client(env.DL_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("download-url", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const timeoutMs = Number(env.DL_TIMEOUT_S ?? 240) * 1000;
  const work = mkdtempSync(join(tmpdir(), "download-url-"));
  let fetched = false, expiryChecked = false;
  try {
    const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
    const stem = `dl-${randomUUID().slice(0, 8)}`;
    const upload = async (label) => {
      const mat = (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `download-url-${label}`) })).body;
      const path = synthClip(join(work, `${stem}-${label}.mov`), { seconds: 12, vfr: true, startOffset: 3 });
      const size = readFileSync(path).length, sha = await sha256File(path);
      const session = await createUploadSession(http, tokens.reporter, { materialId: mat.id, size, clientSha256: sha, filename: `${stem}-${label}.mov` });
      const up = await resumableUpload({ endpoint: env.DL_TUS_URL, file: path, size, chunkSize: 8 * 1024 * 1024, interruptAt: [], metadata: { upload_session_id: session.id }, headers: () => tusAuth(session) });
      if (up.violations.length) throw new Error(`tus violations: ${up.violations.join("; ")}`);
      await waitFor(async () => (await http.get(tokens.reporter, `/uploads/${session.id}`)).body?.state === "verified", { timeoutMs, everyMs: 500 });
      const files = async () => (await http.get(tokens.reporter, `/materials/${mat.id}`)).body?.files ?? [];
      const proxy = (await waitFor(async () => (await files()).find((f) => f.kind === "proxy" && f.state === "verified") ?? null, { timeoutMs, everyMs: 500 })).value;
      return { mat, original: (await files()).find((f) => f.kind === "original"), proxy };
    };
    const a = await upload("a"), b = await upload("b");
    check("setup: a verified proxy and an original exist", Boolean(a.proxy && a.original && b.proxy));
    const url = (m, f, t = tokens.reporter) => http.call(t, "GET", `/materials/${m}/files/${f}/download-url`);
    const g = await url(a.mat.id, a.proxy.id);
    check("verified proxy: 200 with a url and expires_at", g.status === 200 && typeof g.body?.url === "string" && Boolean(g.body?.expires_at), String(g.status));
    check("Cache-Control: no-store", /no-store/.test(g.headers?.["cache-control"] ?? ""), String(g.headers?.["cache-control"]));
    const left = (Date.parse(g.body?.expires_at) - Date.now()) / 1000;
    check("the link expires within 10 minutes (and is not already expired)", left > 0 && left <= 600 + 30, `${Math.round(left)} s`);
    let link = null;
    try { link = new URL(g.body.url); } catch { /* checked below */ }
    check("the url parses", Boolean(link));
    if (link) {
      const amz = link.searchParams.get("X-Amz-Expires");
      if (amz) check("X-Amz-Expires is 600 s at most", Number(amz) <= 600, amz);
      const problems = inspectLink(g.body.url, { filenameStems: [stem] });
      check("the link carries ids only: no filename, no planted value, only signature parameters", problems.length === 0, problems.join("; "));
      try {
        const res = await (deps.fetchImpl ?? freshFetch)(g.body.url);
        if (res.status === 200) {
          fetched = true;
          check("the link serves the proxy's bytes (sha256 equals the file's)", createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex") === a.proxy.sha256);
        } else check("the link is readable", false, String(res.status));
      } catch (e) { console.log(`note the link is not reachable from here (${e.cause?.code ?? e.message}); its bytes were not compared`); }
    }
    const miss = await url(a.mat.id, randomUUID());
    const shape = (r) => JSON.stringify({ s: r.status, c: r.body?.code });
    check("the original is a 404", (await url(a.mat.id, a.original.id)).status === 404);
    check("a file that does not exist is a 404", miss.status === 404);
    check("another material's file is a 404, same answer as a missing one", shape(await url(a.mat.id, b.proxy.id)) === shape(miss));
    check("the original answers exactly like a missing file", shape(await url(a.mat.id, a.original.id)) === shape(miss));
    if (tokens.reporter_b) check("another reporter's request is a 404, same answer", shape(await url(a.mat.id, a.proxy.id, tokens.reporter_b)) === shape(miss));
    check("no token is a 401", (await http.call(null, "GET", `/materials/${a.mat.id}/files/${a.proxy.id}/download-url`)).status === 401);
    if (env.DL_WAIT_EXPIRY === "1" && link && fetched) {
      await sleep(Math.max(0, left + 3) * 1000);
      const late = await (deps.fetchImpl ?? freshFetch)(g.body.url).catch(() => ({ status: 0 }));
      expiryChecked = true;
      check("after expiry the link stops working", late.status >= 400 || late.status === 0, String(late.status));
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  const full = fetched && expiryChecked;
  finish(doc, fails.length ? "fail" : full ? "pass" : "partial", { link_fetched: fetched, expiry_waited: expiryChecked, checks_failed: fails.length },
    full ? "الرابط جُلب وانتهى فعلًا" : `${fetched ? "" : "الرابط لم يُجلب من هنا؛ "}${expiryChecked ? "" : "الانتهاء الفعلي لم يُنتظر (DL_WAIT_EXPIRY=1)؛ "}فلا pass`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
