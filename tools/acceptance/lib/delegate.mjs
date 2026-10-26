import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { byName } from "./catalog.mjs";
import { banner } from "./measurement.mjs";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A plan row measured by live scripts that carry their own names (and their own result files): the row's script starts
 * those through `live/run.mjs --only=…`, which needs a migrated `DATABASE_URL` and starts its own API. It writes no result under the
 * row's name, so the gap report keeps saying "no measurement" for the row until a result with that name exists.
 */
export function runDelegated(name, scripts, { env = process.env, spawn = spawnSync } = {}) {
  banner(byName(name));
  if (!env.DATABASE_URL) {
    console.error(`ENVIRONMENT: DATABASE_URL is required; this row is measured by ${scripts.join(", ")} through live/run.mjs; nothing measured`);
    return { code: 2, doc: null };
  }
  const run = spawn(process.execPath, [join(ROOT_DIR, "live/run.mjs"), `--only=${scripts.join(",")}`], { env, stdio: "inherit" });
  return { code: run.status ?? 2, doc: null };
}
