# AECi Review — stack-test

Throwaway validation probe for the Phase 1 foundation stack. See
[`/.context/attachments/pasted_text_2026-05-12_09-00-59.txt`](../../.context/attachments/pasted_text_2026-05-12_09-00-59.txt)
for the full spec.

**Stack under test**

- Angular 21+ in **zoneless** mode with SSR (`@angular/ssr` + `experimentalPlatform: neutral`)
- Cloudflare Workers as the SSR runtime, Workers Assets for the browser bundle
- Cloudflare CDN caching at the edge via `Cache-Control` headers
- Cloudflare cache invalidation via `purge_cache` REST API
- Spartan brain primitives (`@spartan-ng/brain`) + Angular CDK (overlay/dialog)
- Tailwind v4 with CSS custom property tokens (light/dark)
- Cookie-driven theme detection in SSR
- KV-backed entities — data changes trigger purges

## What's in here

```
src/
├── server.ts                        Cloudflare Worker entry — KV CRUD + purge + SSR
├── main.ts / main.server.ts         Angular bootstrap (client + server)
├── styles.css                       Tailwind v4 + Spartan preset + theme tokens
├── theme-tokens.css                 Forest/Clay/Bone light + dark palettes
└── app/
    ├── app.ts                       Root shell, header, theme cycle
    ├── app.config.ts                Zoneless, hydration with HTTP transfer cache
    ├── app.config.server.ts         SSR-only providers
    ├── app.routes.ts / *.server.ts  Route config
    ├── theme.service.ts             Signal-based theme; cookie ↔ localStorage ↔ matchMedia
    ├── data.service.ts              HttpClient calls to /api/* (transfer-cached)
    ├── entity.ts                    Entity type
    ├── home/                        Spartan smoke test + CDK Dialog
    ├── cached/                      /cached/:id — KV-backed cacheable page
    └── admin/                       /admin (list) · /admin/:id (edit) · /admin/purge (raw)
```

## Local development

```sh
# From the monorepo root:
pnpm install
pnpm dev:stack-test                       # builds + wrangler dev on :8789

# Or from this directory:
pnpm run dev
```

Miniflare creates a local KV namespace automatically — no setup needed for dev.
The Worker seeds `entity:abc` and `entity:xyz` on first request so the test
routes have data to render.

## Required Cloudflare setup (before deploy)

1. **Create the KV namespace** and update `wrangler.jsonc` with the returned ids:

   ```sh
   pnpm exec wrangler kv namespace create STACK_TEST_KV
   pnpm exec wrangler kv namespace create STACK_TEST_KV --preview
   ```

   Replace `PLACEHOLDER_KV_ID` and `PLACEHOLDER_KV_PREVIEW_ID` in
   `wrangler.jsonc` with the ids printed by those commands.

2. **Set purge secrets** (Cloudflare API token scoped to `Zone.Cache Purge`
   on `aecintegrations.com` only):

   ```sh
   pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --env production
   pnpm exec wrangler secret put CLOUDFLARE_ZONE_ID   --env production
   ```

3. **DNS** — in the Cloudflare dashboard for `aecintegrations.com`, add a
   proxied A/AAAA/CNAME record for `stack-test.aecintegrations.com` pointing
   at any IP (Workers replaces it on dispatch). Or use Wrangler's
   `custom_domain` flow which provisions the record automatically.

4. **Deploy**:

   ```sh
   pnpm run deploy
   ```

   Reachable at `https://stack-test.aecintegrations.com`.

## Test scenarios

Walk through these on the deployed URL and record pass/fail in the table below.
Section numbers match the source spec (Section 5).

### Local-checkable now (already verified during build)

- [x] **5.1.1** `pnpm run build` produces an Angular SSR bundle for Cloudflare Workers
- [x] **5.1.3** `zone.js` is not in the production bundle — `package.json` has no `zone.js` dep, polyfills file empty of zone refs
- [x] **5.2.1** `/` returns SSR'd HTML (not an empty `<app-root>` shell)
- [x] **5.4.1** `provideZonelessChangeDetection()` is in `src/app/app.config.ts`
- [x] **5.4.2** No `zone.js` imports anywhere in `src/`
- [x] **5.6.3** `/cached/abc` and `/cached/xyz` render different entity content from KV
- [x] **5.7** Editing `entity:abc` via `PUT /api/data/abc` writes KV and returns purge call result (purge correctly fails with a clear 500 + message when secrets are unset — the intended escape hatch)

### Requires deploy to verify

| Section | Scenario | Result | Notes |
|---|---|---|---|
| 5.1 | Build & deploy | | |
| 5.2 | Server-side rendering | | |
| 5.3 | Hydration (no console warnings) | | |
| 5.4 | Zoneless behavior at runtime | | |
| 5.5 | Theme system (cookie SSR, matchMedia client) | | |
| 5.6 | Edge caching MISS → HIT | | |
| 5.7 | Cache invalidation (data-driven + raw) | | |
| 5.8 | Spartan UI + CDK Dialog | | |
| 5.9 | Tailwind integration | | |
| 5.10 | Worker observability via `wrangler tail` | | |

### Supplementary tests (not in original spec)

Run automatically via `pnpm test:extra` against the live host:

```sh
HOST=http://localhost:8789 pnpm test:extra
HOST=https://stack-test.aecintegrations.com pnpm test:extra
```

| ID | Scenario | Why it matters |
|---|---|---|
| T1 | Theme cookie × CDN cache | URL-only cache key + cookie-driven SSR is the classic personalization-vs-CDN trap |
| T2 | `Vary` header inspection | `Vary: Cookie` fragments cache and undermines purge-by-URL semantics |
| T3 | 404 / KV-miss path | A 200 with not-found body, cached for 5 min, pins the miss after the entity is created |
| T4 | HTML-escaping of KV content | KV is user-editable — entity title must not render as raw `<script>` |
| T5 | Concurrent PUT / purge storm | Surfaces rate-limit, dropped purges, or token-scope issues at small scale |
| T6 | ETag / `If-None-Match` | Missing ETag = wasted bandwidth on hot pages; soft fail today, decide before Phase 2 |
| T7 | Bundle size snapshot | Baseline `server.mjs` size so growth is visible; fails over 5 MB (half the 10 MB Worker limit) |

#### Results — first run against `wrangler dev` (2026-05-12)

```
PASS  T1a  SSR varies by theme cookie (light=data-theme="light"  dark=data-theme="dark")
FAIL  T1b  cache pollution confirmed — dark-cookie request served light HTML from URL-keyed cache
PASS  T2   no Vary header on /cached/:id
FAIL  T3a  /cached/notfound returns 200 with not-found body (would cache as success)
FAIL  T3b  404-like response is edge-cacheable for 5 min (Cache-Control: public, s-maxage=300)
PASS  T4   KV content is HTML-escaped on render
PASS  T5a  all 10 concurrent PUTs returned 200
SKIP  T5b  purge_cache call not exercised locally
SKIP  T6   no ETag emitted on /cached/:id — bandwidth-optimization gap, not a blocker
PASS  T7   server upload 1089 KB (within Worker budget)
```

**Phase 2 implications**

- **T1b + T3a/b together are the only architectural finding.** The Worker's
  edge cache is keyed by URL alone, but `/cached/:id` SSR bakes the theme
  cookie into the `<html data-theme>` attribute and also bakes a "not found"
  body into the 200 response when KV misses. Two fixes get this clean:
  1. Either drop theme out of SSR for `/cached/*` (render neutral, let the
     client paint the theme after hydration), or set the Worker's cache key
     to include the `theme` cookie (and similarly for any future personalized
     header).
  2. Return 404 (and `Cache-Control: public, max-age=60, s-maxage=60` at most)
     when the resolver gets `null` from KV, so a not-found page doesn't get
     pinned at the edge for 5 minutes after the entity is created.
- T6 (ETag) is a soft gap. Worth adding before launch but not a Phase 2
  blocker.

### Headline commands

Replace `${HOST}` with `https://stack-test.aecintegrations.com` (or
`http://localhost:8788` for local).

```sh
# Bundle audit — zone.js absent
pnpm exec npx source-map-explorer dist/server/server.mjs

# SSR proof
curl -s "${HOST}/" | grep -c '<app-root>'   # > 0 confirms shell exists
curl -s "${HOST}/" | grep -c 'Hello from'   # but content also rendered

# Cache MISS → HIT
curl -sI "${HOST}/cached/abc" | grep -i cf-cache-status   # MISS first
curl -sI "${HOST}/cached/abc" | grep -i cf-cache-status   # HIT second

# Data-driven purge round-trip
curl -s -X PUT -H 'content-type: application/json' \
  -d '{"title":"Edited via curl","body":"new body"}' \
  "${HOST}/api/data/abc"
# → expect { "kv":"ok", "entity":{...}, "purge":{ "status":200, "body":{...} } }
curl -sI "${HOST}/cached/abc" | grep -i cf-cache-status   # MISS (purged)
curl -s   "${HOST}/cached/abc" | grep -oE 'Edited via curl'   # > 0 = new content

# Isolation check — purging abc does NOT invalidate xyz
curl -sI "${HOST}/cached/xyz" | grep -i cf-cache-status   # still HIT
```

## Risk areas (from spec Section 6)

- **Angular SSR adapter on Workers** — solved at scaffold time by
  `@angular/build` with `experimentalPlatform: "neutral"` and the
  `AngularAppEngine` in `src/server.ts`. The `npm create cloudflare@latest`
  flow wires this up correctly.
- **Spartan + zoneless** — we use brain primitives directly (no `helm`
  generator hang issues encountered in the alpha CLI). Brain components are
  signal-based and ship as standalone directives.
- **Hydration mismatches** — CDK Dialog on `/` opens an overlay
  imperatively (client-side only after click), so no SSR/CSR DOM divergence.
- **Theme detection in SSR** — `ThemeService` reads the `theme` cookie via
  Angular's `REQUEST` token server-side, sets `<html data-theme>` before
  hydration, and reconciles with `localStorage` after `afterNextRender`.
  This is the robust cookie path called out in the spec.
- **Cloudflare API token scoping** — token must have `Zone.Cache Purge`
  on `aecintegrations.com` only. The `/admin/purge` raw-URL form is the
  test harness for verifying this in isolation.

## Decision criteria (Section 10)

**GO** if 5.1–5.10 all pass or fail only with documented workarounds.
**HARD STOP** if any of:

- SSR doesn't deploy to Workers at all
- Zoneless + Spartan brain has fundamental incompatibilities
- `purge_cache` doesn't work on the Pro plan as documented
- Hydration mismatches are unfixable across multiple components

When done, archive findings to update the Stage 1 spec (Section 11 of source).
