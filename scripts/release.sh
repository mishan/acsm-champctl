#!/bin/sh
# Tags main as the next release and publishes its notes on GitHub.
#
# Versions are year.month.n (2026.11.0, 2026.11.1, then 2026.12.0): nobody
# builds on champctl, so a version only has to say when it shipped. The month
# has no leading zero, which keeps each one a valid semver.
#
# Needs gh, signed in. deploy/upgrade.sh deploys what this tags.
set -eu
cd "$(dirname "$0")/.."

git fetch --quiet --tags origin main
month=$(date +%Y.%-m)
last=$(git tag --list "$month.*" | sed "s/^$month\.//" | grep -E '^[0-9]+$' | sort -n | tail -1)
tag="$month.$((${last:--1} + 1))"

released=$(git tag --points-at origin/main --list '[0-9]*.*.*')
if [ -n "$released" ]; then
  echo "main is already released, as $released." >&2
  exit 1
fi

gh release create "$tag" --target "$(git rev-parse origin/main)" --title "$tag" --generate-notes
git fetch --quiet --tags origin
