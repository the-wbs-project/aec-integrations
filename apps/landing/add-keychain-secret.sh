#!/usr/bin/env bash
set -euo pipefail

# Add a secret to macOS Keychain for use with sync-secrets.sh
#
# Usage:
#   ./add-keychain-secret.sh <keychain_key> <value>
#
# Examples:
#   ./add-keychain-secret.sh aec-integrations-resend-api-key "re_..."
#   ./add-keychain-secret.sh aec-integrations-resend-api-key-prod "re_..."

if [ $# -lt 2 ]; then
  echo "Usage: $0 <keychain_key> <value>" >&2
  echo "" >&2
  echo "Keychain keys used by this project:" >&2
  echo "  aec-integrations-resend-api-key          (local dev)" >&2
  echo "  aec-integrations-resend-api-key-prod     (production)" >&2
  exit 1
fi

KEY="$1"
VALUE="$2"

# Delete existing entry if present (update = delete + add)
security delete-generic-password -a "$USER" -s "$KEY" 2>/dev/null || true

security add-generic-password -a "$USER" -s "$KEY" -w "$VALUE"

echo "Stored '$KEY' in macOS Keychain for user '$USER'."
