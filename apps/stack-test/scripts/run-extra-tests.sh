#!/usr/bin/env bash
#
# Phase 1 stack-test — supplementary test runner.
#
# Covers gaps not in the original Section 5 (theme-cookie × cache, Vary header,
# 404/KV-miss path, XSS escaping of KV content, concurrent PUT storm,
# ETag / If-None-Match, bundle size snapshot).
#
# Usage:
#   HOST=http://localhost:8789 ./scripts/run-extra-tests.sh           # local wrangler dev
#   HOST=https://stack-test.aecintegrations.com ./scripts/run-extra-tests.sh
#
# Exits non-zero if any test fails. Cache-related tests are marked SKIP when
# running against localhost because Miniflare's `caches.default` does not
# behave like the real Cloudflare edge cache.

set -u

HOST="${HOST:-http://localhost:8789}"
IS_LOCAL=0
case "$HOST" in
	http://localhost:*|http://127.0.0.1:*) IS_LOCAL=1 ;;
esac

PASS=0
FAIL=0
SKIP=0
FAILED_NAMES=()

c_pass() { printf '\033[32mPASS\033[0m'; }
c_fail() { printf '\033[31mFAIL\033[0m'; }
c_skip() { printf '\033[33mSKIP\033[0m'; }

pass() {
	PASS=$((PASS + 1))
	printf '  [%s] %s\n' "$(c_pass)" "$1"
}
fail() {
	FAIL=$((FAIL + 1))
	FAILED_NAMES+=("$1")
	printf '  [%s] %s\n' "$(c_fail)" "$1"
	if [ -n "${2:-}" ]; then
		printf '         %s\n' "$2"
	fi
}
skip() {
	SKIP=$((SKIP + 1))
	printf '  [%s] %s\n' "$(c_skip)" "$1"
	if [ -n "${2:-}" ]; then
		printf '         %s\n' "$2"
	fi
}

section() {
	printf '\n\033[1m== %s ==\033[0m\n' "$1"
}

# Make sure the host is reachable before doing anything else.
section "preflight"
if ! curl -fsS -o /dev/null --max-time 10 "$HOST/"; then
	printf '  Host %s not reachable. Start `pnpm run dev` first, or set HOST.\n' "$HOST" >&2
	exit 2
fi
pass "host reachable: $HOST"

# Reset seed entities to a known state — the Worker auto-seeds on first request,
# but later tests overwrite them, so re-seed explicitly.
reset_seed() {
	curl -fsS -X PUT -H 'content-type: application/json' \
		-d '{"title":"Hello from entity:abc","body":"This is the seeded body for entity abc. Edit me at /admin/abc and the cache will purge."}' \
		"$HOST/api/data/abc" > /dev/null || true
	curl -fsS -X PUT -H 'content-type: application/json' \
		-d '{"title":"Hello from entity:xyz","body":"Independent entity. Editing abc should NOT invalidate /cached/xyz."}' \
		"$HOST/api/data/xyz" > /dev/null || true
}

# Purge a single URL from the local edge cache via the Worker's /api/purge
# endpoint. This is what we use between cookie-variant fetches so we can
# observe fresh SSR output, not a cached one.
purge_url() {
	curl -fsS -X POST -H 'content-type: application/json' \
		-d "{\"url\":\"$1\"}" "$HOST/api/purge" > /dev/null 2>&1 || true
	# /api/purge schedules edgeCache().delete() via ctx.waitUntil — give it a beat.
	sleep 0.4
}

# Returns "MISS" or "HIT" (from the X-Stack-Test-Cache header the Worker sets),
# or empty string if absent.
# Note: must use GET-with-dumped-headers (`-D -`) rather than HEAD (`-I`).
# The Worker's isCachedPage gate requires `request.method === 'GET'`; HEAD
# falls through to Angular SSR with `Cache-Control: private, no-store`.
cache_status() {
	curl -fsS -D - -o /dev/null "$@" \
		| awk -F': ' 'tolower($1)=="x-stack-test-cache"{print $2}' | tr -d '\r '
}
# GET-based header dumper. Use whenever caching middleware might gate on method.
get_headers() {
	curl -fsS -D - -o /dev/null "$@"
}

# -------------------------------------------------------------------------
section "T1  Theme cookie × CDN cache interaction"
# -------------------------------------------------------------------------
# Risk: cookie-driven SSR + URL-only cache key = a light-mode visitor primes the
# cache, and dark-mode visitors then receive light HTML for the TTL.
#
# Two checks:
#   (a) The HTML body differs by theme cookie when SSR'd freshly (proves the
#       Worker DOES bake theme into the response — i.e. the trap is real).
#   (b) The Worker's cache key does NOT include the cookie, so the SAME URL
#       returns the SAME body regardless of cookie once cached.
#
# If (a) is true AND (b) is true => pollution risk confirmed. If (a) is false,
# the cached pages are theme-neutral and the risk doesn't apply here.
# T1a: does SSR actually bake the theme cookie into the response?
# Force fresh SSR for each variant by purging the cache between fetches.
purge_url "$HOST/cached/abc"
LIGHT_BODY=$(curl -fsS -H 'Cookie: theme=light' "$HOST/cached/abc" \
	| grep -oE 'data-theme="[^"]+"' | head -n1 || true)
purge_url "$HOST/cached/abc"
DARK_BODY=$(curl -fsS -H 'Cookie: theme=dark' "$HOST/cached/abc" \
	| grep -oE 'data-theme="[^"]+"' | head -n1 || true)

if [ -z "$LIGHT_BODY" ] || [ -z "$DARK_BODY" ]; then
	fail "T1a SSR includes data-theme attribute" \
		"expected to find data-theme=\"...\" in SSR output (light=$LIGHT_BODY dark=$DARK_BODY)"
elif [ "$LIGHT_BODY" != "$DARK_BODY" ]; then
	# Theme is keyed off the cookie — pollution is possible in principle.
	# Whether it's actually exploitable depends on T1b.
	pass "T1a SSR varies by theme cookie (light=$LIGHT_BODY  dark=$DARK_BODY)"
else
	# Both fresh renders came back with the same theme — the cookie is being
	# ignored on this route, or the SSR effect timing means data-theme is set
	# post-render. Either way, the cache-pollution risk doesn't apply.
	pass "T1a SSR is theme-neutral on /cached/:id (cookie does not affect this route)"
fi

# T1b: prove pollution. Prime cache with theme=light, fetch with theme=dark,
# inspect what the cache served.
purge_url "$HOST/cached/abc"
# Prime with theme=light (this populates the URL-keyed cache).
curl -fsS -o /dev/null -H 'Cookie: theme=light' "$HOST/cached/abc"
# The Worker's edgeCache().put runs in ctx.waitUntil after the response, so
# wait for the cache write to land before issuing the second request.
sleep 0.8
# Second hit with a different cookie — should be served from cache.
STATUS=$(cache_status -H 'Cookie: theme=dark' "$HOST/cached/abc")
DARK_BODY_AFTER_PRIME=$(curl -fsS -H 'Cookie: theme=dark' "$HOST/cached/abc" \
	| grep -oE 'data-theme="[^"]+"' | head -n1 || true)

if [ "$STATUS" != "HIT" ]; then
	# If we can't observe a HIT (e.g. cache evicted), this test is inconclusive.
	skip "T1b cache-key cookie isolation" "expected HIT after priming, got status=$STATUS"
elif [ "$LIGHT_BODY" = "$DARK_BODY" ]; then
	# Route is theme-neutral — pollution is moot.
	pass "T1b pollution N/A (T1a showed /cached/:id is theme-neutral)"
elif [ "$DARK_BODY_AFTER_PRIME" = "$LIGHT_BODY" ]; then
	fail "T1b cache pollution confirmed" \
		"dark-cookie request served light HTML from URL-keyed cache; either drop theme from SSR for /cached/* or set Vary/cache-key on cookie"
else
	pass "T1b cache key isolates theme variants"
fi

# -------------------------------------------------------------------------
section "T2  Vary header inspection"
# -------------------------------------------------------------------------
# If the Worker (or framework) emits Vary: Cookie / Accept-Encoding / etc.,
# every variant gets its own cache entry. Purge-by-URL invalidates only the
# variants Cloudflare maps to that URL — `Vary: Cookie` in particular can
# produce many cache fragments and unexpected stale reads after a purge.
VARY=$(get_headers "$HOST/cached/abc" | awk -F': ' 'tolower($1)=="vary"{print $2}' | tr -d '\r' || true)
if [ -z "$VARY" ]; then
	pass "T2 no Vary header on /cached/:id (single cache variant per URL)"
else
	# Cookie or Accept-Encoding in Vary is a yellow flag for purge semantics.
	case "$VARY" in
		*[Cc]ookie*|*Accept-Encoding*)
			fail "T2 Vary header includes risky headers" \
				"Vary: $VARY — purge-by-URL may not invalidate every variant; reconsider cache key"
			;;
		*)
			pass "T2 Vary header present but benign: $VARY"
			;;
	esac
fi

# -------------------------------------------------------------------------
section "T3  404 / KV-miss path"
# -------------------------------------------------------------------------
# /cached/notfound — no KV entry. Expectations:
#   - status is 404 (or at minimum NOT cached as a long-lived 200)
#   - Cache-Control should not let edge cache the miss for hours
HTTP_CODE=$(curl -s -o /tmp/stack-test-404.html -w '%{http_code}' "$HOST/cached/notfound" || true)
CC=$(get_headers "$HOST/cached/notfound" | awk -F': ' 'tolower($1)=="cache-control"{print $2}' | tr -d '\r' || true)
BODY_HAS_NOT_FOUND=0
grep -q -i 'entity not found' /tmp/stack-test-404.html && BODY_HAS_NOT_FOUND=1

if [ "$HTTP_CODE" = "404" ]; then
	pass "T3a /cached/notfound returns 404"
elif [ "$HTTP_CODE" = "200" ] && [ $BODY_HAS_NOT_FOUND -eq 1 ]; then
	fail "T3a /cached/notfound returns 200 with not-found body" \
		"would be cached as a successful response — return 404 from the Worker on KV miss"
else
	fail "T3a /cached/notfound unexpected status $HTTP_CODE"
fi

# A 5-minute cache TTL on a 404 will pin the miss for 5 min after the entity
# is created. Worth flagging.
if [ "$HTTP_CODE" = "200" ] && echo "$CC" | grep -qi 's-maxage=300'; then
	fail "T3b 404-like response is edge-cacheable for 5 min" "Cache-Control: $CC"
else
	pass "T3b 404-like response not pinned at edge for long"
fi

# -------------------------------------------------------------------------
section "T4  HTML escaping of KV content (XSS)"
# -------------------------------------------------------------------------
# KV is user-editable via the admin UI. Confirm Angular interpolation escapes
# script tags injected into the entity title.
XSS_PAYLOAD='<script>window.__pwned=true</script>'
XSS_TITLE='XSS-probe <script>window.__pwned=true</script>'
curl -fsS -X PUT -H 'content-type: application/json' \
	-d "{\"title\":\"$XSS_TITLE\",\"body\":\"benign body\"}" \
	"$HOST/api/data/abc" > /dev/null
sleep 0.5  # let the purge land
PROBE_HTML=$(curl -fsS "$HOST/cached/abc" || true)
if echo "$PROBE_HTML" | grep -qF '<script>window.__pwned'; then
	fail "T4 raw <script> tag rendered into HTML" \
		"Angular failed to escape entity.title → XSS sink"
elif echo "$PROBE_HTML" | grep -qF '&lt;script&gt;window.__pwned'; then
	pass "T4 KV content is HTML-escaped on render"
else
	# Cached HIT may still show the old title. Try a forced purge.
	curl -fsS -X POST -H 'content-type: application/json' \
		-d "{\"url\":\"$HOST/cached/abc\"}" "$HOST/api/purge" > /dev/null || true
	sleep 0.5
	PROBE_HTML=$(curl -fsS "$HOST/cached/abc" || true)
	if echo "$PROBE_HTML" | grep -qF '<script>window.__pwned'; then
		fail "T4 raw <script> tag rendered into HTML (after forced purge)"
	elif echo "$PROBE_HTML" | grep -qF '&lt;script&gt;window.__pwned'; then
		pass "T4 KV content is HTML-escaped on render"
	else
		fail "T4 could not confirm escape behavior — XSS payload missing from response" \
			"the cached page may not be reflecting the latest title; inspect manually"
	fi
fi
reset_seed

# -------------------------------------------------------------------------
section "T5  Concurrent PUT / purge storm"
# -------------------------------------------------------------------------
# Fire N parallel PUTs and verify all return 2xx + a purge result. Detects
# rate-limit and lost-purge issues at small scale.
N=10
TMP=$(mktemp -d)
for i in $(seq 1 $N); do
	(
		code=$(curl -s -o "$TMP/r$i.json" -w '%{http_code}' \
			-X PUT -H 'content-type: application/json' \
			-d "{\"title\":\"concurrent $i\",\"body\":\"burst test $i\"}" \
			"$HOST/api/data/abc")
		echo "$code" > "$TMP/c$i.txt"
	) &
done
wait

BAD=0
PURGE_FAIL=0
for i in $(seq 1 $N); do
	code=$(cat "$TMP/c$i.txt" 2>/dev/null || echo "000")
	if [ "$code" != "200" ]; then
		BAD=$((BAD + 1))
	fi
	# Read purge.status from response if present
	if command -v jq >/dev/null 2>&1; then
		ps=$(jq -r '.purge.status' "$TMP/r$i.json" 2>/dev/null || echo "?")
		case "$ps" in
			200|null|"") ;;
			500)
				PURGE_FAIL=$((PURGE_FAIL + 1))
				;;
			*) PURGE_FAIL=$((PURGE_FAIL + 1)) ;;
		esac
	fi
done

if [ $BAD -eq 0 ]; then
	pass "T5a all $N concurrent PUTs returned 200"
else
	fail "T5a $BAD/$N concurrent PUTs failed" "check $TMP for response bodies"
fi

if [ $IS_LOCAL -eq 1 ]; then
	skip "T5b purge API succeeded for all PUTs" "purge_cache not callable from local dev"
elif [ $PURGE_FAIL -eq 0 ]; then
	pass "T5b purge call accompanied every PUT"
else
	fail "T5b $PURGE_FAIL/$N PUTs reported purge failure" "rate-limit or token-scope issue likely"
fi
rm -rf "$TMP"
reset_seed

# -------------------------------------------------------------------------
section "T6  ETag / conditional requests"
# -------------------------------------------------------------------------
# Whether the Worker emits ETag and honors If-None-Match. Not strictly
# required, but it's a missed bandwidth win if absent. Treat absence as a
# soft fail (documented gap, not architectural block).
ETAG=$(get_headers "$HOST/cached/abc" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r' || true)
if [ -z "$ETAG" ]; then
	# Document as a known gap rather than a hard fail — many SSR setups omit
	# ETag at the framework layer. Promote to FAIL later if the Stage 1 spec
	# mandates conditional GETs.
	skip "T6 no ETag emitted on /cached/:id" \
		"Worker does not emit ETag — clients cannot do If-None-Match; consider adding for bandwidth"
else
	CODE=$(curl -s -o /dev/null -w '%{http_code}' \
		-H "If-None-Match: $ETAG" "$HOST/cached/abc")
	if [ "$CODE" = "304" ]; then
		pass "T6 If-None-Match returns 304 Not Modified (ETag: $ETAG)"
	else
		fail "T6 ETag present but If-None-Match returned $CODE (expected 304)" "ETag: $ETAG"
	fi
fi

# -------------------------------------------------------------------------
section "T7  Bundle size snapshot"
# -------------------------------------------------------------------------
# Snapshot dist/server/server.mjs and dist/browser size so future PRs see growth.
DIST_DIR="$(cd "$(dirname "$0")/.." && pwd)/dist"
if [ -d "$DIST_DIR/server" ] && [ -f "$DIST_DIR/server/server.mjs" ]; then
	SERVER_BYTES=$(wc -c < "$DIST_DIR/server/server.mjs" | tr -d ' ')
	# Sum the whole server dir — the Worker is shipped with its chunks too.
	SERVER_TOTAL=$(find "$DIST_DIR/server" -type f -print0 | xargs -0 wc -c | tail -n1 | awk '{print $1}')
	BROWSER_BYTES=$(find "$DIST_DIR/browser" -type f -print0 | xargs -0 wc -c | tail -n1 | awk '{print $1}')
	printf '  server.mjs:    %8s bytes (%5d KB) entry point\n' "$SERVER_BYTES" "$((SERVER_BYTES / 1024))"
	printf '  server/ total: %8s bytes (%5d KB) Worker upload\n' "$SERVER_TOTAL" "$((SERVER_TOTAL / 1024))"
	printf '  browser/:      %8s bytes (%5d KB) static assets\n' "$BROWSER_BYTES" "$((BROWSER_BYTES / 1024))"
	# Cloudflare's Worker limit is 10MB uncompressed. Warn at 5MB.
	# Use server/ total — that's what Wrangler actually uploads.
	if [ "$SERVER_TOTAL" -gt 10485760 ]; then
		fail "T7 server upload exceeds 10MB Worker limit" "$SERVER_TOTAL bytes"
	elif [ "$SERVER_TOTAL" -gt 5242880 ]; then
		fail "T7 server upload > 5MB (half of Worker budget consumed)" "$SERVER_TOTAL bytes"
	else
		pass "T7 server upload $((SERVER_TOTAL / 1024)) KB (within budget)"
	fi
else
	skip "T7 dist/server/server.mjs not built" "run \`pnpm build\` before this test"
fi

# -------------------------------------------------------------------------
section "summary"
# -------------------------------------------------------------------------
printf '  %s: %d   %s: %d   %s: %d\n' "$(c_pass)" $PASS "$(c_fail)" $FAIL "$(c_skip)" $SKIP
if [ $FAIL -gt 0 ]; then
	printf '\nfailed: %s\n' "${FAILED_NAMES[*]}"
	exit 1
fi
exit 0
