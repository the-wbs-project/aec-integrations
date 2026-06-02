#!/usr/bin/env bash
#
# apps/web — HTTP-level edge-cache integration runner (AECI-33 / Phase 1.19).
#
# Modeled on the frozen probe `spikes/stack-test/scripts/run-extra-tests.sh`. Asserts the SSR
# Worker's contract at the wire: cookie stripping on cacheable routes, the
# SEO/security header set (§7: `Vary: Accept-Language` only — never `Cookie` /
# `User-Agent` / `Accept-Encoding` — plus `Link: rel=sitemap` and a CSP), short
# TTL on 404s, byte-stable repeat fetches (idempotent HIT), and locale URL
# prefix behavior.
#
# Usage:
#   HOST=http://localhost:8788 ./scripts/run-extra-tests.sh           # local wrangler dev
#   HOST=https://web.aecintegrations.com ./scripts/run-extra-tests.sh # deployed preview/prod
#
# Cache-observation tests SKIP against localhost because Miniflare's
# `caches.default` doesn't behave like Cloudflare's edge cache (same pattern
# as the stack-test runner). Run against a deployed URL to exercise them.

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

# Returns the full response header block (GET, not HEAD — the cache pipeline
# gates on method).
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
# The Worker strips visitor-state cookies (currently `theme`) before SSR on
# cacheable routes. Proof: two fetches of `/` with different theme cookies
# must produce byte-identical HTML. If SSR saw the cookie it would bake a
# different `<html class="theme-dark">` body into the response and the
# first visitor would poison the cache for everyone else.
LIGHT_HASH=$(body_hash -H 'Cookie: theme=light' "$HOST/")
DARK_HASH=$(body_hash -H 'Cookie: theme=dark' "$HOST/")
NONE_HASH=$(body_hash "$HOST/")

if [ "$LIGHT_HASH" = "$DARK_HASH" ] && [ "$LIGHT_HASH" = "$NONE_HASH" ]; then
	pass "T1a / SSR HTML is byte-identical across theme cookie variants"
else
	fail "T1a cookie-strip broken — SSR HTML differs by theme cookie" \
		"light=$LIGHT_HASH dark=$DARK_HASH none=$NONE_HASH"
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
# 404 → the Worker emits NOT_FOUND_TTL ({edge:60, browser:60}) and does NOT
# put the response into caches.default. Assert: status is 404 AND the
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
section "T4  Idempotent HIT (§9.1, §9.3)"
# -------------------------------------------------------------------------
# Two consecutive GETs of a cacheable URL must return byte-identical bodies.
# Locally this proves SSR determinism + the cookie-strip path; on a deployed
# host, the second response should be served from the edge cache.
if [ $IS_LOCAL -eq 1 ]; then
	# Miniflare's caches.default has differing semantics from real Cloudflare,
	# but SSR determinism is still testable. Prove idempotency at the body
	# level; treat actual cache-HIT detection as a deployed-host concern.
	A=$(body_hash "$HOST/")
	sleep 0.3
	B=$(body_hash "$HOST/")
	if [ "$A" = "$B" ]; then
		pass "T4 / is byte-stable across repeat fetches (local: HIT detection skipped)"
	else
		fail "T4 / SSR is non-deterministic across repeat fetches" "first=$A second=$B"
	fi
else
	# Deployed host — exercise the edge cache directly.
	curl -fsS -o /dev/null "$HOST/"
	sleep 0.8  # let edge cache.put land
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
section "T7  Edge cache HIT on second request (AECI-36 AC #3, deployed only)"
# -------------------------------------------------------------------------
# AC #3 asserts the second consecutive request to `/` is served from cache.
# Cloudflare exposes this via `cf-cache-status: HIT` and/or `age: >0`.
# Miniflare doesn't model the edge cache the same way, so SKIP locally and
# direct the operator at the deployed runner.
if [ $IS_LOCAL -eq 1 ]; then
	skip "T7 cache HIT detection requires real edge cache" \
		"re-run with HOST=https://<preview>.workers.dev to validate"
else
	# Prime, wait briefly for cache.put to land, then re-request and inspect.
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
