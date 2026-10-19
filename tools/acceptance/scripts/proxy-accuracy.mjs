// proxy-accuracy is measured by the media pipeline run on the full stack (scripts/media-e2e.mjs, which also records the
// media-worker part of invalid-file). Without that environment this reports it and measures nothing.
import { run as mediaE2e } from "./media-e2e.mjs";

export const run = (argv, env) => mediaE2e(argv, env);
