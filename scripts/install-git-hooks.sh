#!/usr/bin/env bash
# Point this clone's pre-push hook at scripts/git-hooks/pre-push.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$root/.git/hooks"
ln -sfn ../../scripts/git-hooks/pre-push "$root/.git/hooks/pre-push"
echo "Installed pre-push hook in $root"
