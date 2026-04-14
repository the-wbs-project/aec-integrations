#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Configuration ──────────────────────────────────────────────────────────────
# Set these via environment or macOS Keychain:
#   N8N_URL      – base URL of your n8n instance (e.g. https://n8n.example.com)
#   N8N_API_KEY  – API key from n8n Settings > API
#
# Or store in macOS Keychain:
#   security add-generic-password -a "$USER" -s "aec-n8n-url" -w "https://..."
#   security add-generic-password -a "$USER" -s "aec-n8n-api-key" -w "..."

load_config() {
  if [ -z "${N8N_URL:-}" ]; then
    N8N_URL=$(security find-generic-password -a "$USER" -s "aec-n8n-url" -w 2>/dev/null) || {
      echo "Error: N8N_URL not set and not found in Keychain." >&2
      echo "  export N8N_URL=https://your-n8n-instance.com" >&2
      echo "  or: security add-generic-password -a \"\$USER\" -s \"aec-n8n-url\" -w \"https://...\"" >&2
      exit 1
    }
  fi
  # Strip trailing slash
  N8N_URL="${N8N_URL%/}"

  if [ -z "${N8N_API_KEY:-}" ]; then
    N8N_API_KEY=$(security find-generic-password -a "$USER" -s "aec-n8n-api-key" -w 2>/dev/null) || {
      echo "Error: N8N_API_KEY not set and not found in Keychain." >&2
      echo "  export N8N_API_KEY=your-api-key" >&2
      echo "  or: security add-generic-password -a \"\$USER\" -s \"aec-n8n-api-key\" -w \"...\"" >&2
      exit 1
    }
  fi
}

# ── API helpers ────────────────────────────────────────────────────────────────

n8n_api() {
  local method="$1" endpoint="$2"
  shift 2
  curl -sf -X "$method" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    "$N8N_URL/api/v1$endpoint" \
    "$@"
}

# ── Commands ───────────────────────────────────────────────────────────────────

cmd_list() {
  echo "Workflows on $N8N_URL:"
  echo ""
  n8n_api GET /workflows | jq -r '.data[] | select(.name | startswith("AECi-")) | "  \(.id)\t\(.name)"'
}

cmd_pull() {
  local workflow_id="$1"
  local outfile="${2:-}"

  local response
  response=$(n8n_api GET "/workflows/$workflow_id")

  local name
  name=$(echo "$response" | jq -r '.name')

  # Strip n8n metadata fields, keep only what's needed for import
  local cleaned
  cleaned=$(echo "$response" | jq '{
    name,
    nodes,
    connections,
    settings: (.settings // {}),
    staticData: (.staticData // null),
    pinData: (.pinData // {}),
    meta: { n8n_id: .id }
  }')

  if [ -z "$outfile" ]; then
    # Default filename from workflow name
    outfile="$SCRIPT_DIR/${name}.json"
  fi

  echo "$cleaned" | jq '.' > "$outfile"
  echo "Pulled \"$name\" (id: $workflow_id) -> $outfile"
}

cmd_push() {
  local file="$1"

  if [ ! -f "$file" ]; then
    echo "Error: File not found: $file" >&2
    exit 1
  fi

  local name
  name=$(jq -r '.name' "$file")

  # Check if the file has a stored n8n_id from a previous pull
  local stored_id
  stored_id=$(jq -r '.meta.n8n_id // empty' "$file" 2>/dev/null || true)

  # Check if a workflow with this name already exists on the server
  local existing_id
  existing_id=$(n8n_api GET /workflows \
    | jq -r --arg name "$name" '.data[] | select(.name == $name) | .id' \
    | head -1)

  # Decide: update or create
  local target_id="${stored_id:-$existing_id}"

  # Build the payload (strip our meta field)
  local payload
  payload=$(jq 'del(.meta)' "$file")

  if [ -n "$target_id" ]; then
    # Update existing workflow
    n8n_api PUT "/workflows/$target_id" -d "$payload" > /dev/null
    echo "Updated \"$name\" (id: $target_id) on $N8N_URL"
  else
    # Create new workflow
    local response
    response=$(n8n_api POST /workflows -d "$payload")
    local new_id
    new_id=$(echo "$response" | jq -r '.id')
    echo "Created \"$name\" (id: $new_id) on $N8N_URL"

    # Save the n8n_id back into the local file for future syncs
    local updated
    updated=$(jq --arg id "$new_id" '.meta.n8n_id = $id' "$file")
    echo "$updated" | jq '.' > "$file"
    echo "  Saved n8n_id=$new_id into $file"
  fi
}

cmd_pull_all() {
  echo "Pulling all workflows from $N8N_URL..."
  echo ""
  local ids
  ids=$(n8n_api GET /workflows | jq -r '.data[] | select(.name | startswith("AECi-")) | .id')
  for id in $ids; do
    cmd_pull "$id"
  done
}

cmd_push_all() {
  echo "Pushing all local workflows to $N8N_URL..."
  echo ""
  for file in "$SCRIPT_DIR"/*.json; do
    [ -f "$file" ] || continue
    echo "→ $(basename "$file")"
    cmd_push "$file"
    echo ""
  done
}

# ── Usage ──────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 <command> [args]

Commands:
  list                    List all workflows on the n8n instance
  pull <id> [file]        Download a workflow by ID to a local JSON file
  push <file>             Upload a local JSON file to n8n (creates or updates)
  pull-all                Pull all workflows from n8n
  push-all                Push all local JSON files to n8n

Environment:
  N8N_URL       Base URL of your n8n instance
  N8N_API_KEY   API key from n8n Settings > API

  Or store in macOS Keychain (keys: aec-n8n-url, aec-n8n-api-key)

Examples:
  $0 list
  $0 pull 42
  $0 pull 42 ./my-workflow.json
  $0 push ./AECi-W-ErrorLog.json
  $0 pull-all
  $0 push-all
EOF
}

# ── Main ───────────────────────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

COMMAND="$1"
shift

load_config

case "$COMMAND" in
  list)     cmd_list ;;
  pull)
    if [ $# -lt 1 ]; then
      echo "Error: 'pull' requires a workflow ID." >&2
      exit 1
    fi
    cmd_pull "$@"
    ;;
  push)
    if [ $# -lt 1 ]; then
      echo "Error: 'push' requires a file path." >&2
      exit 1
    fi
    cmd_push "$@"
    ;;
  pull-all) cmd_pull_all ;;
  push-all) cmd_push_all ;;
  *)
    echo "Error: Unknown command '$COMMAND'" >&2
    echo ""
    usage
    exit 1
    ;;
esac
