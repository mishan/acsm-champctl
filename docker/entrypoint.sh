#!/bin/bash
# Renders config.yml from the committed template plus environment, then starts
# Server Manager.
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

say() { printf 'champctl-harness: %s\n' "$1" >&2; }

# YAML single-quoted scalars escape a quote by doubling it, which is the only
# character that needs handling once the value is quoted in the template.
yaml_single_quote() { printf '%s' "${1//\'/\'\'}"; }

if [[ -f "$TEMPLATE" ]]; then
  steam_username=$(yaml_single_quote "${STEAM_USERNAME:-}")
  steam_password=$(yaml_single_quote "${STEAM_PASSWORD:-}")
  steam_force_update=${STEAM_FORCE_UPDATE:-false}

  config=$(<"$TEMPLATE")
  config=${config//__STEAM_USERNAME__/"$steam_username"}
  config=${config//__STEAM_PASSWORD__/"$steam_password"}
  config=${config//__STEAM_FORCE_UPDATE__/"$steam_force_update"}
  printf '%s\n' "$config" >"$OUTPUT"
elif [[ -f "$OUTPUT" ]]; then
  say "no template at $TEMPLATE; using the config.yml already in place"
else
  say "no config template and no config.yml — Server Manager will not start"
  exit 1
fi

# ---------------------------------------------------------------------------
# Assetto Corsa server
#
# Server Manager tries to install via steamcmd whenever install_path has no
# executable in it — blank credentials don't stop it, they just make the
# install fail. So the content-free path needs something at assetto/acServer,
# not a working steamcmd.
#
# The placeholder is marked with a sentinel so we can tell ours from a real
# install and replace it the moment credentials appear.
# ---------------------------------------------------------------------------
ASSETTO_DIR=/home/assetto/server-manager/assetto
AC_SERVER="$ASSETTO_DIR/acServer"
PLACEHOLDER_MARKER="$ASSETTO_DIR/.champctl-placeholder"

install_placeholder_server() {
  mkdir -p "$ASSETTO_DIR"/{cfg,content/cars,content/tracks,results,logs}
  cat >"$AC_SERVER" <<'STUB'
#!/bin/sh
# Placeholder installed by the champctl test harness.
#
# There is no Assetto Corsa server here. The harness runs content-free by
# default so it boots in seconds — that is enough for championship import,
# export, form recon and the round-trip diff, none of which start a session.
#
# To get a real server, set STEAM_USERNAME and STEAM_PASSWORD in docker/.env
# and restart. See docker/README.md.
echo "champctl harness: no Assetto Corsa server installed; cannot start a session." >&2
exit 1
STUB
  chmod +x "$AC_SERVER"
  date -u +%FT%TZ >"$PLACEHOLDER_MARKER"
}

if [[ -n "${STEAM_USERNAME:-}" ]]; then
  if [[ -f "$PLACEHOLDER_MARKER" ]]; then
    say "steam credentials appeared — removing the placeholder so a real install can run"
    rm -f "$AC_SERVER" "$PLACEHOLDER_MARKER"
  fi
  if [[ -x "$AC_SERVER" ]]; then
    say "Assetto Corsa server already installed; skipping the download"
  else
    say "steam credentials present — Server Manager will install the AC server on first boot."
    say "This takes a few minutes and needs an account that owns Assetto Corsa."
    say "Watch progress with: npm run harness:logs"
    # Surface a broken steamcmd here rather than as an opaque exit 127 from
    # inside Server Manager.
    if ! steamcmd +quit >/dev/null 2>&1; then
      say "WARNING: 'steamcmd +quit' failed. Server Manager's install will fail too."
      say "Check it inside the container with: docker compose exec acsm steamcmd +quit"
    fi
  fi
elif [[ -x "$AC_SERVER" && ! -f "$PLACEHOLDER_MARKER" ]]; then
  say "Assetto Corsa server already installed; leaving it alone"
else
  install_placeholder_server
  say "no steam credentials — installed a placeholder acServer so Server Manager"
  say "doesn't try to download one. Import, export and form recon all work."
  say "Track pit counts do not: /content/tracks/.../ui_track.json has nothing to serve,"
  say "and starting a session will fail. Set STEAM_USERNAME in docker/.env for a real one."
fi

exec "$@"
