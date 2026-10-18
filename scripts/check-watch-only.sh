#!/bin/sh
# ship-progress only watches (SPEC §1, AC12). Fails when the mod's source could
# run a command that changes a PR, a run or a branch.
#
# autotrack.ts reads the text of commands the *session* ran (it matches "merge",
# "ready", "push"); it must never run anything itself, which the second check
# enforces. Everything else may not name a mutating gh/git verb at all, except
# the run-list filter `event: 'push'`.
set -eu
cd "$(dirname "$0")/.."
status=0

verbs="merge|rerun|edit|cancel|approve|close|reopen|ready|push|delete|retarget|lock|comment|review"
if grep -rnE "['\"]($verbs)['\"]" hooks --include='*.ts' --include='*.tsx' \
  | grep -v '^hooks/lib/autotrack.ts:' \
  | grep -vE "event: 'push'|r\.event === 'push'"; then
  echo "check-watch-only: a mutating verb appears in the mod source (above)" >&2
  status=1
fi

if grep -nE "process\.|Runner|\\\$\." hooks/lib/autotrack.ts; then
  echo "check-watch-only: autotrack.ts must only parse text, never run commands" >&2
  status=1
fi

# gh api writes: any method flag or field flag.
if grep -rnE "['\"](-X|--method|-f|-F|--field|--raw-field|--input)['\"]" hooks --include='*.ts' --include='*.tsx' \
  | grep -v '^hooks/lib/autotrack.ts:'; then
  echo "check-watch-only: gh api write flags appear in the mod source (above)" >&2
  status=1
fi

[ "$status" -eq 0 ] && echo "check-watch-only: clean"
exit "$status"
