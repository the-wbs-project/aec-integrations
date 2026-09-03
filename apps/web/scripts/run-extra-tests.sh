#!/usr/bin/env bash
#
# apps/web — HTTP-level edge-cache integration runner (AECI-33 / Phase 1.19).
#
# Modeled on the frozen probe `spikes/stack-test/scripts/run-extra-tests.sh`. Asserts the SSR
# Worker's contract at the wire: cookie stripping on cacheable routes, the
# SEO/security header set (§7: `Vary: Accept-Language` only — never `Cookie` /
# `User-Agent` / `Accept-Encoding` — plus `Link: rel=sitemap` and a CSP), short
# TTL on 404s, repeat-request header stability, and locale URL
# prefix behavior.
#
# Usage:
#   HOST=http://localhost:8788 ./scripts/run-extra-tests.sh           # local wrangler dev
#   HOST=https://web.aecintegrations.com ./scripts/run-extra-tests.sh # deployed preview/prod
#
# Wrangler 4.111.0 / Miniflare 4.20260710.0 does not emulate native front-of-
# Worker caching: every localhost request executes the Worker and responses
# carry neither `Cf-Cache-Status` nor `Age`. T7 pins that local no-op contract;
# run against a deployed URL to exercise real MISS → HIT behavior.

set -u

HOST="${HOST:-http://localhost:8788}"
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

# Returns the full response header block using GET (GET/HEAD share a native
# Workers Cache entry, but GET also exercises the SSR response body path).
get_headers() {
	curl -fsS -D - -o /dev/null "$@"
}

# Returns the SHA-256 of the response body — lets us compare two fetches for
# byte-equality without printing the full HTML.
body_hash() {
	curl -fsS "$@" | shasum -a 256 | awk '{print $1}'
}

# -------------------------------------------------------------------------
section "preflight"
# -------------------------------------------------------------------------
if ! curl -fsS -o /dev/null --max-time 10 "$HOST/"; then
	printf '  Host %s not reachable. Start `pnpm dev:bound` first, or set HOST.\n' "$HOST" >&2
	exit 2
fi
pass "host reachable: $HOST"

# -------------------------------------------------------------------------
section "T1  Cookie-strip on cacheable routes (§9.1a)"
# -------------------------------------------------------------------------
# The Worker strips visitor-state cookies before SSR on cacheable routes. Local
# native caching is a no-op, and Angular SSR generates request-specific element
# ids, so whole-document byte equality is not a valid local signal. Instead pin
# the cache classification: cookie variants must receive the same Cache-Control
# and Cache-Tag contract.
LIGHT_HEADERS=$(get_headers -H 'Cookie: theme=light' "$HOST/")
DARK_HEADERS=$(get_headers -H 'Cookie: theme=dark' "$HOST/")
NONE_HEADERS=$(get_headers "$HOST/")
LIGHT_CACHE=$(echo "$LIGHT_HEADERS" | awk -F': ' 'tolower($1)=="cache-control" || tolower($1)=="cache-tag"{print tolower($1) ":" $2}' | tr -d '\r')
DARK_CACHE=$(echo "$DARK_HEADERS" | awk -F': ' 'tolower($1)=="cache-control" || tolower($1)=="cache-tag"{print tolower($1) ":" $2}' | tr -d '\r')
NONE_CACHE=$(echo "$NONE_HEADERS" | awk -F': ' 'tolower($1)=="cache-control" || tolower($1)=="cache-tag"{print tolower($1) ":" $2}' | tr -d '\r')

if [ "$LIGHT_CACHE" = "$DARK_CACHE" ] && [ "$LIGHT_CACHE" = "$NONE_CACHE" ]; then
	pass "T1a / cache headers are identical across theme cookie variants"
else
	fail "T1a cookie variants changed the cache classification" \
		"light=$LIGHT_CACHE | dark=$DARK_CACHE | none=$NONE_CACHE"
fi

# T1b — name the §9.1a contract explicitly: with a theme cookie set, the SSR'd
# `<html>` element must NOT carry a `theme-dark` / `theme-light` class. T1a's
# byte-equality implies this, but AECI-36 AC #4 names it directly. The client
# reconciles the theme post-hydration from localStorage + matchMedia.
HTML_TAG_DARK=$(curl -fsS -H 'Cookie: theme=dark' "$HOST/" | grep -oE '<html[^>]*>' | head -n1 || true)
HTML_TAG_LIGHT=$(curl -fsS -H 'Cookie: theme=light' "$HOST/" | grep -oE '<html[^>]*>' | head -n1 || true)
if [ -z "$HTML_TAG_DARK" ] || [ -z "$HTML_TAG_LIGHT" ]; then
	fail "T1b could not locate <html> element in SSR response"
elif echo "$HTML_TAG_DARK $HTML_TAG_LIGHT" | grep -qE 'theme-(dark|light)|data-theme='; then
	fail "T1b <html> carries visitor-state theme class/attr — cache poisoning risk" \
		"dark: $HTML_TAG_DARK | light: $HTML_TAG_LIGHT"
else
	pass "T1b <html> has no theme class/attr regardless of theme cookie"
fi

# -------------------------------------------------------------------------
section "T2  SEO/security header set on cached responses (§7, AECI-89)"
# -------------------------------------------------------------------------
# §7 mandates three headers on every cacheable response. `Vary` is
# delete-then-set: locale is URL-segmented (so Cloudflare's URL-only key is
# unaffected) and advertised as `Accept-Language`, while `Cookie` /
# `User-Agent` / `Accept-Encoding` — which fragment the edge cache with no
# purge handle — are stripped. The sitemap `Link` and the `Content-Security-
# Policy` are emitted by `server/seo-headers.ts`.
ROOT_HEADERS=$(get_headers "$HOST/")
VARY=$(echo "$ROOT_HEADERS" | awk -F': ' 'tolower($1)=="vary"{print $2}' | tr -d '\r' || true)
case "$VARY" in
	*[Cc]ookie*|*[Uu]ser-[Aa]gent*|*[Aa]ccept-[Ee]ncoding*)
		fail "T2a Vary includes a forbidden value" \
			"Vary: $VARY — purge-by-URL may not invalidate every variant"
		;;
	*[Aa]ccept-[Ll]anguage*)
		pass "T2a Vary: $VARY"
		;;
	*)
		fail "T2a Vary missing Accept-Language" "Vary: ${VARY:-<absent>}"
		;;
esac

LINK=$(echo "$ROOT_HEADERS" | awk -F': ' 'tolower($1)=="link"{print $2}' | tr -d '\r' || true)
case "$LINK" in
	*"</sitemap.xml>"*) pass "T2b Link advertises the sitemap: $LINK" ;;
	*) fail "T2b Link missing sitemap rel" "Link: ${LINK:-<absent>}" ;;
esac

CSP=$(echo "$ROOT_HEADERS" | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}' | tr -d '\r' || true)
if [ -n "$CSP" ]; then
	pass "T2c Content-Security-Policy present"
else
	fail "T2c Content-Security-Policy absent" "a public SSR app must ship a CSP"
fi

# -------------------------------------------------------------------------
section "T3  404 short TTL (§9.1b)"
# -------------------------------------------------------------------------
# Unknown paths fall through to the cacheable branch; Angular SSR returns
# 404 → the Worker emits NOT_FOUND_TTL ({edge:60, browser:0}), which tells the
# native cache to store it only briefly. Assert: status is 404 AND the
# Cache-Control max-age / s-maxage are well under 5 minutes.
NOT_FOUND_PATH="/aeci-33-does-not-exist"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HOST$NOT_FOUND_PATH" || true)
CC=$(get_headers "$HOST$NOT_FOUND_PATH" | awk -F': ' 'tolower($1)=="cache-control"{print $2}' | tr -d '\r' || true)

if [ "$HTTP_CODE" = "404" ]; then
	pass "T3a $NOT_FOUND_PATH returns 404 (not 200 with not-found body)"
else
	fail "T3a $NOT_FOUND_PATH unexpected status $HTTP_CODE" \
		"would risk getting cached as a successful response"
fi

# Pull s-maxage / max-age from the Cache-Control header.
SMAX=$(echo "$CC" | grep -oE 's-maxage=[0-9]+' | head -n1 | cut -d= -f2 || true)
MAX=$(echo "$CC" | grep -oE 'max-age=[0-9]+' | head -n1 | cut -d= -f2 || true)
# Either the cacheable branch (s-maxage=60) or the no-store branch is acceptable
# — both prevent a 404 from being cached for the full route TTL.
if echo "$CC" | grep -qi 'no-store'; then
	pass "T3b 404 has Cache-Control: no-store"
elif [ -n "$SMAX" ] && [ "$SMAX" -le 60 ]; then
	pass "T3b 404 s-maxage=$SMAX (≤60s) and max-age=${MAX:-?}"
else
	fail "T3b 404 has long TTL" "Cache-Control: $CC"
fi

# -------------------------------------------------------------------------
section "T4  Repeat-response contract (§9.1, §9.3)"
# -------------------------------------------------------------------------
# Local uncached SSR can contain request-specific element ids, so pin the stable
# response-header contract there. On a deployed host, the second response is an
# edge HIT and must return the byte-identical body stored from the MISS.
if [ $IS_LOCAL -eq 1 ]; then
	A_HEADERS=$(get_headers "$HOST/")
	B_HEADERS=$(get_headers "$HOST/")
	A_CONTRACT=$(echo "$A_HEADERS" | awk -F': ' 'tolower($1)=="cache-control" || tolower($1)=="cache-tag" || tolower($1)=="x-robots-tag"{print tolower($1) ":" $2}' | tr -d '\r')
	B_CONTRACT=$(echo "$B_HEADERS" | awk -F': ' 'tolower($1)=="cache-control" || tolower($1)=="cache-tag" || tolower($1)=="x-robots-tag"{print tolower($1) ":" $2}' | tr -d '\r')
	if [ "$A_CONTRACT" = "$B_CONTRACT" ]; then
		pass "T4 / stable cache/robots headers across local repeat fetches"
	else
		fail "T4 / stable response headers changed across local repeat fetches" \
			"first=$A_CONTRACT | second=$B_CONTRACT"
	fi
else
	# Deployed host — exercise the edge cache directly.
	curl -fsS -o /dev/null "$HOST/"
	sleep 0.8  # let the platform store the response
	A=$(body_hash "$HOST/")
	B=$(body_hash "$HOST/")
	if [ "$A" = "$B" ]; then
		pass "T4 / cached response is byte-stable (deployed HIT)"
	else
		fail "T4 / cached response varies between requests" "first=$A second=$B"
	fi
fi

# -------------------------------------------------------------------------
section "T5  Locale URL prefix (§7a.3a, server-runtime.ts LOCALES)"
# -------------------------------------------------------------------------
# Only en-US is registered today (empty prefix). Assertions:
#   T5a — `/` resolves and serves the en-US default (no prefix).
#   T5b — an unregistered locale prefix (e.g. `/xx/`) does NOT alias `/`
#         in the cache; it falls through and produces a non-200, OR returns
#         a body distinct from `/` (proves the cache key includes the prefix).
ROOT_HASH=$(body_hash "$HOST/")
ROOT_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/")
if [ "$ROOT_CODE" = "200" ] && [ -n "$ROOT_HASH" ]; then
	pass "T5a / returns 200 (default locale en-US, no prefix)"
else
	fail "T5a / unexpected status $ROOT_CODE"
fi

# Test an unknown locale prefix. When more locales are added, replace `/xx/`
# with a real registered prefix and assert lang=xx + per-locale chrome.
UNKNOWN_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/xx/")
UNKNOWN_HASH=$(body_hash "$HOST/xx/" 2>/dev/null || echo "")
if [ "$UNKNOWN_CODE" = "404" ]; then
	pass "T5b /xx/ (unregistered locale) returns 404 — no cache aliasing"
elif [ "$UNKNOWN_HASH" != "$ROOT_HASH" ]; then
	pass "T5b /xx/ body diverges from / — no cache key collision"
else
	fail "T5b /xx/ served identical bytes to / — cache key may collide" \
		"hash=$UNKNOWN_HASH code=$UNKNOWN_CODE"
fi

# -------------------------------------------------------------------------
section "T6  Cache-Control on / matches §9.2 (AECI-36 AC #2)"
# -------------------------------------------------------------------------
# §9.2 pins `/` at 15min edge / 5min browser. `server-runtime.ts` produces
# `public, max-age=300, s-maxage=900` via `buildCacheControl({edge:900,
# browser:300})`. Assert at the wire so a regression in the TTL table is
# caught immediately.
ROOT_CC=$(get_headers "$HOST/" | awk -F': ' 'tolower($1)=="cache-control"{print $2}' | tr -d '\r' || true)
ROOT_SMAX=$(echo "$ROOT_CC" | grep -oE 's-maxage=[0-9]+' | head -n1 | cut -d= -f2 || true)
ROOT_MAX=$(echo "$ROOT_CC" | grep -oE 'max-age=[0-9]+' | head -n1 | cut -d= -f2 || true)
if [ "$ROOT_SMAX" = "900" ] && [ "$ROOT_MAX" = "300" ]; then
	pass "T6 / Cache-Control: $ROOT_CC"
else
	fail "T6 / Cache-Control does not match §9.2 (expected max-age=300, s-maxage=900)" \
		"got: $ROOT_CC"
fi

# -------------------------------------------------------------------------
section "T7  Native Workers Cache local no-op / deployed HIT (AECI-323)"
# -------------------------------------------------------------------------
# Locally, pin the confirmed no-op behavior: repeated requests carry neither
# `Cf-Cache-Status` nor `Age`. On a deployed Worker, assert a repeat request
# reaches the native cache. The exact cold MISS → HIT transition uses a unique
# key in `e2e/edge-cache.spec.ts` so prior traffic cannot pre-warm it.
if [ $IS_LOCAL -eq 1 ]; then
	HEADERS_ONE=$(get_headers "$HOST/")
	HEADERS_TWO=$(get_headers "$HOST/")
	CF_ONE=$(echo "$HEADERS_ONE" | awk -F': ' 'tolower($1)=="cf-cache-status"{print $2}' | tr -d '\r' | head -n1)
	CF_TWO=$(echo "$HEADERS_TWO" | awk -F': ' 'tolower($1)=="cf-cache-status"{print $2}' | tr -d '\r' | head -n1)
	AGE_ONE=$(echo "$HEADERS_ONE" | awk -F': ' 'tolower($1)=="age"{print $2}' | tr -d '\r' | head -n1)
	AGE_TWO=$(echo "$HEADERS_TWO" | awk -F': ' 'tolower($1)=="age"{print $2}' | tr -d '\r' | head -n1)
	if [ -z "$CF_ONE" ] && [ -z "$CF_TWO" ] && [ -z "$AGE_ONE" ] && [ -z "$AGE_TWO" ]; then
		pass "T7 local native cache is a no-op (no Cf-Cache-Status or Age)"
	else
		fail "T7 local native-cache behavior changed; update the pinned contract" \
			"first: cf=${CF_ONE:-absent} age=${AGE_ONE:-absent}; second: cf=${CF_TWO:-absent} age=${AGE_TWO:-absent}"
	fi
else
	# Prime, wait briefly for the platform store, then re-request and inspect.
	curl -fsS -o /dev/null "$HOST/"
	sleep 0.8
	HEADERS_TWO=$(get_headers "$HOST/")
	CF_STATUS=$(echo "$HEADERS_TWO" | awk -F': ' 'tolower($1)=="cf-cache-status"{print $2}' | tr -d '\r' | head -n1)
	AGE=$(echo "$HEADERS_TWO" | awk -F': ' 'tolower($1)=="age"{print $2}' | tr -d '\r' | head -n1)
	if [ "$CF_STATUS" = "HIT" ]; then
		pass "T7 second request returned cf-cache-status: HIT (age=${AGE:-?})"
	elif [ -n "$AGE" ] && [ "$AGE" -gt 0 ] 2>/dev/null; then
		pass "T7 second request served from cache (age=$AGE, cf-cache-status=${CF_STATUS:-absent})"
	else
		fail "T7 second request did not show cache HIT" \
			"cf-cache-status=${CF_STATUS:-absent} age=${AGE:-absent}"
	fi
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
