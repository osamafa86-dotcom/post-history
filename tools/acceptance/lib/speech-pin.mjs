// The public Arabic speech clip transcript-draft uses (fixtures/td-speech.json): fetched once from the pinned dataset revision, both the archive and the
// clip verified by sha256. Public data only; never a reporter file.
//   node lib/speech-pin.mjs <cache-dir>   prints the path of the verified clip (downloads the archive into <cache-dir> if it is not there)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, createReadStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PIN = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/td-speech.json"), "utf8"));

export const sha256Of = (path) => new Promise((resolve, reject) => {
  const h = createHash("sha256");
  createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

/** True when the file is exactly the pinned clip. */
export const isPinnedSpeech = async (path) => Boolean(path) && existsSync(path) && (await sha256Of(path)) === PIN.member_sha256;

/** Download (unless cached) and extract the pinned clip into `dir`; returns its path. Throws when a hash differs. */
export async function fetchSpeech(dir, { fetchImpl = fetch } = {}) {
  mkdirSync(dir, { recursive: true });
  const clip = join(dir, PIN.member);
  if (await isPinnedSpeech(clip)) return clip;
  const archive = join(dir, "fleurs-test.tar.gz");
  if (!existsSync(archive) || (await sha256Of(archive)) !== PIN.archive_sha256) {
    const res = await fetchImpl(`https://huggingface.co/datasets/${PIN.dataset}/resolve/${PIN.revision}/${PIN.archive}`);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));
    if ((await sha256Of(archive)) !== PIN.archive_sha256) throw new Error("the downloaded archive does not match the pinned sha256");
  }
  const x = spawnSync("tar", ["-xzf", archive, "-C", dir, PIN.member]);
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  if (!(await isPinnedSpeech(clip))) throw new Error("the extracted clip does not match the pinned sha256");
  return clip;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node lib/speech-pin.mjs <cache-dir>"); process.exit(2); }
  fetchSpeech(dir).then((p) => console.log(p), (e) => { console.error(`ENVIRONMENT: ${e.message}`); process.exit(2); });
}
