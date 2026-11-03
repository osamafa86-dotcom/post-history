// ci-step-timings: duration of every step of the CI job that runs it (media e2e, ai e2e), printed and uploaded with the
// job's results: information, not a verdict. The row is mechanizable from CI data alone (the GitHub API's job steps for the
// running attempt), so the measurement lives in ci/step-timings.mjs, which the workflows call; this entry lets run.mjs and
// the catalog reach it by name. Outside CI (no GITHUB_TOKEN, run id, runner name) it measures nothing and exits 2.
export { run } from "../ci/step-timings.mjs";
