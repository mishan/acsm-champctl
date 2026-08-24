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

if [[ -x /home/assetto/server-manager/assetto/acServer ]]; then
  say "Assetto Corsa server already installed; skipping any download"
elif [[ -n "${STEAM_USERNAME:-}" ]]; then
  say "steam credentials present — Server Manager will install the AC server on first boot."
  say "This takes a few minutes and needs an account that owns Assetto Corsa."
  say "Watch progress with: npm run harness:logs"
else
  say "no steam credentials and no AC server installed."
  say "Import, export and form recon all work without content."
  say "Track pit counts do not: /content/tracks/.../ui_track.json has nothing to serve."
fi

exec "$@"
