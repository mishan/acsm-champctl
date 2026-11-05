#!/bin/sh
# Checks out a release, builds it, and restarts the services already
# running, so a profile left off (the drain, say) stays off. Deploys the
# newest release unless given one; an older one is how to roll back.
#
# Refuses while the recorder is writing a qualifying or a race: restarting it
# ends that recording, and race night's is the one the stewards need.
# --during-session restarts anyway.
# shellcheck disable=SC2086 # $services is one word per service
set -eu
cd "$(dirname "$0")"

during=no
version=
for arg in "$@"; do
  case "$arg" in
    --during-session) during=yes ;;
    -*) echo "usage: $0 [--during-session] [version]" >&2; exit 2 ;;
    *) version=$arg ;;
  esac
done

# origin's tags, pruned so a release deleted there can't be deployed, in a
# namespace of their own so the pruning leaves tags made here alone.
git -C .. fetch --quiet --prune origin '+refs/tags/*:refs/origin-tags/*'
if [ -z "$version" ]; then
  version=$(git -C .. for-each-ref --sort=-v:refname --format='%(refname:lstrip=2)' \
    'refs/origin-tags/[0-9]*.*.*' | head -1)
fi
# Exactly a tag: not a branch, and not an expression like 2026.11.0~1.
if [ -z "$version" ] || ! git -C .. show-ref --verify --quiet "refs/origin-tags/$version"; then
  echo "No release ${version:-at all} to deploy; scripts/release.sh makes one." >&2
  exit 1
fi

# Not one-off `docker compose run` containers, such as an MCP session's.
services=$(docker ps --filter label=com.docker.compose.project=champctl \
  --filter label=com.docker.compose.oneoff=False \
  --format '{{.Label "com.docker.compose.service"}}' | sort -u)
if [ -z "$services" ]; then
  # `up` with no names would start every profile's services, the drain too.
  echo "Nothing is running here to upgrade; start what you want with docker compose up." >&2
  exit 1
fi

# A recording still being written has a fresh mtime; practice is recorded
# around the clock, so only qualifying and races count.
live=$(docker compose exec -T recorder find /var/lib/champctl/recordings -type f \
  \( -name '*-qualify.*' -o -name '*-race.*' \) -mmin -2 2>/dev/null || true)
if [ -n "$live" ] && [ "$during" = no ]; then
  echo "The recorder is writing a session:" >&2
  echo "$live" >&2
  echo "Try again once it ends, or pass --during-session to cut it short." >&2
  exit 1
fi

# Checkout carries an edit to a tracked file along, and the image would build
# it under the release's name.
if ! git -C .. diff --quiet HEAD; then
  echo "The checkout has local changes; commit or discard them first:" >&2
  git -C .. status --short --untracked-files=no >&2
  exit 1
fi
was=$(git -C .. for-each-ref --points-at HEAD --format='%(refname:lstrip=2)' refs/origin-tags | head -1)
was=${was:-$(git -C .. rev-parse --short HEAD)}
git -C .. checkout --quiet --detach "refs/origin-tags/$version"
export CHAMPCTL_VERSION="$version"
docker compose --profile '*' build -q $services
docker compose --profile '*' up -d $services
echo "Deployed $version (was $was)."
