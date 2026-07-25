# Review App → AECi Promotion API

**Audience:** whoever builds the "Promote" action in the **review application**.
**Status:** ready to integrate. The endpoint is live in the main AECi API
(`apps/api`, `POST /api/promote`).

This document is the contract for pushing a promoted product from the review app
into the public AECi database (Supabase). Read it end-to-end before implementing.

---

## 1. What changed and why

Previously, promotion was a **pull**: a CLI script on the AECi side read every
Airtable record flagged `promotion_status = 'promoted'` and copied it into
Supabase. That script is now **deprecated**.

Promotion is now a **push you initiate**. When a curator clicks **Promote** in
the review app, the review app sends that product — plus its vendors, taxonomy,
and integrations — to `POST /api/promote`. The AECi API inserts (or updates) the
rows and **returns the database IDs it created**. The review app stores those IDs
and, whenever the curator edits the product later, **re-pushes** the same bundle
to update the live records.

```
Curator clicks "Promote"
        │
        ▼
Review app assembles the product bundle  ──POST /api/promote──▶  AECi API
        ▲                                                          │ upsert + audit
        │                                                          ▼
   store returned IDs   ◀──────────  { vendors[], product, integrations[], … }
```

### Your responsibilities

1. **Persist the returned IDs.** For each entity you push, store the `id` AECi
   returns (e.g. `supabase_vendor_id`, `supabase_product_id`,
   `supabase_integration_id`). This mapping is **the only link** between your
   records and the AECi rows — AECi does **not** store your Airtable/record IDs.
2. **Send the stored ID back on edits.** Presence of the ID is what makes a push
   an update instead of a new insert. **If you lose the mapping, a re-push
   creates duplicates** — persist it durably.
3. **Do not send slugs.** AECi owns URL slugs; it generates them on first
   promote and keeps them stable. The response tells you the slug that became the
   public URL.

---

## 2. Endpoint

```
POST {API_BASE}/api/promote
Authorization: Bearer {REVIEW_APP_TOKEN}
Content-Type: application/json
```

| Environment | `{API_BASE}` |
|---|---|
| Production  | `https://<prod-api-host>` (the production AECi API Worker) |
| Staging     | `https://<staging-api-host>` |
| Preview/dev | `http://localhost:8787` (local `wrangler dev`) |

> The exact deployed hostnames live in the AECi Worker config; ask the AECi team
> for the staging/production API host. The API Worker is private — call it
> directly over the bearer token, not through the public website.

**`REVIEW_APP_TOKEN`** is a shared secret issued by the AECi team (a high-entropy
string). Store it securely in the review app's server-side config; never ship it
to a browser. AECi compares it constant-time and rejects a missing/wrong token
with `401`.

### 2.1 `x-d1-bookmark` — read-your-writes across calls (optional, AECI-250)

AECi serves reads from D1 read replicas (lower latency), so a read issued
*immediately* after a promote could momentarily hit a replica that hasn't caught
up. To get **read-your-writes** across successive calls, thread the D1 session
bookmark:

- Every `POST /api/promote` response includes an **`x-d1-bookmark`** response
  header — an opaque token naming the database version your write produced.
- On a **subsequent** request, send that value back as the **`x-d1-bookmark`**
  request header. AECi resumes the same logical session, so the next read/write is
  guaranteed to see everything up to that bookmark.

This is **optional**. If you don't thread it, promotes are still durable and
strongly consistent (writes go to the primary); only a same-instant follow-up read
might briefly lag. Treat the header value as opaque (don't parse it), persist the
**latest** one you've seen, and replay it on the next call. Omitting it is
equivalent to "start from any replica."

---

## 3. Request body

The usual promote = **one product** plus its dependencies. Top-level shape:

```jsonc
{
  "vendors":      [ /* vendors of this product (0+; usually 1) */ ],
  "product":      { /* the product being promoted — OPTIONAL (see below) */ },
  "integrations": [ /* integrations incident to this product (0+) */ ]
}
```

**`product` is optional.** You can push **just a vendor** (or just integrations)
without a product — see §3.5. The only rule is that the payload must contain at
least one of `vendors`, `product`, or `integrations`; a fully empty body is
rejected `400`.

### 3.1 The `ref` vs `supabaseId` rule (read this carefully)

Two different identifiers appear throughout the payload:

- **`ref`** — a **client-local label you make up** (any unique non-empty string,
  e.g. `"v1"`, `"p1"`). It exists only to wire entities together *inside one
  request* (e.g. "this integration's source is the product `p1`"). Refs must be
  **unique across the whole payload**. They are not stored.
- **`supabaseId`** — the **AECi database UUID** you previously stored. Its
  presence means **update this existing row**; its absence means **create a new
  row**.

So:

| You want to… | Set `supabaseId`? |
|---|---|
| Promote a product/vendor for the first time | No (omit it) → created |
| Re-push edits to an already-promoted product | Yes (the stored UUID) → updated |
| Point at another already-promoted entity (e.g. an integration's far endpoint) | Yes, in the reference object: `{ "supabaseId": "<uuid>" }` |
| Point at an entity declared in *this same* payload | Use `{ "ref": "<that-entity's-ref>" }` |

### 3.2 `vendors[]`

Every vendor in this array becomes a vendor **of the product** (a
`product_vendor` link). Order matters only for the primary flag.

| Field | Type | Required | Notes |
|---|---|---|---|
| `ref` | string | ✅ | Unique local label; referenced by `product` and `builtByVendor`. |
| `supabaseId` | uuid \| null | — | Present → update that vendor; absent → create. |
| `companyName` | string | ✅ | |
| `isPrimary` | boolean | — | Defaults to `true` for the first vendor, `false` otherwise. |
| `description`, `website`, `headquarters`, `parentCompany`, `linkedinUrl`, `xUrl`, `facebookUrl`, `instagramUrl`, `youtubeUrl`, `crunchbaseUrl`, `wikiUrl`, `sourceUrl`, `githubOrg`, `phoneNumber`, `contactEmail`, `logoUrl` | string \| null | — | Free-form. `xUrl` / `facebookUrl` / `instagramUrl` / `youtubeUrl` are full canonical URLs persisted verbatim to `vendors.{x,facebook,instagram,youtube}_url` and rendered as icons in the public vendor hero; `githubOrg` is persisted as a bare handle but is not surfaced in the public vendor contract. |
| `foundedYear` | int \| null | — | |
| `publicPrivate` | `"public"` \| `"private"` \| null | — | |
| `verified` | boolean | — | Defaults to `false`. |

### 3.3 `product` (optional, singular)

Omit it entirely for a vendor-only / integration-only push (§3.5). When present:

| Field | Type | Required | Notes |
|---|---|---|---|
| `ref` | string | ✅ | Unique local label; integrations reference it as their endpoint. |
| `supabaseId` | uuid \| null | — | Present → update; absent → create. |
| `name` | string | ✅ | |
| `productRole` | `"application"` \| `"connector"` \| `"hybrid"` | — | Defaults to `"application"`. |
| `categories` | string[] | — | Category **names or slugs**. Find-or-created by slug. |
| `audiences` | string[] | — | Audience names or slugs. |
| `phases` | string[] | — | Project-phase names or slugs. |
| `usefulness` | `{ audiences: UsefulnessGroup[]; phases: UsefulnessGroup[] }` \| null | — | Per-audience / per-phase narrative value. `UsefulnessGroup = { slug \| name, points: string[] }` (≥ 1 point). See **`usefulness` resolution** below. |
| `extensionOf` | `{ supabaseId }[]` | — | Host products this product extends. **Must use `supabaseId`** (hosts are promoted separately). |
| `description`, `website`, `toolIntegrationsUrl`, `apiDocsUrl`, `toolIntegrationCheckNotes`, `logoUrl`, `researchNotes`, `adminNotes` | string \| null | — | |
| `hasApiDocs` | boolean | — | |
| `researchStatus` | `"pending"` \| `"in_progress"` \| `"done"` \| `"blocked"` \| null | — | |
| `priorityTier` | `"tier_1"` … `"tier_5"` \| null | — | |
| `priorityScore` | number \| null | — | |
| `googleTrendsIndex` | int 0–100 \| null | — | |
| `searchVolumeMonthly`, `redditMentions24mo` | int \| null | — | |

> Do **not** send `id`, `slug`, `createdAt`, `updatedAt`, or `promotionStatus` —
> they are server-managed. On promote, AECi sets `promotion_status = 'promoted'`.

**`usefulness` resolution.** The Airtable source field nests `disciplines` and `phases`; the review app renames `disciplines` → `audiences` before sending (per AECI-121), so the payload key is always `audiences` — there is no `disciplines` alias. Each group names its taxonomy term by `slug` or `name`. **Unlike the `categories`/`audiences`/`phases` facet arrays above, usefulness groups never find-or-create** — AECi resolves each group against an **existing** audience/phase term (by `slug`, then `name`, with the same normalization as the facet path) and stores the canonical `{ slug, name }` it resolved to, plus the group's `points`, as slug-based `jsonb` on the product (`DATABASE_SCHEMA.md` §4.2; public shape `ProductUsefulness`, `API_CONTRACTS.md` §5.1). Within a facet, groups that resolve to the same term are merged (points concatenated, source order preserved). A group that resolves to no existing term is dropped from the stored value and reported in `skipped[]` (§4) with `kind: "usefulness"` and `ref` set to the product's `ref`. Send `usefulness: null` (or omit it) when there is no value for either facet; otherwise either facet array may be empty.

### 3.4 `integrations[]`

Send only integrations where the product being promoted is **one of the two
endpoints**. The other endpoint must already be promoted (reference it by
`supabaseId`). If the other endpoint isn't promoted yet, **omit the integration**
— it will be created when that product is promoted.

| Field | Type | Required | Notes |
|---|---|---|---|
| `ref` | string | ✅ | Unique local label. |
| `supabaseId` | uuid \| null | — | Present → update; absent → create. |
| `name` | string \| null | — | |
| `sourceProduct` | `{ ref }` \| `{ supabaseId }` | ✅ | One endpoint. `{ ref: <product.ref> }` for the product in this bundle. |
| `targetProduct` | `{ ref }` \| `{ supabaseId }` | ✅ | The other endpoint. |
| `builtByVendor` | `{ ref }` \| `{ supabaseId }` \| null | — | `ref` must name a vendor in `vendors[]`; otherwise use `supabaseId`. |
| `poweredByProduct` | `{ ref }` \| `{ supabaseId }` \| null | — | |
| `mechanismKind` | `"native"` \| `"iPaaS"` \| `"marketplace-app"` \| `"api"` \| `"webhook"` \| `"partner"` \| null | — | |
| `direction` | `"one-way"` \| `"bidirectional"` \| null | — | |
| `mechanismName`, `description`, `listingUrl`, `docsUrl`, `website`, `mechanismUrl`, `pricingModel`, `maturity`, `notes` | string \| null | — | |
| `claims` | `Claim[]` | — | Data-object claims carried by this integration. Defaults to `[]`. See **`claims` shape & resolution** below. |

Direction is meaningful: `sourceProduct → targetProduct`.

**`claims` shape & resolution (Stage 1.5).** A **claim** asserts that a particular
`dataObject` (e.g. RFIs, Models, Budgets) flows in a particular `direction` through
**this** integration (mechanism) row. Claims are nested under the integration they
belong to — the integration row is the anchor, so a pair of products connected by two
mechanisms that both move RFIs yields two claims (one per integration).

| Field | Type | Required | Notes |
|---|---|---|---|
| `dataObject` | string | ✅ | The data object's **slug or name/alias** (e.g. `"rfis"` or `"RFIs"`). Resolved **find-only** against AECi's seeded `data_object` vocabulary — see resolution below. |
| `direction` | `"a_to_b"` \| `"b_to_a"` \| `"both"` | ✅ | Where **A = the integration's `sourceProduct`** and **B = its `targetProduct`**. `both` = bidirectional. This is the *stored* encoding; AECi translates it to a context-relative `inbound`/`outbound` view when it renders a pair page. |
| `attestations` | `Attestation[]` | — | Who affirms the claim. Defaults to `[]`. `Attestation = { source, asserted, introducedAt?, deprecatedAt?, note? }`. |

Each `Attestation`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `source` | `"aeci"` \| `"vendor_a"` \| `"vendor_b"` | ✅ | Who attests. **In Stage 1.5, send only `"aeci"`** — `vendor_a` / `vendor_b` are accepted by the contract but produced by no current path (they're reserved for the Stage 2 vendor portal). |
| `asserted` | boolean | ✅ | `true` = this source affirms the claim; `false` = denies it. AECi seeds `true`. |
| `introducedAt`, `deprecatedAt` | ISO date string \| null | — | **Dormant in Stage 1.5** — version stamps accepted for forward-compatibility but unused. |
| `note` | string \| null | — | Optional provenance / source note. |

**`dataObject` resolution is find-only.** AECi matches the value against its seeded
`data_object` slugs, directly or via a known alias (case-insensitive). **An unmatched
term is not auto-created** — the claim is dropped and reported in `skipped[]` (§4) with
`kind: "claim"` and `ref` set to the enclosing integration's `ref`; it is never a `500`.
(This mirrors how the `usefulness` facet resolves against existing terms.)

**Withhold rule.** A claim rides with its integration and follows the same rule (§3.4):
send a claim only on an integration you are actually promoting (both endpoints resolve).
If you omit an integration because its far endpoint isn't promoted yet, omit its claims
too — they migrate when that integration does.

### 3.5 Vendor-only (or integration-only) push

To push **just an edited vendor** live — without touching its product — send only
the `vendors[]` array with the vendor's stored `supabaseId`:

```json
{
  "vendors": [
    {
      "ref": "v1",
      "supabaseId": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      "companyName": "Autodesk",
      "website": "https://www.autodesk.com",
      "headquarters": "San Francisco, CA"
    }
  ]
}
```

The vendor row is updated in place; nothing else is touched. The response has
`"product": null` and empty `taxonomy`/`integrations`. The same works for an
integration-only push (send only `integrations[]`) — but note that without a
`product` in the payload, every integration endpoint must be referenced by
`supabaseId` (you can't use `{ ref: ... }`, since there's no product to point at).

> Creating a brand-new vendor with no product is allowed (omit `supabaseId`), but
> the usual flow is: vendors are created the first time their product is promoted,
> and this vendor-only form is for **editing** an already-promoted vendor.

---

## 4. Response

`200 OK`. Persist every `id`. `operation` tells you what happened. The response
also carries an **`x-d1-bookmark`** header you can replay for read-your-writes —
see [§2.1](#21-x-d1-bookmark--read-your-writes-across-calls-optional-aeci-250).

```jsonc
{
  "vendors": [
    { "ref": "v1", "id": "8f3…", "slug": "autodesk", "operation": "created" }
  ],
  "product":   { "ref": "p1", "id": "a12…", "slug": "revit", "operation": "created" },
  "integrations": [
    { "ref": "i1", "id": "c44…", "operation": "created", "sourceSlug": "revit", "targetSlug": "navisworks" }
  ],
  "taxonomy": {
    "categories":  [ { "slug": "bim", "id": "d01…", "operation": "reused" } ],
    "audiences": [ { "slug": "architecture", "id": "e02…", "operation": "created" } ],
    "phases":      []
  },
  "skipped": [
    { "ref": "i7", "kind": "integration", "reason": "source or target product is not promoted yet" }
  ]
}
```

- `product` is `null` when you didn't send one (a vendor-only / integration-only
  push); otherwise it carries the product's `id`, `slug`, and `operation`.
- Map each returned `id` back to your record by its `ref` (or, for taxonomy, by
  `slug`) and store it.
- `operation`: `created` | `updated` for vendors/product/integrations;
  `created` | `reused` for taxonomy.
- **`sourceSlug` / `targetSlug`** on an integration result are the two products'
  slugs for that integration — AECi returns them so it can refresh both pair-page
  orientations without a lookup. They are informational (you don't need to persist
  them) and **optional**: treat them as best-effort and tolerate their absence.
- **Always inspect `skipped[]`.** An entry there means AECi could **not** link
  that integration/extension (typically the other endpoint isn't promoted yet),
  could **not** resolve a usefulness group to an existing audience/phase term
  (`kind: "usefulness"`), or could **not** resolve a claim's `dataObject` against
  the seeded `data_object` vocabulary (`kind: "claim"`, `ref` = the enclosing
  integration's `ref`). It is not an error: re-push after promoting the other
  product, after the referenced taxonomy term exists, or with a recognized
  `dataObject` value.

---

## 5. Idempotency, updates, and duplicates

- **First promote:** omit `supabaseId` everywhere → everything is created → store
  the returned IDs.
- **Later edits:** include the stored `supabaseId` on the product (and on any
  vendor/integration you also stored) → those rows are updated; the slug stays
  the same.
- Updates are a **merge by provided field**: a field you send overwrites the
  stored value; a field you omit is left unchanged; send an explicit `null` to
  clear a field. The product's **join sets** (vendors, categories, audiences,
  phases, extensions) are **replaced** to exactly match what you send — so to
  remove a category, just push the product without it.
- **Re-pushing is safe** (same `supabaseId` → same row). The one hazard is a
  **lost ID mapping**: without `supabaseId`, AECi has no way to know the row
  already exists and will create a duplicate. Persist the IDs durably.

---

## 6. Errors

Non-2xx responses use the standard AECi envelope:

```jsonc
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "field": "product.name", "details": { … } },
  "trace_id": "…" }
```

| HTTP | `code` | Cause | What to do |
|---|---|---|---|
| 400 | `MALFORMED_REQUEST` | Body isn't valid JSON | Fix the request serialization. |
| 400 | `VALIDATION_FAILED` | Schema violation — missing required field, bad enum value, duplicate `ref`, `extensionOf` using `ref`, integration endpoint `ref` that isn't the product, `builtByVendor` `ref` not in `vendors[]` | Read `error.field` / `error.details.issues`; fix and resend. |
| 401 | `UNAUTHENTICATED` | Missing or wrong bearer token | Check `REVIEW_APP_TOKEN`. |
| 409 | `SLUG_CONFLICT` | A concurrent first-time promote generated the same slug, so the create hit a `*_slug_key` unique constraint | Safe to retry; the retry re-reads existing slugs and disambiguates (`-2`, `-3`, …), so it won't re-collide. |
| 500 | `INTERNAL_ERROR` | Unexpected server fault | Safe to retry; the whole push is transactional (all-or-nothing), so a failed call wrote nothing. Report `trace_id` to the AECi team if it persists. |

Retries are safe: the push runs in a single database transaction, so a failure
leaves no partial state, and a successful retry with the same `supabaseId`s is
idempotent. A `409 SLUG_CONFLICT` is the conflict-specific, caller-resolvable
case — distinct from a `500` server fault — and resolves on retry because slug
generation re-reads the current set and disambiguates.

### 6.1 Every rejection is logged in Datadog

You don't have to keep the HTTP response body to diagnose a failed push. **Every
non-2xx promote emits a detailed Datadog log** under `source:review-app-promote`,
so the AECi operator can find and triage a rejection from Datadog alone:

- **Where:** service `aeci-api`, filter `source:review-app-promote`.
- **What each log carries:** the HTTP status (as `http_status` — Datadog reserves
  the `status` attribute for the log level), the error `code`, the `field` (when
  set), the full `details` (for a `VALIDATION_FAILED`, the entire Zod `issues[]`;
  for a `SLUG_CONFLICT`, the conflicting `target`), the request `path`/`method`,
  and the **same `trace_id`** returned in the response envelope — so a
  curator-reported `trace_id` pivots straight to its log line.
- **Level:** 4xx / 409 client errors log at `warn`; 500 server faults at `error`
  (and additionally carry the server stack).

This is promote-specific — the public read endpoints stay silent on 4xx to avoid
log noise. So "look in Datadog" is the authoritative way to see why a promote was
rejected; you don't need to plumb the response body anywhere else.

### 6.2 Partial promotes (`skipped[]`) are logged too

A `200` with a non-empty `skipped[]` (§4) is a **partial** promote — some
entities couldn't be linked (an integration/extension whose far endpoint isn't
promoted yet, a usefulness group or claim `dataObject` that didn't resolve). Those
never fail the request, so they're easy to miss. They are surfaced in Datadog as:

- a single `warn` log `aeci.api.promote.partial_skipped` (`source:review-app-promote`)
  detailing every `{ ref, kind, reason }` plus per-kind counts, and
- an `aeci.api.promote.skipped` count metric tagged by `kind`
  (`integration` / `extension` / `usefulness` / `claim`), for a monitor.

So a curator's silently-dropped push is visible in Datadog even though the API
returned `200`. (You should still inspect `skipped[]` in the response and re-push
once the blocking condition clears — the log is the operator's backstop, not a
substitute for handling `skipped[]`.)

---

## 6a. Edge-cache freshness after a promote (AECI-105)

You don't need to do anything for this — it's documented so you know what to
expect. After a successful promote commits, the AECi API invalidates the public
pages your push affected by purging their edge-cache tags (the product / vendor
detail pages, the `/products` and `/vendors` indexes, the relevant
category/audience/phase browse pages, and — when a new taxonomy term or a new
product/vendor was created — the taxonomy nav and `sitemap.xml`). So a re-pushed
**edit** (e.g. a corrected description) becomes visible publicly within one edge
round-trip rather than waiting out the cache TTL.

**Failure semantics (deliberate):** the purge is **best-effort and runs after the
write commits**. It is fired asynchronously and **never affects your response** —
a promote that succeeds returns `200` even if the subsequent purge call fails.
On the AECi side, every purge is observable in Datadog as
`aeci.cache.purge{source:promote,outcome:ok|cf_failed}`, plus a `warn` log if the
Cloudflare purge-by-tag call fails. If a purge does fail, the only consequence is that
the affected pages fall back to their normal edge TTL (≤15 min on detail pages) —
the same staleness window that existed before this behavior was added, so there is
no correctness regression. No retry or action is required from the review app.

**Known bounded gaps (tracked, out of scope here):**

- **Embedded entities** (a product page showing its vendor) aren't reverse-tagged
  yet (Phase 4). Until then, editing *only* a vendor refreshes the vendor's own
  page promptly but not the product pages that display it — those repaint on the
  next TTL expiry.
- **Integration *detail* pages** (`integration:{id}`) are not yet purged because
  integration seeding is temporarily disabled (AECI-86). When it is re-enabled, the
  integration detail pages and the two linked product pages will be added to the
  purge set.
- **Pair pages are purged now (AECI-297).** A promote that touches an integration —
  including a claims-only re-push — emits the Stage 1.5 `pair:{min}__{max}` cache tag
  and submits the canonical pair URL to IndexNow / Google, so the consolidated
  product-pair page refreshes for both orientations. The promote response's
  `sourceSlug` / `targetSlug` (§4) are populated by the ingest precisely so this
  needs no extra DB read. (The pair page itself renders once AECI-294 lands; until
  then the tag purge is a harmless no-op and the pings are best-effort.)

---

## 6b. Search-index freshness after a promote (AECI-139)

Also nothing for you to do — documented for expectations. Alongside the edge-cache
purge above, a successful promote also pushes the promoted records to Algolia
**immediately** (the product, its vendors, and any integrations), so they're
*searchable* right away rather than waiting for the 08:00 UTC (= 03:00 EST) daily sync. This closes
the "viewable on promote but not searchable until the daily sync" gap.

Same failure semantics as the purge: it's **best-effort, post-commit, and never
affects your response** — a promote returns `200` even if the Algolia push fails.
Outcomes are observable as `aeci.algolia.sync{trigger:promote,entity,outcome}` plus a
`warn` log (`aeci.api.promote.algolia_sync_failed`) on failure; a failed push is
reconciled by the next daily sync. When the Worker has no Algolia credentials
(local / PR previews) the push is a graceful no-op. Membership matches the daily sync
and the bulk reindex: promoted products/vendors are upserted; an integration is indexed
only when both its endpoint products are promoted.

---

## 6c. Home-page stats freshness after a promote (AECI-305)

Also nothing for you to do — documented for expectations. The home page's
credibility strip and stats cards ("N products · N vendors · N integrations", the
most-integrated product, etc.) read the `home.*` `stats_cache` keys, which are **not
live-aggregated** (§10). They were historically written only by the daily 07:00 UTC
compute cron — so before this change, a promote made the products/vendors/integrations
counts on `/products` update immediately (live) while the **home banner stayed frozen
at the last cron snapshot** until the next run.

Now a successful promote also recomputes those `stats_cache` keys post-commit (via
the same `runHomeStats` the cron uses) and **then** purges the home page's edge cache
(`index:home`) so it repaints with the fresh numbers within one edge round-trip.

Same failure semantics as the purge and Algolia push: **best-effort, post-commit, and
never affects your response** — a promote returns `200` even if the recompute or purge
fails. Outcomes are observable as `aeci.stats.compute{trigger:promote,outcome}` (plus
the per-key `aeci.stats.compute.key*` signals) and `aeci.cache.purge{source:promote,
outcome}`. Ordering is deliberate: the `stats_cache` recompute runs in **every**
environment (it fixes the read-endpoint data even locally); only the `index:home`
purge is gated on the Worker's CF credentials. A failed recompute self-heals at the
next daily cron.

---

## 7. Worked example

A product (**Revit**) with one vendor (**Autodesk**), two categories, and one
integration to an already-promoted product (**Navisworks**,
`id = 7c9e6679-7425-40de-944b-e07fc1f90ae7`), built by Autodesk.

### Request

```http
POST https://<staging-api-host>/api/promote
Authorization: Bearer ************
Content-Type: application/json
```

```json
{
  "vendors": [
    { "ref": "v1", "companyName": "Autodesk", "website": "https://autodesk.com", "isPrimary": true }
  ],
  "product": {
    "ref": "p1",
    "name": "Revit",
    "productRole": "application",
    "description": "BIM authoring tool for architecture, structure, and MEP.",
    "website": "https://www.autodesk.com/products/revit",
    "categories": ["BIM", "Design Authoring"],
    "audiences": ["Architecture"]
  },
  "integrations": [
    {
      "ref": "i1",
      "name": "Revit → Navisworks",
      "sourceProduct": { "ref": "p1" },
      "targetProduct": { "supabaseId": "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
      "builtByVendor": { "ref": "v1" },
      "mechanismKind": "native",
      "direction": "one-way",
      "claims": [
        {
          "dataObject": "models",
          "direction": "a_to_b",
          "attestations": [{ "source": "aeci", "asserted": true }]
        }
      ]
    }
  ]
}
```

### Response

```json
{
  "vendors": [
    { "ref": "v1", "id": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", "slug": "autodesk", "operation": "created" }
  ],
  "product": {
    "ref": "p1",
    "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "slug": "revit",
    "operation": "created"
  },
  "integrations": [
    { "ref": "i1", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "operation": "created", "sourceSlug": "revit", "targetSlug": "navisworks" }
  ],
  "taxonomy": {
    "categories": [
      { "slug": "bim", "id": "9b2…", "operation": "reused" },
      { "slug": "design-authoring", "id": "a3c…", "operation": "created" }
    ],
    "audiences": [
      { "slug": "architecture", "id": "b4d…", "operation": "reused" }
    ],
    "phases": []
  },
  "skipped": []
}
```

After this call, store on your Revit record:
`supabase_product_id = 0f8fad5b-…`; on Autodesk: `supabase_vendor_id = 1b9d6bcd-…`;
on the integration: `supabase_integration_id = 6ba7b810-…`.

### Re-pushing an edit later

The curator fixes the description. Send the same bundle, now with the stored IDs:

```json
{
  "vendors": [
    { "ref": "v1", "supabaseId": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", "companyName": "Autodesk", "website": "https://autodesk.com" }
  ],
  "product": {
    "ref": "p1",
    "supabaseId": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "name": "Revit",
    "description": "Updated description.",
    "categories": ["BIM", "Design Authoring"],
    "audiences": ["Architecture"]
  },
  "integrations": [
    {
      "ref": "i1",
      "supabaseId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "sourceProduct": { "ref": "p1" },
      "targetProduct": { "supabaseId": "7c9e6679-7425-40de-944b-e07fc1f90ae7" }
    }
  ]
}
```

Every `operation` comes back `updated`; the slugs are unchanged.

---

## 8. Quick checklist for the review-app implementer

- [ ] Store the AECi `REVIEW_APP_TOKEN` server-side; send it as `Bearer`.
- [ ] Assemble one product bundle per "Promote" click (product + its vendors + its integrations).
- [ ] For a "push just the vendor edit" action, send only `vendors[]` with the stored `supabaseId` (§3.5); expect `product: null` back.
- [ ] Use made-up `ref`s to wire the bundle together; keep them unique per request.
- [ ] Omit `supabaseId` on first promote; include stored IDs on re-push.
- [ ] Never send slugs; persist the slugs AECi returns (they're the public URLs).
- [ ] Persist every returned `id` against your record, durably.
- [ ] Only include integrations whose far endpoint is already promoted (reference it by `supabaseId`); inspect `skipped[]`.
- [ ] Nest each integration's data-object `claims[]` under it (`dataObject` slug/name, `direction` `a_to_b`/`b_to_a`/`both` relative to source→target, `attestations[]` with `source: "aeci"`); a claim rides with its integration and an unrecognized `dataObject` comes back in `skipped[]` as `kind: "claim"`.
- [ ] On 4xx, surface `error.message` / `error.field` to the curator; on 5xx, retry then escalate `trace_id`.
