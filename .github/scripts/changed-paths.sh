#!/usr/bin/env bash
# Which parts of the repository a pull request touches, for job-level `if:` filters.
#   changed-paths.sh name='<ERE>' [name='<ERE>' ...]   writes name=true|false to $GITHUB_OUTPUT
# A pull_request run is checked out as a merge commit, so HEAD^1..HEAD is exactly the PR's change against its base.
# Anything that is not a merge-commit pull_request (push, dispatch) or a diff that cannot be read answers true: the filter only ever
# removes work that provably does not concern the job, it never hides a check.
set -euo pipefail
all=true files=""
if [ "${GITHUB_EVENT_NAME:-}" = pull_request ] && git rev-parse -q --verify HEAD^2 >/dev/null; then
  if files="$(git diff --name-only HEAD^1 HEAD)"; then all=false; fi
fi
for spec in "$@"; do
  name="${spec%%=*}" re="${spec#*=}"
  if $all || printf '%s\n' "$files" | grep -Eq "$re"; then v=true; else v=false; fi
  echo "$name=$v" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  echo "$name=$v" >&2
done
