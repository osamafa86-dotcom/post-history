// Writes the deterministic synthetic sample used by the field sheets and prints its SHA-256.
//   node tools/acceptance/field/make-sample.mjs <size-mib> <output-file>
import { copyFileSync } from "node:fs";
import { makeSyntheticFile } from "../lib/tus.mjs";

const [sizeMb, out] = process.argv.slice(2);
if (!sizeMb || !out) { console.error("usage: make-sample.mjs <size-mib> <output-file>"); process.exit(2); }
const s = await makeSyntheticFile(Number(sizeMb) * 1024 * 1024);
copyFileSync(s.path, out);
s.cleanup();
console.log(`${out}  ${sizeMb} MiB  sha256=${s.sha256}`);
