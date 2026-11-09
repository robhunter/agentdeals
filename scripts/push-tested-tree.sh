#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo 'usage: push-tested-tree.sh <tested-commit> <tested-tree>' >&2
  exit 2
fi

commit="$(git rev-parse --verify "$1^{commit}")"
tree="$(git rev-parse --verify "$2^{tree}")"
if [ "$(git rev-parse "$commit^{tree}")" != "$tree" ]; then
  echo 'The publication commit differs from the tested tree.' >&2
  exit 1
fi

git push origin "$commit:refs/heads/main"
