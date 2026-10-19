// Prints the server-side offset of a tus upload once; run it every few minutes during a field test.
//   node tools/acceptance/field/watch-offset.mjs <upload-url>
const url = process.argv[2];
if (!url) { console.error("usage: watch-offset.mjs <upload-url>"); process.exit(2); }
const res = await fetch(url, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } });
if (res.status !== 200) { console.error(`HEAD ${res.status}`); process.exit(1); }
const off = Number(res.headers.get("upload-offset")), len = Number(res.headers.get("upload-length"));
console.log(`${new Date().toISOString()} offset=${off} length=${len} (${((off / len) * 100).toFixed(1)}%)`);
