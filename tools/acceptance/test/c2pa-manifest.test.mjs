import test from "node:test";
import assert from "node:assert/strict";
import { byteLeaks, judgeManifest, readableParts, shaForms } from "../scripts/c2pa-manifest.mjs";

const SHA = "ab".repeat(32), SOURCE = `post-history:source:${"cd".repeat(32)}`;
const good = () => ({
  active_manifest: "urn:uuid:1", validation_state: "Trusted",
  manifests: { "urn:uuid:1": {
    claim_generator_info: [{ name: "post-history-media", version: "1" }], title: "signed.mov", format: "video/quicktime",
    ingredients: [{ title: "original", relationship: "parentOf", instance_id: SOURCE, label: "source" }],
    assertions: [
      { label: "c2pa.actions.v2", data: { actions: [{ action: "c2pa.opened", parameters: { ingredientIds: ["source"] } }, { action: "c2pa.transcoded", softwareAgent: { name: "post-history-media" } }] } },
      { label: "stds.schema-org.CreativeWork", data: { "@context": "https://schema.org", "@type": "CreativeWork", publisher: { "@type": "Organization", name: "Test Network" } } },
    ],
    signature_info: { alg: "Es256", issuer: "test", common_name: "x", time: "2026-10-22T00:00:00Z" },
  } },
});
const judge = (r, extra = {}) => judgeManifest(r, { source: SOURCE, sha256: SHA, ...extra });
const mutate = (f) => { const r = good(); f(r.manifests["urn:uuid:1"], r); return r; };

test("a manifest inside the closed list is clean", () => assert.deepEqual(judge(good()), []));

test("each kind of leak or extra is reported", () => {
  const cases = {
    "planted tag": mutate((m) => { m.title = "iPhone15,2"; }),
    "gps": mutate((m) => { m.title = "+31.7767+035.2345+000.000/"; }),
    "raw digest hex": mutate((m) => { m.title = SHA; }),
    "raw digest base64": mutate((m) => { m.title = Buffer.from(SHA, "hex").toString("base64"); }),
    "exif assertion": mutate((m) => m.assertions.push({ label: "stds.exif", data: {} })),
    "unknown manifest key": mutate((m) => { m.thumbnail = {}; }),
    "second ingredient": mutate((m) => m.ingredients.push({ title: "b", relationship: "componentOf" })),
    "wrong source": mutate((m) => { m.ingredients[0].instance_id = "post-history:source:other"; }),
    "foreign publisher": mutate((m) => { m.assertions[1].data.publisher.name = "Someone"; }),
    "extra creative-work field": mutate((m) => { m.assertions[1].data.author = [{ name: "n" }]; }),
    "unknown action": mutate((m) => m.assertions[0].data.actions.push({ action: "c2pa.published" })),
    "open validation code": (() => { const r = good(); r.validation_status = [{ code: "assertion.dataHash.mismatch" }]; return r; })(),
    "untrusted": (() => { const r = good(); r.validation_state = "Valid"; return r; })(),
    "second manifest": (() => { const r = good(); r.manifests["urn:uuid:2"] = {}; return r; })(),
    "no opened action": mutate((m) => m.assertions[0].data.actions.shift()),
  };
  for (const [name, r] of Object.entries(cases)) assert.ok(judge(r).length > 0, name);
});

test("byteLeaks finds planted values, digest hex and raw bytes", () => {
  const planted = ["AcceptanceSeiDevice-9f3a"];
  assert.deepEqual(byteLeaks(Buffer.from("xx"), { planted, sha256: SHA }), []);
  assert.equal(byteLeaks(Buffer.concat([Buffer.from("a"), Buffer.from(planted[0], "utf16le")]), { planted, sha256: SHA }).length, 1);
  assert.equal(byteLeaks(Buffer.concat([Buffer.from("a"), Buffer.from(SHA, "hex")]), { planted, sha256: SHA }).length, 1);
  assert.equal(byteLeaks(Buffer.from(`a${SHA}`), { planted, sha256: SHA }).length, 1);
  assert.equal(shaForms(SHA).length, 4);
});

test("position words are judged in field names and readable text, not in base64 or hex blobs (the check failed at random on signatures)", () => {
  // a signature-sized blob that happens to hold GPS, gps and lat in it must not be a finding
  const blob = `${"A".repeat(40)}GPS${"b".repeat(40)}/lat/${"Q".repeat(30)}GpS${"z".repeat(30)}==`;
  const withBlob = mutate((m) => { m.signature_info.sig = blob; m.title = `${"f".repeat(30)}gps${"0".repeat(30)}`; });
  assert.deepEqual(judge(withBlob).filter((p) => /position-like/.test(p)), []);
  // the same words as a field name or as readable text are findings
  assert.ok(judge(mutate((m) => { m.signature_info.GPSLatitude = "x"; })).some((p) => /position-like/.test(p)));
  assert.ok(judge(mutate((m) => { m.title = "GPS position of the shot"; })).some((p) => /position-like/.test(p)));
  assert.ok(judge(mutate((m) => { m.title = "longitude 35"; })).some((p) => /position-like/.test(p)));
  assert.deepEqual(readableParts({ a: ["x y", "A".repeat(40)], k: 1 }), ["a", "x y", "k"]);
});
