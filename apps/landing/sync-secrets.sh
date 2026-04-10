#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/secrets.json"

# Require environment argument
if [ $# -lt 1 ]; then
  echo "Usage: $0 <environment>" >&2
  echo "Available environments: $(jq -r 'keys | join(", ")' "$CONFIG")" >&2
  exit 1
fi

ENV="$1"

# Validate environment exists in config
if ! jq -e ".[\"$ENV\"]" "$CONFIG" &>/dev/null; then
  echo "Error: Unknown environment '$ENV'." >&2
  echo "Available environments: $(jq -r 'keys | join(", ")' "$CONFIG")" >&2
  exit 1
fi

COUNT=$(jq ".[\"$ENV\"].secrets | length" "$CONFIG")

echo "Syncing $COUNT secret(s) for '$ENV' from macOS Keychain..."

for ((i = 0; i < COUNT; i++)); do
  ENV_NAME=$(jq -r ".[\"$ENV\"].secrets[$i].env_name" "$CONFIG")
  KEYCHAIN_KEY=$(jq -r ".[\"$ENV\"].secrets[$i].keychain_key" "$CONFIG")

  echo "  → ${ENV_NAME} (from keychain: ${KEYCHAIN_KEY})"
  VALUE=$(security find-generic-password -a "$USER" -s "$KEYCHAIN_KEY" -w 2>/dev/null) || {
    echo "    Error: Secret '$KEYCHAIN_KEY' not found in macOS Keychain." >&2
    echo "    Run: security add-generic-password -a \"\$USER\" -s \"$KEYCHAIN_KEY\" -w \"<value>\"" >&2
    exit 1
  }

  if [ "$ENV" = "local" ]; then
    # Write to .dev.vars for local Wrangler dev
    DEVVARS="$SCRIPT_DIR/.dev.vars"
    # Remove existing line for this key, then append
    if [ -f "$DEVVARS" ]; then
      grep -v "^${ENV_NAME}=" "$DEVVARS" > "$DEVVARS.tmp" 2>/dev/null || true
      mv "$DEVVARS.tmp" "$DEVVARS"
    fi
    echo "${ENV_NAME}=${VALUE}" >> "$DEVVARS"
    echo "    Written to .dev.vars"
  else
    # Use wrangler secret put for remote environments
    echo "$VALUE" | pnpm wrangler secret put "$ENV_NAME" --env "$ENV"
    echo "    Pushed via wrangler secret put"
  fi
done

echo ""
echo "Done."
