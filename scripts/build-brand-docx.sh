#!/usr/bin/env bash
# Regenerate branding/AEC-Integrations-Brand-Guidelines.docx from docs/BRAND_GUIDELINES.md.
# The Markdown is canonical; the DOCX is a portable export for stakeholders.
# Requires: pandoc (brew install pandoc)

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v pandoc >/dev/null 2>&1; then
  echo "error: pandoc is required (brew install pandoc)" >&2
  exit 1
fi

pandoc \
  docs/BRAND_GUIDELINES.md \
  --from markdown \
  --to docx \
  --output branding/AEC-Integrations-Brand-Guidelines.docx \
  --metadata title="AEC Integrations — Brand Guidelines"

echo "wrote branding/AEC-Integrations-Brand-Guidelines.docx"
