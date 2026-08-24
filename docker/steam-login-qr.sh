#!/bin/bash
# Download the Assetto Corsa dedicated server by scanning a QR code with the
# Steam mobile app. No password typed, no password stored.
#
#   npm run harness:steam-login-qr
#
# Why this isn't steamcmd: steamcmd only knows username + password, and prompts
# for a Steam Guard code it can't ask for when Server Manager runs it in the
# background — that's the "exit status 4". DepotDownloader speaks the newer
# Steam auth protocol, which is what the QR sign-in uses.
#
# It downloads appid 302550 straight into the volume Server Manager reads, so
# afterwards Server Manager finds acServer already installed and never runs
# steamcmd at all.
#
# You still need an account that OWNS Assetto Corsa. QR replaces how you prove
# who you are, not whether you're entitled to the download — an anonymous login
# gets "No subscription".
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

AC_APPID=302550
INSTALL_DIR=/home/assetto/server-manager/assetto
CONFIG_DIR=/home/assetto/depotdownloader

if [[ -f "$here/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$here/.env"
  set +a
fi

# The image is prebuilt rather than built by compose on demand, so it is easy
# to be running one from before DepotDownloader was added. Docker's own error
# for that is "executable file not found in $PATH", which doesn't suggest a
# rebuild. Check first and say so plainly.
if ! docker compose --project-directory "$here" run --rm --no-deps \
      --entrypoint sh acsm -c 'command -v depotdownloader' >/dev/null 2>&1; then
  cat >&2 <<'MSG'
This image doesn't have DepotDownloader in it, so it predates QR sign-in.

Rebuild it:

    npm run harness:build

Then run this again. (If the build itself fails, the Dockerfile checks for
both steamcmd and depotdownloader at the end, so it will say which is
missing rather than leaving it for run time.)
MSG
  exit 1
fi

cat <<'MSG'
Downloading the Assetto Corsa dedicated server via QR sign-in.

A QR code will appear below. Open the Steam mobile app, tap the QR scanner in
the top left, and scan it. The code refreshes every few seconds, which is
normal.

This needs a Steam account that owns Assetto Corsa.

MSG

# --entrypoint bypasses the harness entrypoint, which refuses to start without
# credentials — the thing this command exists to make unnecessary.
#
# -remember-password persists the session under CONFIG_DIR (a named volume),
# so re-running this later to update the server won't need another scan.
exec docker compose --project-directory "$here" run --rm -it \
  --entrypoint depotdownloader \
  --workdir "$CONFIG_DIR" \
  acsm \
  -app "$AC_APPID" \
  -os linux \
  -osarch 64 \
  -dir "$INSTALL_DIR" \
  -qr \
  -remember-password
