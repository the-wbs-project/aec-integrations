#!/usr/bin/env bash
#
# Is the catalogue visible to search engines?  (AECI-746, hardened by AECI-753)
#
#   ./scripts/check-ssr-listings.sh                       # local dev, port 8788
#   ./scripts/check-ssr-listings.sh http://localhost:8790  # local dev, other port
#   ./scripts/check-ssr-listings.sh https://www.aecintegrations.com
#
# Exit codes:
#   0  every listing page answered 200 AND shipped product links. Verified.
#   1  a real finding — a page answered with a non-200, or answered 200 and sent
#      no products. Either way a crawler reaches no catalogue through it.
#   2  could not check — a page returned no HTTP response at all (DNS, timeout,
#      connection refused). Nothing was verified. This is "unknown", not "fine".
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
#   PASS = the page answered 200 and shipped product links. Google can crawl onward.
#   FAIL = a crawler reaches no catalogue through this page. Three ways to earn it:
#     - a non-200 status. A 403 challenge is a dead end to a crawler exactly as a
#       blank page is, so it is a finding, not a skip (AECI-753).
#     - 200 carrying the "Couldn't load products" error branch.
#     - 200 carrying zero product links.
#   COULD NOT CHECK = no HTTP response at all. Not a FAIL — nothing was measured, so
#     the run reports exit 2 rather than exit 1.
#
#   The link COUNT is informational — it varies with how much data the
#   environment has (local dev is a thin seed; production has ~1,400 products).
#   Any number above zero is a pass. Zero is the failure this script exists to catch.
#
# WHY THERE IS NO "SKIP"
#   There used to be one, and it was the bug in AECI-753. `curl -f` collapsed 403,
#   404 and 5xx into the same empty body as a network timeout, the script called
#   that a SKIP, and a run with every page skipped printed "RESULT: PASS" and exited
#   0. A gate that goes green when it could not see the page converts "unknown" into
#   "verified", which is worse than having no gate. Every page now lands in exactly
#   one of PASS, FAIL, or the exit-2 could-not-check bucket.
#
# RUN IT AGAINST A DEPLOYED ENVIRONMENT
#   Local `wrangler dev` does NOT reproduce this bug: a relative `/api/...` URL
#   resolves to `http://localhost:<port>` there and works, while on the edge it
#   does not. Verified 2026-08-31 — local passed with and without the fix, while
#   production failed 5/5. So a green local run means "no regression", NOT "fixed".
#   The environments that can answer the question are preview, staging, and prod.
#
# WHY IT SENDS A BROWSER USER AGENT
#   The WAF scraper rule (docs/waf-rate-limits.md §2) serves a Managed Challenge to
#   tool user agents, `curl` among them. Its path list is `/products*` and `/vendors*`
#   — so it catches the FIRST TWO pages below and none of the three taxonomy hubs.
#
#   That partial overlap is what made the AECI-753 bug so convincing. A UA-less run
#   did not fail outright; it returned three confident PASS rows with real link counts
#   beside two quiet skips, and called the whole thing PASS. Confirmed live against
#   demo on 2026-09-10 — under `curl/8.7.1` exactly `/products` and `/products?sort=name`
#   answer 403 while the three hubs answer 200 with 24 links each.
#
#   Since AECI-753 those two rows read `FAIL (HTTP 403 …)` and the run exits 1, so the
#   gate is at least honest about what it could not see. But it is still measuring the
#   WAF rather than crawler visibility. The UA below is what measures the question.
#
#   This applies to production too. AECI-753's write-up said prod carried no WAF rules,
#   which was true when it was filed and stopped being true when AECI-659 extended the
#   host set on 2026-09-03. Verified 2026-09-10: `curl` with its default UA gets 403 on
#   `https://www.aecintegrations.com/products`. Nothing is incidentally protected now.

set -uo pipefail

BASE="${1:-http://localhost:8788}"
BASE="${BASE%/}"

# Not a disguise — see "WHY IT SENDS A BROWSER USER AGENT" above.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

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

BODY_FILE="$(mktemp -t check-ssr-listings.XXXXXX)"
trap 'rm -f "$BODY_FILE"' EXIT

echo
echo "Checking server-rendered listing pages at ${BASE}"
echo "Counting product links in the raw HTML — what a crawler sees, before JavaScript."
echo
printf "  %-38s %14s   %s\n" "PAGE" "PRODUCT LINKS" "RESULT"
printf "  %-38s %14s   %s\n" "--------------------------------------" "--------------" "------"

dead_ends=0    # answered 200, and a crawler still sees no catalogue
bad_status=0   # answered, but with something other than 200
unreachable=0  # never answered at all

for page in "${PAGES[@]}"; do
  # Truncate first: on a transport failure curl may never open -o, which would
  # leave the PREVIOUS page's body here to be graded a second time.
  : > "$BODY_FILE"

  # No `-f`. `-f` is exactly what threw the status code away and produced the
  # AECI-753 false pass. `-L` because Googlebot follows redirects and this probe
  # claims to see what Googlebot sees; --max-redirs stops a loop.
  #
  # curl itself writes "000" into %{http_code} when it never received an HTTP
  # response, so do NOT write `code=$(...) || code="000"` — that would clobber a
  # real status on the paths where curl exits non-zero while still knowing one
  # (a chain that exceeds --max-redirs reports its last 301).
  code="$(curl -sS -L --max-redirs 3 --max-time 30 -A "$UA" \
    -o "$BODY_FILE" -w '%{http_code}' "${BASE}${page}" 2>/dev/null)"
  [ -n "$code" ] || code="000"

  if [ "$code" = "000" ]; then
    printf "  %-38s %14s   %s\n" "$page" "-" "COULD NOT CHECK (no response — DNS, timeout, or refused)"
    unreachable=$((unreachable + 1))
    continue
  fi

  if [ "$code" != "200" ]; then
    printf "  %-38s %14s   %s\n" "$page" "-" "FAIL (HTTP ${code} — the page never rendered)"
    bad_status=$((bad_status + 1))
    continue
  fi

  links="$(grep -oE 'href="/products/[a-z0-9-]+"' "$BODY_FILE" | sort -u | wc -l | tr -d ' ')"
  # The error branch these pages used to render. Belt and braces: a page could in
  # principle show the error AND some unrelated link.
  if grep -q "Couldn't load products" "$BODY_FILE"; then
    printf "  %-38s %14s   %s\n" "$page" "$links" "FAIL (renders the error message)"
    dead_ends=$((dead_ends + 1))
  elif [ "$links" -eq 0 ]; then
    printf "  %-38s %14s   %s\n" "$page" "0" "FAIL (no product links for crawlers)"
    dead_ends=$((dead_ends + 1))
  else
    printf "  %-38s %14s   %s\n" "$page" "$links" "PASS"
  fi
done

echo

if [ "$bad_status" -gt 0 ]; then
  echo "${bad_status} page(s) did not answer 200. That is a finding, not a skip: a crawler that"
  echo "gets a non-200 on a listing page reaches no catalogue through it, exactly as if the"
  echo "page were blank."
  echo
  echo "A 403 here is usually Cloudflare rather than the app. Work out which layer stopped it"
  echo "before re-tuning anything — docs/waf-rate-limits.md §6.4 is that triage, and §3b covers"
  echo "the zone-level bot settings, which run outside the Ruleset Engine and which a WAF Skip"
  echo "rule cannot exempt."
  echo
fi

if [ "$dead_ends" -gt 0 ]; then
  echo "${dead_ends} page(s) answered 200 and sent no products to crawlers. This is the AECI-746"
  echo "regression. Confirm by eye — a count of 1 means broken, 0 means fine:"
  echo
  echo "  curl -s -L -A '${UA}' ${BASE}/products | grep -c \"Couldn't load products\""
  echo
fi

if [ "$unreachable" -gt 0 ]; then
  echo "${unreachable} page(s) returned no HTTP response at all, so they were never checked."
  echo "Treat that as unknown, not as fine. Is ${BASE} the right host, and is it up?"
  echo
fi

if [ $((bad_status + dead_ends)) -gt 0 ]; then
  echo "RESULT: FAIL — $((bad_status + dead_ends)) of ${#PAGES[@]} listing page(s) are a dead end for crawlers."
  exit 1
fi

if [ "$unreachable" -gt 0 ]; then
  echo "RESULT: COULD NOT CHECK — ${unreachable} of ${#PAGES[@]} page(s) never answered. Nothing was verified."
  exit 2
fi

echo "RESULT: PASS — all ${#PAGES[@]} listing pages answered 200 and render products for crawlers."
exit 0
