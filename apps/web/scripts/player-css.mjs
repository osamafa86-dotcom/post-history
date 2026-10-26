import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export function localPlayerCss(css) {
  const local = css.replace(/@font-face\s*\{[^}]*\}/g, "");
  if (/@import|url\(\s*["']?\s*(?:https?:)?\/\//i.test(local)) throw new Error("Remote player CSS dependency");
  return local;
}
export async function generatePlayerCss(check = false) {
  const input = new URL("../node_modules/shaka-player/dist/controls.css", import.meta.url);
  const output = new URL("../src/generated/player.css", import.meta.url);
  const css = localPlayerCss(await readFile(input, "utf8"));
  if (check) { if (await readFile(output, "utf8") !== css) throw new Error("Player CSS drift"); }
  else await writeFile(output, css);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await generatePlayerCss(process.argv.includes("--check"));
