#!/bin/bash
# Renders config.yml from the committed template plus environment, checks the
# Steam credentials, then starts Server Manager.
#
# Why a template: ACSM's config.yml is the only place Steam credentials can go,
# and config.yml would be a tracked file. Substituting at boot keeps the
# secrets in docker/.env, which is gitignored, and keeps the tracked file
# honest about what it contains.
#
# Substitution is pure bash on purpose. envsubst would also expand any '$' in a
# password, and sed would need escaping for '&' and its delimiter.
set -euo pipefail

# Bash 5.2 made an unquoted '&' in a pattern-substitution replacement expand to
# the matched text, sed-style. A password containing '&' would silently become
# the literal placeholder. Off, and the replacements are quoted as well.
shopt -u patsub_replacement 2>/dev/null || true

TEMPLATE=${CHAMPCTL_CONFIG_TEMPLATE:-/home/assetto/server-manager/config.template.yml}
OUTPUT=${CHAMPCTL_CONFIG:-/home/assetto/server-manager/config.yml}
ASSETTO_DIR=${CHAMPCTL_ASSETTO_DIR:-/home/assetto/server-manager/assetto}
AC_SERVER="$ASSETTO_DIR/acServer"

say() { printf 'champctl-harness: %s\n' "$1" >&2; }

# YAML single-quoted scalars escape a quote by doubling it, which is the only
# character that needs handling once the value is quoted in the template.
#
# The \' sequences look like they should match a backslash followed by a quote,
# which would be wrong. They don't: inside ${...} the backslash escapes the
# quote for the pattern parser, so this matches a bare ' and replaces it with
# ''. Verified against  quote'inside -> quote''inside  and  'leading -> ''leading.
# There is a check for this at the bottom of the file; run the script with
# CHAMPCTL_SELF_TEST=1 to exercise it.
yaml_single_quote() { printf '%s' "${1//\'/\'\'}"; }

if [[ "${CHAMPCTL_SELF_TEST:-}" == "1" ]]; then
  fail=0
  check() {
    local got; got=$(yaml_single_quote "$1")
    if [[ "$got" != "$2" ]]; then
      printf 'yaml_single_quote %q -> %q, expected %q\n' "$1" "$got" "$2" >&2
      fail=1
    fi
  }
  check "quote'inside" "quote''inside"
  check "'leading"     "''leading"
  check "trailing'"    "trailing''"
  check "none"         "none"
  check 'amp&and$dollar\back' 'amp&and$dollar\back'
  [[ $fail -eq 0 ]] && echo "yaml_single_quote: ok"
  exit $fail
fi

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
if [[ -f "$TEMPLATE" ]]; then
  steam_username=$(yaml_single_quote "${STEAM_USERNAME:-}")
  steam_password=$(yaml_single_quote "${STEAM_PASSWORD:-}")
  steam_force_update=${STEAM_FORCE_UPDATE:-false}

  config=$(<"$TEMPLATE")
  config=${config//__STEAM_USERNAME__/"$steam_username"}
  config=${config//__STEAM_PASSWORD__/"$steam_password"}
  config=${config//__STEAM_FORCE_UPDATE__/"$steam_force_update"}

  # The rendered config holds the Steam password in plain text — that is the
  # only place Server Manager will read it from. Create it empty and lock it
  # down *before* writing, so it is never briefly world-readable, and so a
  # `docker cp` or a stray process in the container doesn't pick it up.
  : >"$OUTPUT"
  chmod 600 "$OUTPUT"
  printf '%s\n' "$config" >"$OUTPUT"
elif [[ -f "$OUTPUT" ]]; then
  say "no template at $TEMPLATE; using the config.yml already in place"
else
  say "no config template and no config.yml — Server Manager will not start"
  exit 1
fi

# ---------------------------------------------------------------------------
# Steam credentials
#
# Server Manager runs steamcmd whenever install_path has no executable in it.
# Blank credentials don't prevent that, they just make it fail with an opaque
# "exit status 4" — so there is no content-free mode to fall back on, and the
# harness refuses to start rather than reproducing that error for you.
#
# Anonymous doesn't help: appid 302550 answers "No subscription" to an
# anonymous login. The account has to own Assetto Corsa.
# ---------------------------------------------------------------------------
explain_steamcmd_exit() {
  case "$1" in
    0) printf 'success' ;;
    4) printf 'login failed — usually blank credentials, or a Steam Guard prompt it could not answer' ;;
    5) printf 'invalid password, or no such account' ;;
    8) printf "install failed — commonly 'No subscription', meaning this account does not own Assetto Corsa" ;;
    *) printf 'exit status %s' "$1" ;;
  esac
}

if [[ -x "$AC_SERVER" ]]; then
  say "Assetto Corsa server already installed; skipping the download"
else
  if [[ -z "${STEAM_USERNAME:-}" || -z "${STEAM_PASSWORD:-}" ]]; then
    say "There is no Assetto Corsa server in $ASSETTO_DIR, and no Steam"
    say "credentials to install one with. Two ways forward:"
    say ""
    say "  1. QR sign-in, no password anywhere (recommended):"
    say ""
    say "         npm run harness:steam-login-qr"
    say ""
    say "     Scan the code with the Steam mobile app. It downloads the server"
    say "     into this same volume, and then this container starts clean."
    say ""
    say "  2. Set STEAM_USERNAME and STEAM_PASSWORD in docker/.env and restart."
    say ""
    say "Either way the account must OWN Assetto Corsa. The dedicated server is"
    say "a free download, but not an anonymous one — appid 302550 answers"
    say "'No subscription' to an anonymous login."
    exit 1
  fi

  # Server Manager is about to do this login anyway; doing it here first turns
  # a numeric failure buried in the UI into a sentence in the logs.
  say "checking Steam credentials for '${STEAM_USERNAME}'..."

  # Same reasoning as config.yml above: steamcmd writes the account name and
  # its own auth diagnostics here, so create the log locked down rather than at
  # whatever the umask happens to be.
  preflight_log=/tmp/steam-preflight.log
  : >"$preflight_log"
  chmod 600 "$preflight_log"

  set +e
  steamcmd +login "$STEAM_USERNAME" "$STEAM_PASSWORD" +quit </dev/null >"$preflight_log" 2>&1
  preflight=$?
  set -e

  if [[ $preflight -ne 0 ]]; then
    say "steamcmd login failed: $(explain_steamcmd_exit "$preflight")"
    say ""
    if [[ $preflight -eq 4 ]]; then
      say "If this account has Steam Guard on, steamcmd cannot prompt for a code"
      say "from inside the container. Do an interactive login once:"
      say ""
      say "    npm run harness:steam-login"
      say ""
      say "That caches the credentials in the acsm-steam volume, and later"
      say "non-interactive logins work. Note 'npm run harness:reset' wipes it."
    fi
    tail -5 "$preflight_log" >&2 || true
    exit 1
  fi

  say "Steam credentials accepted. Server Manager will install the AC server now;"
  say "this takes a few minutes. Watch it with: npm run harness:logs"
fi

exec "$@"
