#!/usr/bin/env bash
#
# Fetches the public Server Manager release and starts it, for CI and for a
# laptop with no premium zip.
#
#   scripts/harness/oss.sh start   # download if needed, boot, wait for ready
#   scripts/harness/oss.sh stop
#
# This is the *only* build champctl's live suite can run unattended. 2.4.x
# needs a per-purchase ACSM.License that cannot go in a public repo, and 1.7.x
# needs neither that nor a Steam account — so the public build is what makes
# the live suite a CI gate rather than something someone remembers to run.
#
# Deliberately not Docker. docker/ builds a premium image from a licensed zip;
# this runs the release binary directly, which is fewer moving parts than a
# container for a process we start, poll and kill.
set -euo pipefail

VERSION=${ACSM_OSS_VERSION:-1.7.9}
# Pinned. This is an artefact fetched from the internet on every CI run, and
# "whatever is at that URL today" is not a thing to run a test suite against —
# a re-uploaded asset would change what CI proves without changing a commit.
SHA256=${ACSM_OSS_SHA256:-e59cff4e577fa0d67b03dfb582d6a259a1fa6c7dbc06a5cb53361e56adf916b2}
URL="https://github.com/JustaPenguin/assetto-server-manager/releases/download/v${VERSION}/server-manager_v${VERSION}.zip"

ROOT=${ACSM_OSS_ROOT:-.harness/oss-${VERSION}}
PORT=${ACSM_OSS_PORT:-8772}
RUN="$ROOT/run"
PIDFILE="$ROOT/server-manager.pid"
URL_BASE="http://127.0.0.1:${PORT}"

say() { printf 'harness(oss): %s\n' "$1" >&2; }

download() {
  mkdir -p "$ROOT"
  local zip="$ROOT/server-manager.zip"
  if [[ ! -f "$zip" ]]; then
    say "downloading Server Manager v${VERSION}"
    curl -fsSL --retry 3 --retry-delay 2 -o "$zip.part" "$URL"
    mv "$zip.part" "$zip"
  fi

  local got
  got=$(sha256sum "$zip" | cut -d' ' -f1)
  if [[ "$got" != "$SHA256" ]]; then
    say "checksum mismatch for $zip"
    say "  expected $SHA256"
    say "  got      $got"
    say "Either the release was re-uploaded or the download is damaged. Delete"
    say "the file to retry; update ACSM_OSS_SHA256 only after checking why."
    exit 1
  fi
}

install() {
  [[ -x "$RUN/server-manager" ]] && return 0
  local tmp="$ROOT/unpacked"
  rm -rf "$tmp"
  mkdir -p "$tmp" "$RUN"
  unzip -q "$ROOT/server-manager.zip" -d "$tmp"
  cp "$tmp/linux/server-manager" "$tmp/linux/config.yml" "$RUN/"
  chmod +x "$RUN/server-manager"
  rm -rf "$tmp"

  # Bind to loopback, and a fixed session key so a restart mid-run doesn't
  # invalidate the cookie the suite is holding. Throwaway value: this container
  # exists for the length of one CI job.
  python3 - "$RUN/config.yml" "$PORT" <<'PY'
import re, sys
path, port = sys.argv[1], sys.argv[2]
s = open(path).read()
s = re.sub(r'hostname:.*', f'hostname: 127.0.0.1:{port}', s, count=1)
s = re.sub(r'session_key:.*', 'session_key: champctl-local-harness-not-a-secret', s, count=1)
s = re.sub(r'^(\s*)path: server_manager\.db', r'\1path: db/server_manager.db', s, count=1, flags=re.M)
open(path, 'w').write(s)
PY
}

prepare_dirs() {
  # `assetto/system` is what 1.7.x checks before running steamcmd — a
  # directory, not an executable. With it present there is no Steam account
  # involved at any point.
  #
  # The content tree is a *separate* requirement and the one that is easy to
  # miss: 1.7.9's event edit form enumerates tracks to build its dropdown and
  # answers 500 without somewhere to enumerate ("couldn't build championship
  # race ... open assetto/content/tracks"). Eleven live tests failed on that,
  # and every one of them read like a champctl bug.
  mkdir -p "$RUN/db" "$RUN/assetto/system" "$RUN/assetto/content/cars"
  # Tracks are synthesised rather than downloaded — no licence question, no
  # Steam, and a pit count a test can assert. See scripts/harness/tracks.ts.
  mkdir -p "$RUN/assetto/content/tracks"
  # The local binary rather than `npx`, which is not on PATH everywhere this
  # runs and would fail long after the interesting part.
  node node_modules/.bin/tsx scripts/harness/tracks.ts "$RUN/assetto/content/tracks" >/dev/null
}

start() {
  download
  install
  prepare_dirs

  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    say "already running (pid $(cat "$PIDFILE"))"
    return 0
  fi

  # Absolute, so the pid file lands where `stop` looks for it regardless of the
  # subshell's directory.
  local pidfile
  pidfile=$(cd "$(dirname "$PIDFILE")" && pwd)/$(basename "$PIDFILE")
  ( cd "$RUN" && exec ./server-manager >server-manager.out 2>&1 ) &
  echo $! >"$pidfile"

  for _ in $(seq 1 300); do
    if [[ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "$URL_BASE/healthcheck.json" 2>/dev/null)" == "200" ]]; then
      say "up at $URL_BASE ($(curl -s "$URL_BASE/healthcheck.json" | head -c 200))"
      return 0
    fi
    sleep 0.2
  done

  say "never answered /healthcheck.json"
  tail -20 "$RUN/server-manager.out" >&2 || true
  exit 1
}

stop() {
  [[ -f "$PIDFILE" ]] || return 0
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) say "usage: $0 [start|stop]"; exit 2 ;;
esac
