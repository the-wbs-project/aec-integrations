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
| `description`, `website`, `headquarters`, `parentCompany`, `linkedinUrl`, `crunchbaseUrl`, `wikiUrl`, `sourceUrl`, `githubOrg`, `phoneNumber`, `contactEmail`, `logoUrl` | string \| null | — | Free-form. |
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
| `disciplines` | string[] | — | Discipline names or slugs. |
| `phases` | string[] | — | Project-phase names or slugs. |
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

Direction is meaningful: `sourceProduct → targetProduct`.

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

`200 OK`. Persist every `id`. `operation` tells you what happened.

```jsonc
{
  "vendors": [
    { "ref": "v1", "id": "8f3…", "slug": "autodesk", "operation": "created" }
  ],
  "product":   { "ref": "p1", "id": "a12…", "slug": "revit", "operation": "created" },
  "integrations": [
    { "ref": "i1", "id": "c44…", "operation": "created" }
  ],
  "taxonomy": {
    "categories":  [ { "slug": "bim", "id": "d01…", "operation": "reused" } ],
    "disciplines": [ { "slug": "architecture", "id": "e02…", "operation": "created" } ],
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
- **Always inspect `skipped[]`.** An entry there means AECi could **not** link
  that integration/extension (typically the other endpoint isn't promoted yet).
  It is not an error — re-push after promoting the other product.

---

## 5. Idempotency, updates, and duplicates

- **First promote:** omit `supabaseId` everywhere → everything is created → store
  the returned IDs.
- **Later edits:** include the stored `supabaseId` on the product (and on any
  vendor/integration you also stored) → those rows are updated; the slug stays
  the same.
- Updates are a **merge by provided field**: a field you send overwrites the
  stored value; a field you omit is left unchanged; send an explicit `null` to
  clear a field. The product's **join sets** (vendors, categories, disciplines,
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

---

## 6a. Edge-cache freshness after a promote (AECI-105)

You don't need to do anything for this — it's documented so you know what to
expect. After a successful promote commits, the AECi API invalidates the public
pages your push affected by purging their edge-cache tags (the product / vendor
detail pages, the `/products` and `/vendors` indexes, the relevant
category/discipline/phase browse pages, and — when a new taxonomy term or a new
product/vendor was created — the taxonomy nav and `sitemap.xml`). So a re-pushed
**edit** (e.g. a corrected description) becomes visible publicly within one edge
round-trip rather than waiting out the cache TTL.

**Failure semantics (deliberate):** the purge is **best-effort and runs after the
write commits**. It is fired asynchronously and **never affects your response** —
a promote that succeeds returns `200` even if the subsequent purge call fails.
On the AECi side, every purge is observable in Datadog as
`aeci.cache.purge{source:promote,outcome:ok|cf_failed}`, plus a `warn` log if the
internal call can't be reached. If a purge does fail, the only consequence is that
the affected pages fall back to their normal edge TTL (≤15 min on detail pages) —
the same staleness window that existed before this behavior was added, so there is
no correctness regression. No retry or action is required from the review app.

**Known bounded gaps (tracked, out of scope here):**

- **Embedded entities** (a product page showing its vendor) aren't reverse-tagged
  yet (Phase 4). Until then, editing *only* a vendor refreshes the vendor's own
  page promptly but not the product pages that display it — those repaint on the
  next TTL expiry.
- **Integrations** are not yet purged because integration seeding is temporarily
  disabled (AECI-86). When it is re-enabled, the integration detail pages and the
  two linked product pages will be added to the purge set.

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
    "disciplines": ["Architecture"]
  },
  "integrations": [
    {
      "ref": "i1",
      "name": "Revit → Navisworks",
      "sourceProduct": { "ref": "p1" },
      "targetProduct": { "supabaseId": "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
      "builtByVendor": { "ref": "v1" },
      "mechanismKind": "native",
      "direction": "one-way"
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
    { "ref": "i1", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "operation": "created" }
  ],
  "taxonomy": {
    "categories": [
      { "slug": "bim", "id": "9b2…", "operation": "reused" },
      { "slug": "design-authoring", "id": "a3c…", "operation": "created" }
    ],
    "disciplines": [
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
    "disciplines": ["Architecture"]
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
- [ ] On 4xx, surface `error.message` / `error.field` to the curator; on 5xx, retry then escalate `trace_id`.
