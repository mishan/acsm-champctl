#!/bin/sh
# Pulls, builds, and restarts the services already running, so a profile
# left off (the drain, say) stays off.
#
# Refuses while the recorder is writing a qualifying or a race: restarting it
# ends that recording, and race night's is the one the stewards need.
# --during-session restarts anyway.
# shellcheck disable=SC2086 # $services is one word per service
set -eu
cd "$(dirname "$0")"

case "${1:-}" in
  "") during=no ;;
  --during-session) during=yes ;;
  *) echo "usage: $0 [--during-session]" >&2; exit 2 ;;
esac

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

git -C .. pull --ff-only
docker compose --profile '*' build -q $services
docker compose --profile '*' up -d $services
