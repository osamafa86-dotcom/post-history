import test from "node:test";
import assert from "node:assert/strict";
import { scrub, finishAndWrite, envDoc, checkList, EnvironmentError } from "../scripts/web-gap-helpers.mjs";

const base = "https://newsroom.acme-staging.xyz:8443";

test("scrub: the configured base origin and its bare host become <base>", () => {
  assert.equal(scrub(`goto ${base}/ar/login failed`, { base }), "goto <base>/ar/login failed");
  assert.equal(scrub("cannot reach newsroom.acme-staging.xyz:8443 now", { base }), "cannot reach <base> now");
  assert.equal(scrub("HTTPS://NEWSROOM.ACME-STAGING.XYZ:8443/x", { base }), "<base>/x");
});

test("scrub: any other URL keeps its path and loses scheme://host:port", () => {
  assert.equal(scrub("redirected to https://pay.vendor.example:9443/checkout?x=1", { base }), "redirected to <host>/checkout?x=1");
  assert.equal(scrub("http://[::1]:3000/health", { base }), "<host>/health");
});

test("scrub: host:port, bare dotted hostnames and localhost", () => {
  assert.equal(scrub("connect ECONNREFUSED db.internal:5432", { base }), "connect ECONNREFUSED <host>");
  assert.equal(scrub("lookup api.staging.company.io failed", { base }), "lookup <host> failed");
  assert.equal(scrub("api.weird-tld.zzz:81 refused", { base }), "<host> refused");
  assert.equal(scrub("localhost:3000 and localhost", { base }), "<host> and <host>");
  assert.equal(scrub("see example.com/path", { base }), "see <host>/path");
});

test("scrub: IPv4 addresses, with or without a port", () => {
  assert.equal(scrub("connect ECONNREFUSED 10.0.12.7:5432", { base }), "connect ECONNREFUSED <ip>");
  assert.equal(scrub("from 192.168.1.20 to 127.0.0.1", { base }), "from <ip> to <ip>");
});

test("scrub: hex runs of 16 or more characters", () => {
  assert.equal(scrub("sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ok", { base }), "sha256 <hash> ok");
  assert.equal(scrub("id deadbeefcafebabe, upload 0123456789ABCDEF0123", { base }), "id <hash>, upload <hash>");
});

test("scrub: a Playwright error line loses the URL and keeps the rest", () => {
  const message = `page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.y/z\nCall log:\n  - navigating to "${base}/ar/login", waiting until "domcontentloaded"`;
  const out = scrub(message, { base });
  assert.equal(out, 'page.goto: net::ERR_NAME_NOT_RESOLVED at <host>/z\nCall log:\n  - navigating to "<base>/ar/login", waiting until "domcontentloaded"');
});

test("scrub: negatives, relative paths, file names, identifiers and short words are untouched", () => {
  for (const text of [
    "/ar/login", "docs/measurements/acceptance/2026-10-26-web-e2e-browser.json", "tools/acceptance/scripts/web-e2e.mjs",
    "page.goto: Timeout 30000ms exceeded", "error.message is undefined", "locator.click failed", "web-gap-helpers.test.mjs",
    "version 1.2.3 and 10.5", "deadbeef", "0123456789abcdef".slice(0, 15), "12345678901234567890", "فشل المسار: لم يظهر العنصر", "checks 12/14",
  ]) assert.equal(scrub(text, { base }), text, text);
});

test("scrub: idempotent, tolerant of a missing or invalid base, and passes non-strings through", () => {
  const once = scrub(`${base}/a 10.0.0.1 deadbeefcafebabe`, { base });
  assert.equal(scrub(once, { base }), once);
  assert.equal(scrub("https://a.b/c", { base: undefined }), "<host>/c");
  assert.equal(scrub("https://a.b/c", { base: "not a url" }), "<host>/c");
  assert.equal(scrub(undefined, { base }), undefined);
  assert.equal(scrub(42, { base }), 42);
});

test("scrub: the base defaults to ACCEPTANCE_BASE_URL", () => {
  const saved = process.env.ACCEPTANCE_BASE_URL;
  process.env.ACCEPTANCE_BASE_URL = "https://only-in-env.corp.zzz";
  try { assert.equal(scrub("at only-in-env.corp.zzz/x"), "at <base>/x"); }
  finally { if (saved === undefined) delete process.env.ACCEPTANCE_BASE_URL; else process.env.ACCEPTANCE_BASE_URL = saved; }
});

test("finishAndWrite scrubs the notes and string metrics before they reach the result", () => {
  const doc = envDoc({}, "web-a11y");
  const out = finishAndWrite(doc, ["--dry-run"], "browser", "partial", { checks: 1, last_url: "https://a.b.example/x", n: 3 },
    `login: page.goto: net::ERR_CONNECTION_REFUSED at ${base}/ar/login؛ ip 10.1.2.3 sha ${"ab".repeat(16)}`);
  assert.equal(out.error, null);
  assert.equal(doc.notes, "login: page.goto: net::ERR_CONNECTION_REFUSED at <base>/ar/login؛ ip <ip> sha <hash>".replace("<base>", scrub(base, { base: "x" })));
  assert.equal(doc.metrics.last_url, "<host>/x");
  assert.equal(doc.metrics.n, 3);
});

test("EnvironmentError messages carry no host, ip or hash", () => {
  const error = new EnvironmentError("Playwright is unavailable: Cannot find module at https://cdn.vendor.io/a 10.0.0.9 0123456789abcdef0123");
  assert.equal(error.message, "Playwright is unavailable: Cannot find module at <host>/a <ip> <hash>");
  assert.equal(error.name, "EnvironmentError");
  assert.ok(error instanceof EnvironmentError);
});

test("checkList stores and prints scrubbed evidence", () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const { checks, check } = checkList();
    check("open page", false, "net::ERR at https://x.y/z from 10.0.0.1");
    assert.equal(checks[0].detail, "net::ERR at <host>/z from <ip>");
  } finally { console.log = original; }
  assert.equal(lines[0], "FAIL open page — net::ERR at <host>/z from <ip>");
});
