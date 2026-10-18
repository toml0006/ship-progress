#!/bin/sh
# Fails when a tracked or staged file holds something that must not be public:
# webhook URLs, AWS account IDs or ARNs, or client names.
set -eu
cd "$(dirname "$0")/.."
files=$(git ls-files -c -o --exclude-standard | grep -v '^scripts/check-public.sh$' || true)
[ -z "$files" ] && exit 0
pattern='hooks\.slack\.com/services|arn:aws|[^0-9][0-9]{12}[^0-9]|amazonaws\.com|\.fifo|cinevative|artsmarketing|arts marketing|\bAMS\b|xox[abp]-|ghp_[A-Za-z0-9]{20}'
if echo "$files" | xargs grep -nIiE "$pattern" -- 2>/dev/null; then
  echo "check-public: the lines above must not be committed to a public repo" >&2
  exit 1
fi
echo "check-public: clean"
