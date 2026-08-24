#!/bin/bash
# Interactive steamcmd login, so Steam Guard doesn't have to be turned off.
#
#   npm run harness:steam-login
#
# steamcmd can't prompt for a Steam Guard code when Server Manager runs it in
# the background — that surfaces as "exit status 4". Logging in once with a
# terminal attached caches the credentials under /home/assetto/steamcmd, which
# is a named volume, so later non-interactive logins succeed.
#
# The cache lives in the acsm-steam volume. `npm run harness:reset` removes it
# and you will need to run this again; `harness:down` + `harness:up` keeps it.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ -f "$here/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$here/.env"
  set +a
fi

if [[ -z "${STEAM_USERNAME:-}" ]]; then
  cat >&2 <<'MSG'
STEAM_USERNAME is not set.

Put it in docker/.env (copy docker/.env.example if you haven't yet), then run
this again. The password can stay out of .env if you'd rather type it here —
steamcmd will prompt for it.
MSG
  exit 1
fi

echo "Logging in to Steam as '${STEAM_USERNAME}'."
echo "Enter the password and any Steam Guard code when prompted."
echo

# --entrypoint bypasses the harness entrypoint, which would refuse to start
# without working credentials — which is the thing we're here to establish.
# The AC server appid is 302550; requesting it here means this one command both
# proves the login and does the download, so Server Manager finds it in place.
exec docker compose --project-directory "$here" run --rm -it \
  --entrypoint steamcmd \
  acsm \
  +force_install_dir /home/assetto/server-manager/assetto \
  +login "$STEAM_USERNAME" \
  +app_update 302550 \
  +quit
