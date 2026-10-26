import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
if (process.env.WEB_PLAYER_BENCH !== "1") throw new Error("Set WEB_PLAYER_BENCH=1");
const dir = resolve(".artifacts/player-deps");
await mkdir(dir, { recursive: true });
await writeFile(resolve(dir, "package.json"), JSON.stringify({
  private: true, type: "module",
  dependencies: { "@videojs/react": "10.2.0", "@videojs/hlsjs-video": "10.2.0", "shaka-player": "5.3.2",
    react: "19.3.1", "react-dom": "19.3.1", esbuild: "0.28.2", "@playwright/test": "1.56.1" },
}, null, 2));
const result = spawnSync("npm", ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
