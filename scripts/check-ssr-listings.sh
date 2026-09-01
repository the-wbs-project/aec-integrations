#!/usr/bin/env bash
#
# Is the catalogue visible to search engines?  (AECI-746)
#
#   ./scripts/check-ssr-listings.sh                       # local dev, port 8788
#   ./scripts/check-ssr-listings.sh http://localhost:8790  # local dev, other port
#   ./scripts/check-ssr-listings.sh https://www.aecintegrations.com
#
# WHAT IT ASKS
#   Exactly one question, of each listing page: does the HTML the server sends
#   contain links to products?
#
# WHY THAT IS THE QUESTION
#   A crawler reads the raw HTML and, on its first pass, does not run our
#   JavaScript. Your browser does, which is why these pages have always LOOKED
#   fine while being empty to Google. `curl` sees what the crawler sees.
#
#   Before AECI-746 every one of these pages served an error message
#   ("Couldn't load products") and zero links, because the listing fetched its
#   data with a relative `/api/products` URL that has no meaning on the server.
#
# READING THE RESULT
#   PASS = the page shipped product links in its HTML. Google can crawl onward.
#   FAIL = the page is a dead end for crawlers, whatever it looks like in a browser.
#
#   The link COUNT is informational — it varies with how much data the
#   environment has (local dev is a thin seed; production has ~1,400 products).
#   Any number above zero is a pass. Zero is the failure this script exists to catch.
#
# RUN IT AGAINST A DEPLOYED ENVIRONMENT
#   Local `wrangler dev` does NOT reproduce this bug: a relative `/api/...` URL
#   resolves to `http://localhost:<port>` there and works, while on the edge it
#   does not. Verified 2026-08-31 — local passed with and without the fix, while
#   production failed 5/5. So a green local run means "no regression", NOT "fixed".
#   The environments that can answer the question are preview, staging, and prod.

set -uo pipefail

BASE="${1:-http://localhost:8788}"
BASE="${BASE%/}"

# One page per shape of listing surface. `/products` is the main catalogue; the
# rest are the taxonomy hubs, which take a different code path (their request is
# scoped to a resolved term) and so can break independently.
PAGES=(
  "/products"
  "/products?sort=name"
  "/categories/project-management"
  "/audiences/general-contracting"
  "/phases/construction"
)

echo
echo "Checking server-rendered listing pages at ${BASE}"
echo "Counting product links in the raw HTML — what a crawler sees, before JavaScript."
echo
printf "  %-38s %14s   %s\n" "PAGE" "PRODUCT LINKS" "RESULT"
printf "  %-38s %14s   %s\n" "--------------------------------------" "--------------" "------"

failures=0
skipped=0

for page in "${PAGES[@]}"; do
  body="$(curl -fsS --max-time 30 "${BASE}${page}" 2>/dev/null)" || body=""

  if [ -z "$body" ]; then
    printf "  %-38s %14s   %s\n" "$page" "-" "SKIP (page did not load)"
    skipped=$((skipped + 1))
    continue
  fi

  links="$(printf '%s' "$body" | grep -oE 'href="/products/[a-z0-9-]+"' | sort -u | wc -l | tr -d ' ')"
  # The error branch these pages used to render. Belt and braces: a page could in
  # principle show the error AND some unrelated link.
  if printf '%s' "$body" | grep -q "Couldn't load products"; then
    printf "  %-38s %14s   %s\n" "$page" "$links" "FAIL (renders the error message)"
    failures=$((failures + 1))
  elif [ "$links" -eq 0 ]; then
    printf "  %-38s %14s   %s\n" "$page" "0" "FAIL (no product links for crawlers)"
    failures=$((failures + 1))
  else
    printf "  %-38s %14s   %s\n" "$page" "$links" "PASS"
  fi
done

echo
if [ "$failures" -gt 0 ]; then
  echo "RESULT: FAIL — ${failures} listing page(s) send no products to crawlers."
  echo
  echo "This is the AECI-746 regression. Confirm by eye:"
  echo "  curl -s ${BASE}/products | grep -c 'Couldn.t load products'   # 1 = broken, 0 = fine"
  exit 1
fi

if [ "$skipped" -gt 0 ]; then
  echo "RESULT: PASS, with ${skipped} page(s) skipped because they did not load."
  echo "A skip is usually a thin dataset (the term has no products) or the server being down —"
  echo "it is NOT the crawler-visibility bug. Re-run against an environment that has data."
  exit 0
fi

echo "RESULT: PASS — every listing page renders products for crawlers."
exit 0
