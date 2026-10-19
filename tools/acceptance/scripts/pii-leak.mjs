// pii-leak: no GPS, device identifiers or protected source names in any preview, export or unauthorised
// notification, on every external channel. Threat model S2 / SEC-02.
//
// Static mode (always): contract examples, Outbox payloads, response schemas and examples in openapi.yaml,
// plus positive controls proving the detector flags what the contract already rejects.
// Live mode (PII_BASE_URL set): crawls API responses, notifications and events as each role and looks for
// seeded canaries and revealing patterns. Tokens come from the environment, never from files or arguments.
//   PII_BASE_URL=http://127.0.0.1:3000/v1  PII_TOKENS='{"reporter":"…","producer":"…"}'
//   PII_CANARIES='["synthetic-source-name","12.3456789,98.7654321"]'  PII_PRIVILEGED='["rights_officer"]'
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { loadWaivers } from "../lib/waivers.mjs";
import { scan, REVEALING_KEYS, CHANNEL_KEYS } from "../lib/pii.mjs";

const W = loadWaivers("pii-leak");
const waived = W.isWaived;
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const jsonFiles = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)); } catch { return []; } };

export function staticChecks() {
  const findings = [];
  const flag = (source, fs) => fs.forEach((f) => findings.push({ source, ...f }));
  let scanned = 0;

  // 1. every valid contract example: revealing values nowhere; revealing keys only checked where the
  //    schema is a channel payload (form definitions legitimately have field keys such as "location").
  const exRoot = join(ROOT, "contracts/examples");
  for (const schema of readdirSync(exRoot, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of jsonFiles(join(exRoot, schema.name, "valid"))) {
      const doc = readJson(f);
      const keys = schema.name === "outbox-event" ? CHANNEL_KEYS : schema.name === "upload-form" ? false : REVEALING_KEYS;
      flag(f.replace(ROOT + "/", ""), scan(doc, { keys }));
      scanned++;
    }
  }

  // 2. openapi: response-reachable schemas define no revealing property; examples carry none.
  const api = YAML.parse(readFileSync(join(ROOT, "contracts/openapi.yaml"), "utf8"));
  const schemas = api.components?.schemas ?? {};
  const reachable = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.$ref === "string") {
      const m = node.$ref.match(/^#\/components\/schemas\/(.+)$/);
      if (m && !reachable.has(m[1])) { reachable.add(m[1]); visit(schemas[m[1]]); }
      return;
    }
    Object.values(node).forEach(visit);
  };
  const responseExamples = [];
  for (const [p, ops] of Object.entries(api.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      for (const [code, resp] of Object.entries(op?.responses ?? {})) {
        if (!/^[23]/.test(code)) continue; // the 3xx/2xx bodies; 4xx bodies are the shared Error shape
        visit(resp);
        for (const media of Object.values(resp.content ?? {})) {
          if (media.example !== undefined) responseExamples.push([`${method.toUpperCase()} ${p} ${code}`, media.example]);
          for (const [n, ex] of Object.entries(media.examples ?? {})) responseExamples.push([`${method.toUpperCase()} ${p} ${code} ${n}`, ex.value]);
        }
      }
    }
  }
  let reachableProps = 0;
  const resolve = (n) => (n?.$ref ? schemas[n.$ref.replace("#/components/schemas/", "")] : n);
  for (const name of reachable) {
    const walkProps = (node, path) => {
      if (!node || typeof node !== "object" || resolve(node)?.writeOnly) return; // write-only values are never returned
      for (const [k, v] of Object.entries(node.properties ?? {})) {
        if (resolve(v)?.writeOnly || v?.writeOnly) continue;
        reachableProps++;
        if (REVEALING_KEYS.has(k.toLowerCase())) findings.push({ source: `openapi schema ${name}`, path: `${path}.${k}`, kind: "revealing-property-in-response-schema" });
        walkProps(v, `${path}.${k}`);
      }
      for (const key of ["items", "additionalProperties"]) walkProps(node[key], path);
      for (const key of ["allOf", "oneOf", "anyOf"]) (node[key] ?? []).forEach((n) => walkProps(n, path));
    };
    walkProps(schemas[name], name);
    if (schemas[name]?.example !== undefined) flag(`openapi schema ${name} example`, scan(schemas[name].example, { keys: name === "Notification" ? CHANNEL_KEYS : REVEALING_KEYS }));
    for (const [pn, pv] of Object.entries(schemas[name]?.properties ?? {})) if (pv?.example !== undefined) flag(`openapi ${name}.${pn} example`, scan(pv.example, { keys: REVEALING_KEYS }));
  }
  for (const [where, ex] of responseExamples) flag(`openapi response ${where}`, scan(ex, { keys: REVEALING_KEYS }));

  // 3. positive controls: the detector must flag what outbox-event.json already rejects, or it proves nothing.
  const controls = [
    ["contracts/examples/outbox-event/invalid/02-payload-with-gps.json", "gps"],
    ["contracts/examples/outbox-event/invalid/05-payload-with-push-token.json", "push_token"],
  ];
  const missedControls = controls.filter(([f]) => scan(readJson(join(ROOT, f)), { keys: CHANNEL_KEYS }).length === 0).map(([f]) => f);
  const synthetic = scan({ note: "at 31.123456,34.123456 on iPhone15,2" }, { keys: false });
  if (!synthetic.some((x) => x.kind === "coordinate-pair") || !synthetic.some((x) => x.kind === "apple-model-id")) missedControls.push("synthetic value patterns");

  return { findings, scanned, reachableSchemas: reachable.size, reachableProps, responseExamples: responseExamples.length, missedControls };
}

/** Live crawl; `fetchImpl` is injectable for the self-test. */
export async function liveChecks({ baseUrl, tokens, canaries, privileged = [], fetchImpl = fetch }) {
  const findings = [];
  let requests = 0;
  const get = async (role, path) => {
    requests++;
    const res = await fetchImpl(baseUrl.replace(/\/$/, "") + path, { headers: { authorization: `Bearer ${tokens[role]}`, accept: "application/json" } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON bodies are scanned as text */ }
    return { status: res.status, body: body ?? text };
  };
  for (const role of Object.keys(tokens)) {
    const isPrivileged = privileged.includes(role);
    const channels = [["/notifications", CHANNEL_KEYS, true], ["/events", CHANNEL_KEYS, true], ["/materials", REVEALING_KEYS, false], ["/forms/current", false, false], ["/auth/me", REVEALING_KEYS, false]];
    const materialIds = [];
    for (const [path, keys, alwaysScan] of channels) {
      const r = await get(role, path);
      if (r.status >= 500) findings.push({ source: `${role} GET ${path}`, path: "$", kind: `server-error-${r.status}` });
      if (path === "/materials" && Array.isArray(r.body?.items)) materialIds.push(...r.body.items.slice(0, 20).map((m) => m.id).filter(Boolean));
      if (isPrivileged && !alwaysScan) continue; // privileged readers may see unmasked API values, never channel payloads
      scan(r.body, { keys, canaries }).forEach((f) => findings.push({ source: `${role} GET ${path}`, ...f }));
    }
    if (!isPrivileged) {
      for (const id of materialIds) {
        const r = await get(role, `/materials/${id}`);
        scan(r.body, { keys: REVEALING_KEYS, canaries }).forEach((f) => findings.push({ source: `${role} GET /materials/{id}`, ...f }));
      }
    }
  }
  return { findings, requests };
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const test = byName("pii-leak");
  banner(test);
  const doc = newResult("pii-leak", { device: { platform: "server" }, upload_path: "n/a" });

  const s = staticChecks();
  let live = null;
  if (process.env.PII_BASE_URL) {
    const tokens = JSON.parse(process.env.PII_TOKENS ?? "{}");
    if (!Object.keys(tokens).length) throw new Error("PII_BASE_URL is set but PII_TOKENS is empty");
    live = await liveChecks({
      baseUrl: process.env.PII_BASE_URL, tokens,
      canaries: JSON.parse(process.env.PII_CANARIES ?? "[]"),
      privileged: JSON.parse(process.env.PII_PRIVILEGED ?? "[]"),
    });
  }

  const everything = [...s.findings, ...(live?.findings ?? [])];
  const all = everything.filter((f) => !waived(f));
  const waivedHits = everything.length - all.length;
  const unusedWaivers = W.stale(everything);
  unusedWaivers.forEach((w) => console.log(`STALE WAIVER (finding no longer present, remove it): ${w.source} ${w.path}`));
  everything.forEach((f) => console.log(`${waived(f) ? "WAIVED" : "LEAK"} ${f.kind} at ${f.source} ${f.path}`));
  s.missedControls.forEach((c) => console.log(`DETECTOR BLIND to control: ${c}`));
  console.log(`static: ${s.scanned} valid examples, ${s.reachableSchemas} response schemas (${s.reachableProps} properties), ${s.responseExamples} response examples; findings=${s.findings.length}`);
  console.log(live ? `live: ${live.requests} requests; findings=${live.findings.length}` : "live: skipped (no PII_BASE_URL)");

  const failed = all.length > 0 || s.missedControls.length > 0 || unusedWaivers.length > 0;
  finish(doc, failed ? "fail" : live && !waivedHits ? "pass" : "partial", {
    waived_open_findings: waivedHits,
    static_examples_scanned: s.scanned,
    static_response_schemas_scanned: s.reachableSchemas,
    static_response_examples_scanned: s.responseExamples,
    static_findings: s.findings.length,
    detector_controls_missed: s.missedControls.length,
    live_checked: Boolean(live),
    live_requests: live?.requests ?? 0,
    live_findings: live?.findings.length ?? 0,
  }, [live ? null : "الفحص الساكن فقط (العقد والأمثلة)؛ الجزء الحي ضد الخادم لم يُنفَّذ بعد، فالنتيجة جزئية لا تدّعي نجاح المعيار كاملًا",
     waivedHits ? `${waivedHits} موضع مُستثنى بإذن مكتوب في waivers/pii-leak.json ويبقى مفتوحًا حتى حسم العقد` : null].filter(Boolean).join("؛ "));
  if (!args["dry-run"]) console.log("wrote", writeResult(doc, { slug: live ? "live" : "static" }));
  else writeResult(doc, { dryRun: true });
  return { code: failed ? 1 : 0, doc };
}
