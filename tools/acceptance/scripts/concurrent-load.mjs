import { runPending } from "../lib/pending.mjs";

export const run = () => runPending("concurrent-load");
