#!/usr/bin/env bash
#
# install-aeci-docs.sh
#
# Installs the AECi documentation set into a fresh repo:
# - Moves engineering docs into ./docs/
# - Renames docs-README.md → docs/README.md
# - Places CLAUDE.md at the repo root
# - Creates an empty ./docs/adr/ directory with a placeholder
# - Stages and commits everything
#
# Usage:
#   1. Save this script to your repo root
#   2. Set DOCS_SOURCE below to the folder where you downloaded the .md files
#   3. Make executable: chmod +x install-aeci-docs.sh
#   4. Run from inside your cloned repo: ./install-aeci-docs.sh
#

set -euo pipefail

# ---------- CONFIGURATION ----------
# Path to the folder containing the downloaded .md files.
# Change this to wherever you put them.
DOCS_SOURCE="${DOCS_SOURCE:-$HOME/Downloads/aeci-docs}"

# Whether to auto-commit at the end. Set to "false" if you want to review first.
AUTO_COMMIT="${AUTO_COMMIT:-true}"
# -----------------------------------

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[info]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1" >&2; }

# ---------- PRE-FLIGHT CHECKS ----------

# Must be in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  error "Not inside a git repository. Run this from your cloned repo root."
  exit 1
fi

# Confirm we're at the repo root (not a subdirectory)
REPO_ROOT="$(git rev-parse --show-toplevel)"
if [[ "$PWD" != "$REPO_ROOT" ]]; then
  error "Run this from the repo root: $REPO_ROOT"
  exit 1
fi

# Confirm source folder exists
if [[ ! -d "$DOCS_SOURCE" ]]; then
  error "Source folder does not exist: $DOCS_SOURCE"
  error "Set DOCS_SOURCE to wherever you downloaded the .md files."
  error "Example: DOCS_SOURCE=~/Downloads ./install-aeci-docs.sh"
  exit 1
fi

# Files we expect to find in the source folder
EXPECTED_FILES=(
  "STAGE_1_SPEC.md"
  "DATABASE_SCHEMA.md"
  "API_CONTRACTS.md"
  "AUTH_AND_RLS.md"
  "CICD_PLAN.md"
  "TESTING_STRATEGY.md"
  "STACK_VALIDATION_TEST.md"
  "docs-README.md"
  "CLAUDE.md"
)

# Verify all expected files are present before touching anything
MISSING=()
for f in "${EXPECTED_FILES[@]}"; do
  if [[ ! -f "$DOCS_SOURCE/$f" ]]; then
    MISSING+=("$f")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Missing files in $DOCS_SOURCE:"
  for f in "${MISSING[@]}"; do
    error "  - $f"
  done
  exit 1
fi

# Warn if any target files already exist (avoid silent overwrites)
EXISTING=()
[[ -f "CLAUDE.md" ]] && EXISTING+=("CLAUDE.md")
[[ -d "docs" ]] && EXISTING+=("docs/")

if [[ ${#EXISTING[@]} -gt 0 ]]; then
  warn "These already exist and will be overwritten or merged:"
  for f in "${EXISTING[@]}"; do
    warn "  - $f"
  done
  read -r -p "Continue? [y/N] " response
  if [[ ! "$response" =~ ^[Yy]$ ]]; then
    info "Aborted."
    exit 0
  fi
fi

# ---------- INSTALL ----------

info "Installing AECi docs from $DOCS_SOURCE"

# Create docs directory structure
mkdir -p docs/adr
info "Created docs/ and docs/adr/"

# Copy engineering docs into docs/
for f in STAGE_1_SPEC.md DATABASE_SCHEMA.md API_CONTRACTS.md AUTH_AND_RLS.md \
         CICD_PLAN.md TESTING_STRATEGY.md STACK_VALIDATION_TEST.md; do
  cp "$DOCS_SOURCE/$f" "docs/$f"
  info "  → docs/$f"
done

# Rename docs-README.md → docs/README.md
cp "$DOCS_SOURCE/docs-README.md" "docs/README.md"
info "  → docs/README.md (renamed from docs-README.md)"

# CLAUDE.md goes at the repo root
cp "$DOCS_SOURCE/CLAUDE.md" "./CLAUDE.md"
info "  → CLAUDE.md (at repo root)"

# Create an ADR placeholder so the directory isn't empty in git
cat > docs/adr/README.md << 'EOF'
# Architecture Decision Records

Short, dated records explaining *why* specific decisions were made. Format: Context, Decision, Consequences.

See [adr.github.io](https://adr.github.io/) for the convention.

## Naming

`NNNN-short-decision-title.md` where NNNN is a four-digit sequential number starting at 0001.

## Planned ADRs to write

- `0001-cloudflare-workers-over-vercel.md`
- `0002-no-prisma-accelerate.md`
- `0003-linear-over-huly.md`
- `0004-pro-plan-purge-by-url.md`
- `0005-spartan-over-syncfusion.md`
- `0006-algolia-over-cloudflare-ai-search.md`

Add new ADRs when a decision could surprise someone six months from now.
EOF
info "  → docs/adr/README.md (placeholder)"

# ---------- GIT STAGING ----------

info "Staging files for commit"
git add CLAUDE.md docs/

# Show what we're about to commit
echo
info "Files staged for commit:"
git diff --cached --name-status | sed 's/^/  /'

# Commit if AUTO_COMMIT is true
if [[ "$AUTO_COMMIT" == "true" ]]; then
  echo
  info "Creating commit"
  git commit -m "Add initial documentation set

- Master spec (STAGE_1_SPEC.md) and companion documents
- Database schema with Airtable migration plan
- API contracts with Zod schemas and error codes
- CI/CD pipeline and deployment plan
- Testing strategy
- Stack validation test plan
- AUTH_AND_RLS placeholder
- CLAUDE.md for Claude Code instructions
- docs/adr/ scaffold for architecture decisions"

  echo
  info "Commit created. Review with: git log -1 --stat"
  info "Push when ready with: git push"
else
  echo
  warn "AUTO_COMMIT=false — files staged but not committed."
  warn "Review with: git diff --cached"
  warn "Commit manually when ready."
fi

echo
info "Done."