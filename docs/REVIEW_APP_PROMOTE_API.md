# Review App → AECi Promotion API

**Audience:** whoever builds the "Promote" action in the **review application**.
**Status:** ready to integrate. Live in the main AECi API (`apps/api`).
**Asynchronous since AECI-563** — `POST /api/promote` returns `202 { jobId }` and the
IDs are collected from `GET /api/promote/jobs/{jobId}`. If you implemented against the
old synchronous `200`, **start at §1.1**.

This document is the contract for pushing a promoted product from the review app
into the public AECi database (Supabase). Read it end-to-end before implementing.

---

## 1. What changed and why

Previously, promotion was a **pull**: a CLI script on the AECi side read every
Airtable record flagged `promotion_status = 'promoted'` and copied it into
Supabase. That script is now **deprecated**.

Promotion is a **push you initiate**. When a curator clicks **Promote** in the
review app, the review app sends that product — plus its vendors, taxonomy, and
integrations — to `POST /api/promote`. The AECi API inserts (or updates) the rows
and gives back the database IDs it created. The review app stores those IDs and,
whenever the curator edits the product later, **re-pushes** the same bundle to
update the live records.

### 1.1 Breaking change (AECI-563): promotion is now **asynchronous**

`POST /api/promote` **no longer returns the IDs.** It validates your bundle,
starts a job, and returns **`202 { jobId }`** in about a second. You then **poll**
`GET /api/promote/jobs/{jobId}` until the job is `complete` and **collect** the ID
map from its `result`.

```
Curator clicks "Promote"
        │
        ├─ stamp promote_job_id on the Airtable row   ◀── do this FIRST
        ▼
POST /api/promote  ──────────────▶  AECi API   ──▶  202 { jobId }   (~1s)
                                        │
                                        │  Workflow: plan → atomic commit → cache/index refresh
                                        ▼
GET /api/promote/jobs/{jobId}  ──────▶  { status: "complete", result: { vendors[], product, … } }
        │
        ▼
   write the IDs back to Airtable, then clear promote_job_id
```

**Why this changed.** The old synchronous call coupled the durability of a
committed write to the survival of an HTTP connection, and they came apart: your
30-second client abort fired, AECi committed anyway, the product went fully live —
and the response carrying its IDs was lost. Because AECi upserts **only** by the
`supabaseId` you send (there is no `external_id` column), a lost response was
**unrecoverable**, and re-promoting such a product minted duplicate public rows.
Now the commit does not depend on you at all: kill your client at any moment and
the promote still happens exactly once, with the IDs fetchable by job ID for 90
days. See `docs/adr/0021-async-promote-ingest-via-workflows.md`.

### Your responsibilities

1. **Supply a `jobId` and stamp it before you push.** Write `promote_job_id` onto
   the Airtable row *before* calling `POST /api/promote`. It is your idempotency
   key: replaying a kick-off with the same `jobId` attaches to the same job and can
   never commit twice. A row with a pending marker must never get a fresh push
   until its job has been collected.
2. **Poll, then collect.** The job is not done when you get the `202`. Poll until
   `complete` and persist the IDs from `result`; only then clear the marker.
3. **Persist the returned IDs.** For each entity you push, store the `id` AECi
   returns (e.g. `supabase_vendor_id`, `supabase_product_id`,
   `supabase_integration_id`). This mapping is **the only link** between your
   records and the AECi rows — AECi does **not** store your Airtable/record IDs.
   The `supabase_claim_id` a claim comes back with is the exception: it is
   **informational only**. Claims are replaced wholesale on every promote (see
   "`claims` shape & resolution" in §3), so the id you store is invalidated by your
   next push. Never key anything off it.
4. **Send the stored ID back on edits.** Presence of the ID is what makes a push
   an update instead of a new insert. **If you lose the mapping, a re-push
   creates duplicates** — persist it durably. An ID you send that no longer
   resolves — the row was retracted, pruned, or deleted on the AECi side — is
   **not** an error: AECi falls back to **creating** the row and the response
   comes back `operation: "created"` with a **new** id. Persist that new id; it
   replaces your dead pointer. (Before AECI-568 this silently updated nothing and
   returned an empty `slug`, which the write-back then wrote over the real one.)
5. **Do not send slugs.** AECi owns URL slugs; it generates them on first
   promote and keeps them stable. The response tells you the slug that became the
   public URL.

---

## 2. Endpoints

```
POST {API_BASE}/api/promote                    → 202 { jobId, status: "queued" }
POST {API_BASE}/api/promote/connector-catalog  → 202 { jobId, status: "queued" }
GET  {API_BASE}/api/promote/jobs/{jobId}       → 200 { jobId, status, result?, error? }

Authorization: Bearer {REVIEW_APP_TOKEN}       (all three)
Content-Type: application/json                 (POST)
```

**Two kinds of push, one job protocol.** `POST /api/promote` sends a **product bundle**
(§3); `POST /api/promote/connector-catalog` sends one **page of one connector catalogue**
(§3a, AECI-714). They share the kick-off shape, the `jobId` idempotency, the poll endpoint
and the error model — the poll result is told apart by a `kind` field, which only the
connector arm carries. Everything from §2.1 to §2.2 applies to both.

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

### 2.1 The kick-off / poll / collect protocol (AECI-563)

**Kick-off.** `POST /api/promote` with your bundle plus a top-level `jobId`:

```jsonc
{
  "jobId": "recAbC123XyZ-1754963400",   // your idempotency key — see below
  "vendors":      [ /* … */ ],
  "product":      { /* … */ },
  "integrations": [ /* … */ ]
}
```

Response — `202 Accepted`, plus a `Location` header pointing at the poll URL:

```json
{ "jobId": "recAbC123XyZ-1754963400", "status": "queued" }
```

**`jobId` rules.** 8–100 characters of `[A-Za-z0-9_-]` (it becomes the job's
internal instance ID, which the platform caps at 100 characters). Any scheme you
like as long as it is **unique per promote attempt** — an Airtable record ID plus a
timestamp works well. It is **optional**: omit it and AECi generates one, but then
you get no replay protection, so supply it.

**Replaying a kick-off is safe and free.** POST the same `jobId` again — after a
network blip, a retry, a restarted worker — and you get the same `202 { jobId }`
back. It attaches to the existing job; it does **not** start a second one and
cannot commit twice. This is what replaces a duplicate-safety key on the AECi side,
and it is why the marker must be written *before* the push.

That holds at two layers, so you can retry as hard as you like. Even if AECi's own
job engine internally replays a commit that already landed, a ledger keyed on your
`jobId` makes the second attempt roll back and return the original IDs. **One
`jobId` commits at most once, ever** — no matter how many times it is replayed, and
no matter how much later.

**Poll.** `GET /api/promote/jobs/{jobId}`:

```jsonc
{ "jobId": "recAbC123XyZ-1754963400", "status": "running" }
```

`status` is one of **`queued`** (accepted, not started), **`running`** (in flight),
**`complete`** (committed — `result` carries the ID map), **`errored`** (failed —
`error` carries the code). Poll every 1–2 seconds; a typical promote completes in a
few seconds, and a very heavy bundle can take a minute or more. There is no
`Retry-After`; nothing rate-limits this endpoint, but do back off rather than
hammering it.

**Collect.** On `complete`, write the IDs from `result` back to Airtable, **then**
clear `promote_job_id`. Collect must be idempotent and resumable: if you crash
half-way, re-polling the same job returns the identical `result`, so re-running the
write-back converges. Clearing the marker last is what guarantees an abandoned run
is still collectable later (by you or by the reconcile sweep).

**How long IDs stay fetchable.** For the job's retention window (30 days) plus a
90-day mirror of the committed result. After that a poll returns `404 NOT_FOUND`.
This is long enough that you should never lose a promote's IDs — but it is not a
substitute for persisting them.

### 2.2 `x-d1-bookmark` — read-your-writes (no longer on the promote path)

AECi serves reads from D1 read replicas, and a read issued *immediately* after a
write could momentarily hit a replica that hasn't caught up. AECi threads a D1
session bookmark internally to close that window for its own post-commit work
(search indexing, cached counts).

**Nothing for you to do here.** Because the promote now commits off-request, the
`POST /api/promote` response no longer carries an `x-d1-bookmark` header and there
is nothing to replay. Promotes remain durable and strongly consistent (writes go to
the primary). If a future review-app feature needs read-your-writes against an AECi
**read** endpoint, that endpoint still honours the `x-d1-bookmark` request header —
ask the AECi team then.

---

## 3. Request body

The usual promote = **one product** plus its dependencies. Top-level shape:

```jsonc
{
  "jobId":        "recAbC123XyZ-1754963400",  // idempotency key — §2.1
  "vendors":      [ /* vendors of this product (0+; usually 1) */ ],
  "product":      { /* the product being promoted — OPTIONAL (see below) */ },
  "integrations": [ /* integrations incident to this product (0+) */ ]
}
```

**`product` is optional.** You can push **just a vendor** (or just integrations)
without a product — see §3.5. The only rule is that the payload must contain at
least one of `vendors`, `product`, or `integrations`; a fully empty body is
rejected `400` (a body carrying only a `jobId` counts as empty).

**Size.** Real bundles are kilobytes; there is no practical ceiling you will hit.
For completeness: a request body over 8 MiB is rejected `413 PAYLOAD_TOO_LARGE`,
and bundles above ~512 KiB are staged internally rather than inlined — invisible to
you either way.

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
| `supabaseId` | uuid \| null | — | Present *and still resolvable* → update that vendor; absent, **or pointing at a row that no longer exists** → create (see responsibility 4). |
| `companyName` | string | ✅ | |
| `isPrimary` | boolean | — | Defaults to `true` for the first vendor, `false` otherwise. |
| `description`, `website`, `headquarters`, `parentCompany`, `linkedinUrl`, `xUrl`, `facebookUrl`, `instagramUrl`, `youtubeUrl`, `crunchbaseUrl`, `wikiUrl`, `sourceUrl`, `githubOrg`, `phoneNumber`, `contactEmail`, `logoUrl` | string \| null | — | Free-form. `xUrl` / `facebookUrl` / `instagramUrl` / `youtubeUrl` are full canonical URLs persisted verbatim to `vendors.{x,facebook,instagram,youtube}_url` and rendered as icons in the public vendor hero; `githubOrg` is persisted as a bare handle but is not surfaced in the public vendor contract. |
| `foundedYear` | int \| null | — | |
| `publicPrivate` | `"public"` \| `"private"` \| null | — | |
| `verified` | boolean | — | **Accepted and ignored (AECI-520).** `vendors.verified` is the paid vendor-portal entitlement bit: it is set when AECi approves a vendor claim and cleared only by a deliberate entitlement action, so a routine push must not move it (previously a push carrying `verified: false` could silently un-verify a paying vendor). Still accepted so your existing build keeps validating; send it or don't, the server drops it. A newly created vendor is always `verified: false`. |
| `lastReviewedAt` | ISO-8601 string \| null | — | **The review signal (AECI-616).** Send it ONLY when a human actually re-checked this record; it becomes the date in the public "Reviewed <date>." maintenance marker. **Omitting it leaves the stored value untouched** — that is the point, so a routine re-push never re-advertises the record as freshly reviewed. `null` clears it. Rejected with a 400 if unparseable (stricter than the other free-form fields here, because a garbage value would render as *no date* and be indistinguishable from "never reviewed"). See §3.6. |

### 3.3 `product` (optional, singular)

Omit it entirely for a vendor-only / integration-only push (§3.5). When present:

| Field | Type | Required | Notes |
|---|---|---|---|
| `ref` | string | ✅ | Unique local label; integrations reference it as their endpoint. |
| `supabaseId` | uuid \| null | — | Present *and still resolvable* → update; absent, **or pointing at a row that no longer exists** → create (see responsibility 4). |
| `name` | string | ✅ | |
| `productRole` | `"application"` \| `"connector"` \| `"hybrid"` | — | Defaults to `"application"`. |
| `categories` | string[] | — | Category **names or slugs**. Find-or-created by slug. |
| `audiences` | string[] | — | Audience names or slugs. |
| `phases` | string[] | — | Project-phase names or slugs. |
| `trades` | string[] | — | Trade names, slugs, **or aliases**. **Resolve-only — never find-or-created.** See **`trades` resolution** below. |
| `usefulness` | `{ audiences: UsefulnessGroup[]; phases: UsefulnessGroup[] }` \| null | — | Per-audience / per-phase narrative value. `UsefulnessGroup = { slug \| name, points: string[] }` (≥ 1 point). See **`usefulness` resolution** below. |
| `extensionOf` | `{ supabaseId }[]` | — | Host products this product extends. **Must use `supabaseId`** (hosts are promoted separately). |
| `lastReviewedAt` | ISO-8601 string \| null | — | **The review signal (AECI-616).** Send ONLY when a human actually re-checked this record. **Omitting it leaves the stored value untouched.** See §3.6. |
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

**`trades` resolution (AECI-542).** The `trade` facet is a **governed closed vocabulary** (`docs/TRADES_VOCABULARY.md`), so — unlike `categories` / `audiences` / `phases`, which are find-or-created by canonical slug — an incoming trade is **resolve-only**, matching the `usefulness` and `dataObject` behaviour. AECi matches each value case-insensitively against the seeded `taxonomy_trades` rows by **`slug`, then `name`, then `aliases`** (so "HVAC", "Mechanical", and `hvac-mechanical` all land on the same term). A value matching nothing is **dropped from the stored set and reported in `skipped[]`** with `kind: "trade"` and `ref` set to the product's `ref` — it is **not** an error and **not** auto-created. This is deliberate: a typo minting `paving-contractors` alongside `paving-asphalt` would silently split a trade page's products across two permanent URLs. To add a term, change the vocabulary doc and re-seed (`TRADES_VOCABULARY.md` §3) — you cannot mint one from Airtable.

Send `trades` only where the product has **trade-specific value** — trade-specific features, cost databases, templates, takeoff logic, or integrations. **Horizontal platforms (Procore, Autodesk Build, Bluebeam) get an empty array.** Most products carry no trades; that is the intended outcome, not missing data (`TRADES_VOCABULARY.md` §1.1). Any `productRole` may carry trades, connectors included. Omit the key entirely (or send `[]`) when there are none — note that, like the other join sets, **sending the product replaces its full trade set** (§5).

### 3.4 `integrations[]`

Send only integrations where the product being promoted is **one of the two
endpoints**. The other endpoint must already be promoted (reference it by
`supabaseId`). If the other endpoint isn't promoted yet, **omit the integration**
— it will be created when that product is promoted.

| Field | Type | Required | Notes |
|---|---|---|---|
| `ref` | string | ✅ | Unique local label. |
| `supabaseId` | uuid \| null | — | Present *and still resolvable* → update; absent, **or pointing at a row that no longer exists** → create (see responsibility 4). |
| `name` | string \| null | — | |
| `sourceProduct` | `{ ref }` \| `{ supabaseId }` | ✅ | One endpoint. `{ ref: <product.ref> }` for the product in this bundle. |
| `targetProduct` | `{ ref }` \| `{ supabaseId }` | ✅ | The other endpoint. |
| `builtByVendor` | `{ ref }` \| `{ supabaseId }` \| null | — | `ref` must name a vendor in `vendors[]`; otherwise use `supabaseId`. |
| `poweredByProduct` | `{ ref }` \| `{ supabaseId }` \| null | — | |
| `mechanismKind` | `"native"` \| `"iPaaS"` \| `"marketplace-app"` \| `"api"` \| `"webhook"` \| `"partner"` \| null | — | |
| `direction` | `"one-way"` \| `"bidirectional"` \| null | — | |
| `mechanismName`, `description`, `listingUrl`, `docsUrl`, `website`, `mechanismUrl`, `pricingModel`, `maturity`, `notes` | string \| null | — | |
| `claims` | `Claim[]` | — | Data-object claims carried by this integration. Defaults to `[]`. See **`claims` shape & resolution** below. |
| `lastReviewedAt` | ISO-8601 string \| null | — | **The review signal (AECI-616).** Send ONLY when a human actually re-checked this record. **Omitting it leaves the stored value untouched.** See §3.6. |

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
| `source` | `"aeci"` \| `"vendor_a"` \| `"vendor_b"` | ✅ | Who attests. **Send only `"aeci"`.** The enum still carries `vendor_a` / `vendor_b` because the column does, but those slots are now live and are derived from product ownership in the vendor portal — they are not settable from a payload. Since AECI-604 a non-`aeci` source is **dropped and reported in `skipped[]`** (`kind: "claim"`) rather than written. |
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

**`claims[]` replaces AECi curation only, not the whole claim set** — vendors author
claims and attestations of their own, and those survive a re-push. Read §5.2 before
relying on omission to remove a claim.

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

### 3.6 `lastReviewedAt` — the review signal (AECI-616)

Accepted on `vendors[]`, `product`, and `integrations[]`. It is the only way the
public **maintenance marker** gets a date:

> Maintained by AEC Integrations. **Reviewed March 4, 2026.**

**The contract is that absence means "untouched."** Omit the field and the stored
`last_reviewed_at` keeps whatever it had; send an ISO-8601 timestamp and it advances;
send `null` and it clears. Nothing else in the promote path writes it.

**Why it isn't derived server-side.** The obvious implementation — stamp `now()` on
every promote — is exactly what this design refuses. AECi's own `updated_at` already
does that, and it is useless as a freshness signal precisely because of it: promote
re-asserts `promotion_status='promoted'` on every re-push, so production has 60
products sharing one `updated_at` day and 40 sharing another. A date that refreshes
itself without anyone re-checking the record is worse than no date, because readers
believe it.

**So this field carries an obligation.** Send it when a curator genuinely re-verified
the record — not on every sync, and not as a default in your push builder. If it ends
up stamped on every push it becomes `updated_at` with extra steps, and the marker goes
back to lying. There is no server-side check that can catch that; the discipline lives
on your side.

Nothing is backfilled: every record promoted before this field existed reads
`last_reviewed_at: null` and renders bare attribution with no date, until a real review
supplies one.

**`maintainedBy` is not accepted.** The `'vendor'` value is set only by a vendor's own
attestation in the vendor portal, and cleared when they retract it. If the payload
carried it, a routine push would silently take a record back off a vendor's name — the
same failure `verified` had before AECI-520 (§4a).

---

## 3a. Connector-catalogue pages (`POST /api/promote/connector-catalog`, AECI-714)

A separate body shape on a separate path, sharing everything else. It mirrors the review
app's connector-lane model into AECi — catalogues, their crawled listings ("stubs"),
stub↔product mappings, and the pairs a vendor publishes a page for.

**AECi holds the FULL mirror, including the misses.** Send every stub, not just the mapped
ones: the question the lane answers is *"is this new listing one of ours?"*, and the ~3,342
undecided stubs are the triage queue the AECi connector admin screen works from. It is also
what makes the eventual per-iPaaS management handover a lane freeze rather than a data
migration.

### One page = one complete job

A catalogue is far too large for one request, so it arrives paged, and **each page is an
independent promote job**: its own `jobId`, its own `202`, its own poll, its own atomic
commit. There is deliberately **no atomicity across pages** — one job ledger protects one
commit. What makes that safe is that every write is an upsert keyed on *your* record id, so:

- re-sending a page is harmless, and a page re-sent with nothing changed writes **nothing**;
- a half-finished catalogue sync is always safe to simply re-run from page one;
- **order does not matter**, though sending stub pages before pair/mapping pages avoids skips.

Ceiling: **500 rows per page**, counted across `surfaces` + `stubs` + `mappings` + `pairs` +
`deleted`. Over that is a `400`.

### Body

```jsonc
{
  "jobId": "mindcloud-page-3-1754963400",
  "catalog": { /* the catalogue header — send it on EVERY page */ },
  "page":    { "index": 3, "of": 8 },
  "surfaces":[ /* 0+ */ ], "stubs": [ /* 0+ */ ],
  "mappings":[ /* 0+ */ ], "pairs": [ /* 0+ */ ],
  "deleted": { "surfaces": [], "mappings": [] }   // optional; explicit hard deletes
}
```

**Ids are yours.** Every `id` below is *your* record id, and it becomes the AECi primary key
verbatim. That is why this arm returns no ID map: you already know every id you sent, and
there is nothing to persist or to strand.

#### `catalog` (required, on every page)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Your catalogue record id. |
| `connectorProductId` | uuid | no | The connector platform's **AECi product id**. Omit it if the platform isn't promoted — the whole page is then reported in `skipped[]` as `kind: "connector-catalog"`, which is **not an error**. |
| `connectorAuthorship` | enum | no | `platform` \| `partner` \| `mixed` — who actually *builds* the connectors. |
| `notes` | string | no | |

`managedBy` is **not accepted** (AECI-720). Who authors a catalogue is held *and* enforced
AECi-side — the review app is the component being decommissioned, so the surviving system owns
who-controls-what. A catalogue starts `review` by column default, and only an AECi operator moves
it. Sending the field is harmless (unknown keys are stripped) but it will not do anything, and
you cannot use it to un-freeze a catalogue that has been handed over. See §3a's rejection below.

#### `surfaces[]` — one per index URL you crawl

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `surfaceRole` | string | yes | Free-form; `apps` / `pairs` / `sources` / `destinations` / `all` today. Unique per catalogue. |
| `indexKind` | string | no | Free-form; `sitemap` / `toc` / `json_api` / `html` today. |
| `indexUrl` | string | no | |
| `lastIngestedAt` | ISO-8601 | no | The **"as of" date** AECi renders beside every reachability claim. Keep it current — it is the freshness signal the connector lane is judged on. |
| `notes` | string | no | |

#### `stubs[]` — every listing, mapped or not

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `slug` | string | yes | Unique per catalogue. |
| `label`, `url`, `directionRole` | string | no | `directionRole` is free-form. |
| `actionCount` | integer | no | |
| `actions` | json | no | **Omit it when you have never fetched the inventory.** Null means *never fetched*, not *no actions*; AECi will not publish "this connector does nothing" from an absence. |
| `actionsHash`, `actionsFetchedAt` | string | no | |
| `previousLabels` | string[] | no | |
| `meta` | json | no | |
| `firstSeenAt`, `lastSeenAt` | ISO-8601 | **yes** | No defaults on this side, deliberately — a default would mask a sender bug as a plausible timestamp. |
| `removedAt` | ISO-8601 | no | The tombstone. Stamp it only off a **complete** ingest run; a truncated fetch is indistinguishable from a vendor deleting half their catalogue. |

#### `mappings[]` — the stub↔product assertions

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `stubId` | string | yes | Yours. If the stub is neither on this page nor already stored, the mapping is skipped as `kind: "connector-stub"` — re-send it after the stub page. |
| `productId` | uuid | conditional | The **AECi product id**. Required for `mapped` / `ruled_out`; **forbidden** for the other three. If you hold no AECi id yet, omit it: the row is skipped as `kind: "connector-mapping"`, not rejected. |
| `status` | enum | yes | `mapped` \| `ruled_out` \| `out_of_scope` \| `no_record` \| `ambiguous_parked`. There is **no `pending`** — absence of a row is pending. |
| `confidence` | enum | no | `low` \| `medium` \| `high`. |
| `evidenceUrl` | string | no | Per row, not per stub. |
| `decidedBy` | string | no | **The publication gate.** A row decided by your automatic pass (`auto-name-match`) computes but never publishes; only a named human's decision reaches a public surface. |
| `decidedAt`, `checkedAt` | ISO-8601 | no | |
| `notes` | string | no | |

`catalogId` is **not accepted** — AECi derives it from the page's own catalogue, so a
malformed payload cannot break the invariant the triage counts depend on.

Two families, and they may not cross: `mapped` / `ruled_out` name a product and several may
sit on one stub; the other three assert there is none to name and **at most one** may sit on
a stub. Both rules are enforced at the kick-off, so a violation is a fast `400` rather than a
rolled-back page.

#### `pairs[]` — the pairs the vendor publishes a page for

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `stubAId`, `stubBId` | string | yes | **Canonically ordered: `stubAId < stubBId`.** Vendors publish both directions as separate pages; without the ordering every pair arrives twice. A reversed pair is a `400`. |
| `urlAToB`, `urlBToA` | string | no | Either may be absent. |
| `surface` | enum | no | `curated` \| `generated` \| `unknown` (default). **This is the field that decides publication** — AECi publishes the curated set and refuses to publish an auto-generated cross-product. |
| `classifiedAt` | ISO-8601 | no | |
| `firstSeenAt`, `lastSeenAt` | ISO-8601 | **yes** | |
| `removedAt` | ISO-8601 | no | |

#### `deleted` (optional) — the only hard deletes

`{ "surfaces": [id, …], "mappings": [id, …] }`. Necessary because in a paged mirror **absence
cannot mean deletion** — a row missing from this page is a row on another page. Only these
two entities are hard-deleted; stubs and pairs retire via the `removedAt` tombstone.

### Response

The poll returns a result carrying `kind: "connector"` — the discriminant that tells it from a
product bundle's ID map:

```jsonc
{
  "kind": "connector",
  "catalogId": "rec76C362381D6CDF",
  "page": { "index": 3, "of": 8 },
  "counts": {
    "catalogs": { "created": 0, "updated": 0, "unchanged": 1, "deleted": 0, "skipped": 0 },
    "surfaces": { "created": 0, "updated": 0, "unchanged": 2, "deleted": 0, "skipped": 0 },
    "stubs":    { "created": 412, "updated": 6, "unchanged": 82, "deleted": 0, "skipped": 0 },
    "mappings": { "created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 3 },
    "pairs":    { "created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0 }
  },
  "skipped": [
    { "ref": "recMapAdp0000001", "kind": "connector-mapping",
      "reason": "the mapped product is not promoted yet (send the mapping again once it is)" }
  ]
}
```

`unchanged` is the number worth watching: a steady-state re-sync should report it for
everything, and that is the proof the page was a true no-op.

**Always inspect `skipped[]`.** On a full-mirror sync a `complete` job that dropped 200
mappings looks identical to one that dropped none. The four connector kinds are
`connector-catalog`, `connector-stub`, `connector-mapping` and `connector-pair`; all four mean
*"this could not be resolved yet"*, never *"policy said no"*, and all four are re-sendable.

### One refusal that is NOT a skip: a vendor-managed catalogue (AECI-720)

Per iPaaS, a catalogue can be handed over to its vendor. When an AECi operator flips
`managed_by` to `vendor`, **the review lane freezes for that catalogue and no other**: every page
you send for it fails the job with `CATALOG_VENDOR_MANAGED` (a `409`-class code) and writes
nothing at all — no rows, no ledger row, no audit row.

That is deliberately an **error and not a `skipped[]` entry**, because the four skip kinds above
all promise *"could not be resolved yet"* and *"re-sendable"*, and this is neither. **Re-sending
will not help, ever.** If a catalogue genuinely needs to return to review authorship, an AECi
operator flips it back — ask, don't retry.

Three properties worth knowing:

- **It is checked before the unpromoted-connector skip.** A vendor-managed catalogue whose
  platform is also unpromoted still rejects rather than reporting a re-sendable skip. A policy
  refusal must not look like a resolution problem.
- **The rejection is per job, and every page behaves identically.** One job is one page is one
  catalogue, and the check does not depend on page contents.
- **A mid-sync flip does not roll anything back.** Pages committed before the flip stay
  committed; pages after it reject. AECi's copy is current either way — that is the whole reason
  handover is a lane freeze rather than a data migration.

## 4. Response

The kick-off returns `202 { jobId, status: "queued" }` (§2.1). **The ID map below is
what `GET /api/promote/jobs/{jobId}` returns in `result` once `status` is
`"complete"`.** Persist every `id`; `operation` tells you what happened.

```jsonc
{
  "jobId": "recAbC123XyZ-1754963400",
  "status": "complete",
  "result": {
    // ↓ exactly the shape the old synchronous 200 returned
    "vendors": [ /* … */ ],
    "product": { /* … */ },
    "integrations": [ /* … */ ],
    "taxonomy": { /* … */ },
    "skipped": [ /* … */ ],
    "preserved": [ /* … */ ]
  }
}
```

The `result` object in full:

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
    "phases":      [],
    "trades":      [ { "slug": "electrical", "id": "f03…", "operation": "reused" } ]
  },
  "skipped": [
    { "ref": "i7", "kind": "integration", "reason": "source or target product is not promoted yet" }
  ],
  "preserved": [
    { "ref": "i1", "kind": "claim", "reason": "vendor-origin claim left untouched (not AECi-curated)", "count": 2 }
  ]
}
```

- `product` is `null` when you didn't send one (a vendor-only / integration-only
  push) **or when the product was blocked** because a claimed vendor owns it
  (§4a); otherwise it carries the product's `id`, `slug`, and `operation`. Tell
  the two apart by looking for a `skipped[]` entry with `kind: "product"` and
  your product's `ref`.
- Map each returned `id` back to your record by its `ref` (or, for taxonomy, by
  `slug`) and store it.
- `operation`: `created` | `updated` for vendors/product/integrations;
  `created` | `reused` for taxonomy. **`taxonomy.trades[]` is always `reused`** —
  the vocabulary is closed, so promote can only ever match an existing term.
  A `created` on an entity you sent a `supabaseId` for means that id no longer
  resolved and AECi created a replacement row (responsibility 4) — the `id` in the
  result is the new one, and it is what you must store.
- **`sourceSlug` / `targetSlug`** on an integration result are the two products'
  slugs for that integration — AECi returns them so it can refresh both pair-page
  orientations without a lookup. They are informational (you don't need to persist
  them) and **optional**: treat them as best-effort and tolerate their absence.
- **Always inspect `skipped[]`.** An entry there means AECi could **not** link
  that integration/extension (typically the other endpoint isn't promoted yet),
  could **not** resolve a usefulness group to an existing audience/phase term
  (`kind: "usefulness"`), could **not** resolve a claim's `dataObject` against
  the seeded `data_object` vocabulary (`kind: "claim"`, `ref` = the enclosing
  integration's `ref`), or could **not** resolve a trade against the seeded
  `trade` vocabulary (`kind: "trade"`, `ref` = the product's `ref`). It is not an
  error: re-push after promoting the other product, after the referenced taxonomy
  term exists, or with a recognized `dataObject` / trade value.
- Two `skipped[]` kinds mean something different from all the others — see §4a.
- **`preserved[]` is the opposite signal and needs no action from you.** It lists
  claims and attestations that were **not** in your payload and survived anyway,
  because a vendor owns them (§5.2). It is a receipt, not a problem: an entry means
  coexistence worked. Entries are `{ ref, kind: "claim" | "attestation", reason,
  count }`, aggregated per reason, with `ref` set to the enclosing integration's
  `ref`. For the ordinary promote of an unclaimed product it is always `[]`.
  Log it if you want operator visibility; never treat it as an error.

---

## 4a. Claimed vendors are not writable from the review app (AECI-520)

Stage 2 gives vendors their own portal. Once AECi grants a vendor a portal seat,
that vendor is **claimed**, and from then on it edits its own content directly —
description, links, logo, taxonomy. Those are the same columns a promote writes,
so if the review app kept pushing them it would silently revert the vendor's
work every time. AECi therefore refuses those specific writes.

What that looks like in a response:

| Situation | Result |
|---|---|
| You update a **claimed vendor** | The vendor is **absent** from `vendors[]`; `skipped[]` gains `{ ref, kind: "vendor", reason: "vendor is claimed by a vendor admin; …" }`. Its columns are unchanged. |
| You update an **existing product a claimed vendor owns** — or a product this payload would attach to one | `product` is `null`; `skipped[]` gains `{ ref, kind: "product", reason: "product belongs to a claimed vendor; …" }`. Nothing about the product changes, including its vendor/taxonomy/extension links. |
| An integration in that same payload has an endpoint on the blocked product | Skipped with `kind: "integration"` and a reason mentioning the claimed vendor. |
| You **create** a new vendor or product | Never blocked — nothing vendor-owned exists yet. |
| Anything else in the same payload | Promotes normally. |

This is **not an error** — the response is still `200`, and re-pushing will not
help. If the content genuinely needs to change, the change belongs with the
vendor (through their portal) or with an AECi admin, not with a re-push.

The taxonomy facets on a blocked product are not resolved at all, so
`taxonomy` comes back empty for that push and no new term is created.

**Two scope notes, so the behaviour isn't surprising:**

- The block is **wholesale**, not column-by-column. A claimed vendor's row and
  its products are skipped entirely, so AECi's own curation fields on those rows
  (`name`, `promotionStatus`, `researchStatus`, `priorityTier`, `adminNotes`, …)
  also stop updating through promote. That is the cost of the simple rule; raise
  it with AECi if a claimed vendor's product needs a curation change.
- The integration cascade covers **the product in this payload**. An integration
  whose *far* endpoint happens to be a claimed vendor's product still writes,
  because integrations are AECi-curated and are not vendor-editable — no
  vendor-owned content is at stake there.

A vendor is **claimed** only while it has at least one **active** portal seat. If
AECi bans a vendor's only admin, the vendor is no longer claimed and promote can
write to it again — that is deliberate, so moderation hands control back to AECi
rather than freezing the record.

---

## 5. Idempotency, updates, and duplicates

There are **two independent keys**, and mixing them up is the one way to still
create duplicates:

| Key | Scope | What it protects |
|---|---|---|
| `jobId` (§2.1) | one promote *attempt* | Replaying a kick-off — or an internal engine replay — can't start a second job or commit twice, **ever**, for that id. |
| `supabaseId` (§3.1) | one *row*, forever | Whether a push creates a new row or updates the existing one. |
| the record `id` (§3a) | one connector-lane *row*, forever | On the connector arm only: your own record id **is** the AECi primary key, so every write is an upsert and re-sending a page is a no-op. This is why the connector arm needs no ID map and returns none. |

The `jobId` guarantee does not expire with the job's 30-day retention: AECi keeps a
ledger row per committed job id, so re-pushing an old id returns its original IDs
rather than committing again.

A **new** `jobId` with **no** `supabaseId` is always a create — that is correct, and
it is why the marker-before-push / collect-before-next-push ordering is load-bearing
on your side. `jobId` protects a retry; only `supabaseId` protects against pushing
the same product twice as two different attempts.

- **First promote:** omit `supabaseId` everywhere → everything is created → store
  the returned IDs.
- **Later edits:** include the stored `supabaseId` on the product (and on any
  vendor/integration you also stored) → those rows are updated; the slug stays
  the same.
- Updates are a **merge by provided field**: a field you send overwrites the
  stored value; a field you omit is left unchanged; send an explicit `null` to
  clear a field. The product's **join sets** (vendors, categories, audiences,
  phases, trades, extensions) are **replaced** to exactly match what you send — so to
  remove a category, just push the product without it.
- **Re-pushing is safe** (same `supabaseId` → same row). The one hazard is a
  **lost ID mapping**: without `supabaseId`, AECi has no way to know the row
  already exists and will create a duplicate. Persist the IDs durably.
- **`claims[]` is the one exception to "replaced to exactly match what you send"** —
  it replaces **AECi curation only**. See §5.2.

### 5.1 Promote has NO delete semantics — deleting in Airtable does not retract

This is the sharpest edge in the whole contract, and it is not a bug you can retry
past. **A promote can create and update rows. It can never delete one.**

The only exception is *within* an entity you push: a product's join sets (categories,
trades, …) are replaced wholesale to match your payload, and an integration's
`claims[]` replaces **AECi's own curation** on it (§5.2 — vendor-authored claims and
attestations survive). Entities themselves — products, vendors, integrations — are
never removed.

So if a curator **deletes an `Integrations` record from the base**, or simply stops
sending it, the live D1 row does not go anywhere. It stays on the public pair page and
on both endpoint product pages indefinitely, and — because the only link between the
two systems is the `supabase_integration_id` Airtable holds — deleting the record also
destroys the one pointer that could ever have found it again. The row becomes a
**stray**: unreachable, un-updatable, and un-deletable by any future promote. A
re-promote of the same product mints a *second* copy alongside it.

Note that this is independent of whether the write-back ever landed. Even a perfectly
collected promote leaves a stray if the record is later deleted.

**What a curator must do to retract an integration:**

1. Delete the Airtable record (and its `integration_claims` rows) as usual, and record
   *why* in the product's `tool_integration_check_notes` — that note is what a future
   auditor uses to tell a deliberate retraction from an accident.
2. Follow up with an explicit delete of the live D1 row through the datatool's
   `POST /api/prune-integrations`. It will report `orphansWithoutATwin` (and usually
   `claimsUniqueToOrphans`) as blocked — correctly, since the row is the only copy of
   that mechanism — so pass `acknowledgeGuards` naming exactly those, plus an
   `acknowledgeReason` citing the ruling. See `apps/datatool/README.md`.

**The backstop** is `.github/workflows/promote-strand-audit.yml`, which cross-references
production D1 against the base daily and fails on any stray. AECI-593 is the worked
example: two Polycam edges were editorially retracted on 2026-08-09 and sat live on
production until the audit found them. Repair recipes:
`scripts/ops/2026-08-promote-strand-audit/README.md` §Healing.

### 5.2 `claims[]` replaces AECi curation only (AECI-604)

**Since Stage 2, a claim absent from your payload is no longer a guaranteed delete.**
This is the one place where "join sets are replaced to exactly match what you send"
stops being the whole truth, and it is deliberate.

Vendors can now author their own claims and attest to existing ones through the vendor
portal. The review app has never had any way to see those rows — it only ever emits
`source: "aeci"` attestations — so a replace-everything ingest would silently delete a
vendor's assertions on every re-push of a claimed product. Instead, promote merges **by
origin**:

| What you send | What AECi does |
|---|---|
| A claim whose `(dataObject, direction)` already exists on that integration | **Reuses the existing row**, keeping its id and every vendor attestation on it. Only the `aeci` attestation is rewritten. |
| A new `(dataObject, direction)` | Creates it, `origin = "aeci"`. |
| You omit a claim AECi created and nobody else attests | Deleted, as before. |
| You omit a claim a **vendor has attested** | **Converted, not deleted** — it becomes `origin = "vendor"` and keeps the vendor's attestation. AECi has withdrawn its curation; the vendor's assertion stands on its own and renders as one-sided on the pair page. |
| A claim a **vendor created** (you never sent it, and never will) | Never touched, under any payload — including an empty `claims[]`. |

Three consequences for the review app:

- **You are no longer the sole author of an integration's claim set.** Re-curation is
  still safe and still does what you mean; it just cannot assume it owns every row. If
  the pair page shows a claim your base has no record of, that is expected — a vendor
  put it there.
- **Only `source: "aeci"` is yours to write.** Sending `vendor_a` / `vendor_b` in an
  `attestations[]` is rejected per-claim into `skipped[]` (`kind: "claim"`) rather than
  written; those slots are derived from product ownership and are not settable from a
  payload.
- **Claim ids are now stable.** A claim whose identity triple doesn't change keeps its
  id across re-promotes, so anything you store keyed on a claim id stays valid.

Whatever survived is reported in `preserved[]` (§4), so a re-promote of a claimed
product shows explicitly which rows were kept rather than leaving you to infer it.

---

## 6. Errors

Failures now arrive on **two different surfaces**, and you need to handle both:

- **Synchronous** — the kick-off rejected your request outright. These are things
  you can fix (or must escalate) before any work happened; nothing was committed.
- **On the job** — the kick-off succeeded but the commit failed. The poll returns
  `200` with `status: "errored"` and a structured `error`.

Synchronous rejections use the standard AECi envelope:

```jsonc
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "field": "product.name", "details": { … } },
  "trace_id": "…" }
```

### 6.1 Synchronous rejections (`POST /api/promote`)

| HTTP | `code` | Cause | What to do |
|---|---|---|---|
| 400 | `MALFORMED_REQUEST` | Body isn't valid JSON | Fix the request serialization. |
| 400 | `VALIDATION_FAILED` | Schema violation — missing required field, bad enum value, invalid `jobId`, duplicate `ref`, `extensionOf` using `ref`, integration endpoint `ref` that isn't the product, `builtByVendor` `ref` not in `vendors[]` | Read `error.field` / `error.details.issues`; fix and resend (same `jobId` is fine — nothing was started). |
| 401 | `UNAUTHENTICATED` | Missing or wrong bearer token | Check `REVIEW_APP_TOKEN`. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 8 MiB | Almost certainly a serialization bug — a real bundle is kilobytes. |
| 503 | `DEPENDENCY_FAILURE` | The AECi promote pipeline isn't configured on that environment | Not caller-fixable; report to the AECi team. |
| 500 | `INTERNAL_ERROR` | Unexpected server fault starting the job | Safe to retry with the **same `jobId`**. Nothing was committed. Report `trace_id` if it persists. |

### 6.2 Job errors (`GET /api/promote/jobs/{jobId}`)

```jsonc
{ "jobId": "recAbC123XyZ-1754963400",
  "status": "errored",
  "error": { "code": "SLUG_CONFLICT", "message": "A concurrent promote generated a duplicate slug; retry the request." } }
```

| `error.code` | Cause | What to do |
|---|---|---|
| `SLUG_CONFLICT` | A concurrent first-time promote generated the same slug, so the create hit a `*_slug_key` unique constraint | Retry with a **new `jobId`**; the retry re-reads existing slugs and disambiguates (`-2`, `-3`, …), so it won't re-collide. |
| `VALIDATION_FAILED` | A name that can't be turned into a URL slug (reserved or empty after normalization) — only detectable once AECi tries | Fix the name; re-push with a new `jobId`. |
| `CATALOG_VENDOR_MANAGED` | Connector arm only (§3a). The catalogue is **vendor-managed** on AECi, so the review lane is frozen for it | **Do not retry — not with this `jobId` and not with a new one.** Stop syncing that catalogue and render it read-only your side. Only an AECi operator can return it to review authorship. |
| `INTERNAL_ERROR` | Unexpected server fault during the commit | Retry with a **new `jobId`**. The commit is a single atomic batch, so a failed job wrote nothing. Escalate if it repeats. |

**An `errored` job wrote nothing.** The commit is one atomic `db.batch`, so there is
no partial state to clean up. Retrying needs a **new `jobId`** — the old one is
permanently bound to the failed attempt (that is the same guard that stops a replay
from double-committing).

**404 on a poll** means AECi has no record of that job: either the `jobId` was never
successfully kicked off, or it is older than the retention window. If you have a
pending marker and get a `404`, the safe move is to re-push with a new `jobId` — but
check first that the product isn't already live, because a `404` cannot distinguish
"never ran" from "ran, and aged out".

### 6.3 Every rejection is logged

You don't have to keep the HTTP response body to diagnose a failed push. **Every
rejected promote — synchronous or on the job — emits a detailed structured log** under
`source:review-app-promote`, so the AECi operator can find and triage it from the
log console alone:

> **Which console.** **PostHog Logs** (ADR 0024; the Datadog leg was deleted at AECI-651).
> The **contract below was unchanged by the swap** — the same
> attributes, the same `source`, the same `trace_id` correlation. Only the query syntax differs:
> a Datadog `service:aeci-api source:review-app-promote` search becomes an attribute filter on
> the OTLP resource attribute `service.name` plus the `source` attribute. Nothing the review app
> sends or the curator does changes.

- **Where:** service `aeci-api`, filter `source:review-app-promote`.
- **Synchronous rejections** carry the HTTP status (as `http_status` — the bare `status`
  attribute is reserved for the log level on both vendors), the error `code`, the `field`
  (when set), the full `details` (for a `VALIDATION_FAILED`, the entire Zod
  `issues[]`), the request `path`/`method`, and the **same `trace_id`** returned in
  the response envelope — so a curator-reported `trace_id` pivots straight to its
  log line. Level: 4xx at `warn`, 500 at `error` (plus the server stack).
- **Job failures** emit `aeci.api.promote.job_failed` at `error`, carrying the
  `job_id`, the error `code`, and the reason. A job failure never passes through the
  HTTP error path, so this log — not a status code — is the operator's record of it.
  Pivot on the `job_id` the curator saw.
- **Job outcomes** are also metrics: `aeci.api.promote.job{outcome:complete|errored}`
  and `aeci.api.promote.job.duration_ms`, so a slow-but-succeeding ingest is visible
  too (see `docs/OBSERVABILITY.md`).

This is promote-specific — the public read endpoints stay silent on 4xx to avoid
log noise. So "look in the logs" is the authoritative way to see why a promote was
rejected; you don't need to plumb the response body anywhere else.

> **This invariant did not hold before AECI-666.** The post-commit tail issued one
> request per `audit_log` row — two, during the ADR 0024 dual-run — all at once,
> which exhausted the invocation's connection budget. The runtime cancelled the
> stalled responses into `fetch` promises that never settle, so forwards were
> dropped with no error and no warning anywhere: the failure mode this section's
> promise is specifically meant to rule out. The audit forwards are now a single
> batched request per vendor, every transport releases its response body, and a
> hook that stays unsettled for 20s is abandoned with a `console.warn` visible in
> Cloudflare Workers Observability rather than hanging the invocation. If you are
> diagnosing a promote from before that fix landed, treat "no log record" as
> inconclusive, not as "it didn't happen" — the `promote_jobs` ledger in D1 is the
> authoritative record of what committed.

### 6.4 Partial promotes (`skipped[]`) are logged too

A `complete` job with a non-empty `result.skipped[]` (§4) is a **partial** promote —
some entities couldn't be linked (an integration/extension whose far endpoint isn't
promoted yet, a usefulness group, a claim `dataObject`, or a trade that didn't
resolve). Those never fail the promote, so they're easy to miss. They are surfaced
in the logs as:

- a single `warn` log `aeci.api.promote.partial_skipped` (`source:review-app-promote`)
  detailing every `{ ref, kind, reason }` plus per-kind counts, and
- an `aeci.api.promote.skipped` count metric tagged by `kind`
  (`integration` / `extension` / `usefulness` / `claim` / `trade`), for an alert to watch.

So a curator's silently-dropped push is visible even though the job
completed successfully. (You should still inspect `result.skipped[]` and re-push once
the blocking condition clears — the log is the operator's backstop, not a substitute
for handling `skipped[]`.)

---

## 6a. Edge-cache freshness after a promote (AECI-105)

You don't need to do anything for this — it's documented so you know what to
expect. After a successful promote commits, the AECi API invalidates the public
pages your push affected by purging their edge-cache tags (the product / vendor
detail pages, the `/products` and `/vendors` indexes, the relevant
category/audience/phase/trade browse pages, and — when a new taxonomy term or a new
product/vendor was created — the taxonomy nav and `sitemap.xml`). So a re-pushed
**edit** (e.g. a corrected description) becomes visible publicly within one edge
round-trip rather than waiting out the cache TTL.

**Failure semantics (deliberate):** the purge is **best-effort and runs after the
write commits**. It is fired asynchronously and **never affects the job outcome** —
a promote still reports `complete` even if the subsequent purge fails. It is also
dispatched *after* the job completes, so it never delays your poll. Under the hood
the API Worker **enqueues** a tag-purge message onto the AECi cache-purge queue
(`aeci-cache-purge-{env}`); the SSR Worker's consumer does the actual eviction via
native Cloudflare Workers Cache (`ctx.cache.purge()`). The old direct HTTP
purge-by-tag API call was retired in the Workers Cache migration. On the AECi side
every purge is observable as
`aeci.cache.purge{source:promote,outcome:ok|purge_failed|no_cache}`, plus a `warn`
log if the eviction fails (the queue consumer retries it). If a purge ultimately
fails, the only consequence is that the affected pages fall back to their normal
edge TTL (≤15 min on detail pages) — the same staleness window that existed before
this behavior was added, so there is no correctness regression. No retry or action
is required from the review app.

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
- **Trades are purged in full, but submitted to indexing services only when published
  (AECI-546, decided).** A promote touching any trade — one you *set* **or** one you
  *removed* by re-pushing without it — purges that trade's browse page plus the
  `/trades` index, the taxonomy nav, and `sitemap.xml`, because the trade facet is
  publication-gated (a term crossing the `TRADE_PUBLISH_MIN_PRODUCTS` floor — 1
  promoted product since 2026-08-14 — changes those surfaces
  without any term being created or deleted). **Purging and pinging deliberately
  differ in scope:** purging is about staleness, so it covers every touched trade,
  published or not; pinging is about *indexing*, so a sub-floor term — which serves
  `noindex` and is absent from the sitemap — is never submitted. After the write
  commits, the API re-counts each touched trade and submits only the ones at or above
  the floor, plus the `/trades` index itself (its per-term counts changed either way).
  This supersedes AECI-542's interim blanket exclusion, which deferred the call here.
  Nothing changes on your side: you send `trades`, the API decides what to advertise.

---

## 6b. Search-index freshness after a promote (AECI-139)

Also nothing for you to do — documented for expectations. Alongside the edge-cache
purge above, a successful promote also pushes the promoted records to Algolia
**immediately** (the product, its vendors, and any integrations), so they're
*searchable* right away rather than waiting for the 08:00 UTC (= 03:00 EST) daily sync. This closes
the "viewable on promote but not searchable until the daily sync" gap.

Same failure semantics as the purge: it's **best-effort, post-commit, and never
affects the job outcome** — a promote reports `complete` even if the Algolia push fails,
and the push never delays your poll.
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
never affects the job outcome** — a promote reports `complete` even if the recompute or
purge fails, and neither delays your poll. Outcomes are observable as `aeci.stats.compute{trigger:promote,outcome}` (plus
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

### Step 1 — stamp the marker

Write `promote_job_id = "recRevit001-1754963400"` onto the Revit row in Airtable
**before** anything below. If everything after this point dies, that marker is what
makes the promote recoverable.

### Step 2 — kick off

```http
POST https://<staging-api-host>/api/promote
Authorization: Bearer ************
Content-Type: application/json
```

```json
{
  "jobId": "recRevit001-1754963400",
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

Returns immediately:

```json
{ "jobId": "recRevit001-1754963400", "status": "queued" }
```

### Step 3 — poll

```http
GET https://<staging-api-host>/api/promote/jobs/recRevit001-1754963400
Authorization: Bearer ************
```

While it runs: `{ "jobId": "recRevit001-1754963400", "status": "running" }`. Once the
commit lands:

```json
{
  "jobId": "recRevit001-1754963400",
  "status": "complete",
  "result": {
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
    "phases": [],
    "trades": []
    },
    "skipped": []
  }
}
```

### Step 4 — collect

Write the IDs back to Airtable — on Revit: `supabase_product_id = 0f8fad5b-…`; on
Autodesk: `supabase_vendor_id = 1b9d6bcd-…`; on the integration:
`supabase_integration_id = 6ba7b810-…` — and **then** clear `promote_job_id`. Clearing
it last is what makes an interrupted collect resumable.

`"trades": []` comes back because the request sent no `trades` — and that is the
*right* answer for Revit: it's a horizontal BIM authoring tool, not a tool with
trade-specific value, so per the tagging rule (§3.3) it carries no trade tags. Most
of the catalog looks like this. A paving-takeoff product would send
`"trades": ["paving-asphalt"]` and get `[{ "slug": "paving-asphalt", "id": …,
"operation": "reused" }]` back.

### Re-pushing an edit later

The curator fixes the description. Same four steps, a **new `jobId`**, and the stored
IDs on the bundle:

```json
{
  "jobId": "recRevit001-1755049800",
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

Every `operation` in `result` comes back `updated`; the slugs are unchanged.

Note the new `jobId`. A `jobId` is bound to one attempt for the life of its retention
window, so reusing the first promote's id would just hand you back that job's old
`result` instead of running the edit.

---

## 8. Quick checklist for the review-app implementer

- [ ] Store the AECi `REVIEW_APP_TOKEN` server-side; send it as `Bearer`.
- [ ] **Generate a unique `jobId` per promote attempt and stamp `promote_job_id` on the Airtable row BEFORE the push** (§2.1). This ordering is the duplicate-safety guarantee — there is no key on the AECi side.
- [ ] **Poll `GET /api/promote/jobs/{jobId}` until `complete`, then collect, then clear the marker** — in that order. The `202` means "accepted", not "done".
- [ ] **Never push a row that still has a pending `promote_job_id`.** Collect its job first (or let the reconcile sweep do it); a fresh push with a new `jobId` and no `supabaseId` is a create, and that is how duplicates happen.
- [ ] Retry a failed *kick-off* with the same `jobId` (free, idempotent); retry a failed *job* with a NEW `jobId` (§6.2).
- [ ] Assemble one product bundle per "Promote" click (product + its vendors + its integrations).
- [ ] For a "push just the vendor edit" action, send only `vendors[]` with the stored `supabaseId` (§3.5); expect `product: null` back.
- [ ] Use made-up `ref`s to wire the bundle together; keep them unique per request.
- [ ] Omit `supabaseId` on first promote; include stored IDs on re-push.
- [ ] Never send slugs; persist the slugs AECi returns (they're the public URLs).
- [ ] Persist every returned `id` against your record, durably.
- [ ] Only include integrations whose far endpoint is already promoted (reference it by `supabaseId`); inspect `result.skipped[]`.
- [ ] Send `trades[]` only for products with **trade-specific value** (§3.3) — most products send none, and horizontal platforms send an empty array. Values may be slugs, names, or aliases; they resolve find-only, an unrecognized value comes back in `skipped[]` as `kind: "trade"` (never a term you just invented), and omitting the key **clears** the product's trades.
- [ ] Nest each integration's data-object `claims[]` under it (`dataObject` slug/name, `direction` `a_to_b`/`b_to_a`/`both` relative to source→target, `attestations[]` with `source: "aeci"` — **only** `aeci`); a claim rides with its integration and an unrecognized `dataObject`, or a vendor-owned attestation source, comes back in `skipped[]` as `kind: "claim"`.
- [ ] Understand that `claims[]` replaces **AECi curation only** (§5.2): omitting a claim a vendor has attested converts it rather than deleting it, and a vendor-authored claim is never removed. Don't treat `preserved[]` as an error.
- [ ] Handle `skipped[]` kinds `"vendor"` / `"product"` (§4a): show the curator that the entity is **vendor-claimed and not writable from here** — don't retry, and don't treat `product: null` as "no product sent" without checking.
- [ ] Don't rely on `verified` — it is accepted and ignored (§3.2).
- [ ] **Send `lastReviewedAt` only on a genuine re-check, never as a default in your push builder** (§3.6). It becomes a public "Reviewed &lt;date&gt;." claim; stamping it on every sync turns it into `updated_at` with extra steps and makes the marker lie. Omitting it is always safe — the stored value is left alone. `maintainedBy` is not accepted at all.
- [ ] **Connector catalogues (§3a):** page at ≤500 rows, send the `catalog` header on **every** page, and use a distinct `jobId` per page. Send stub pages before pair/mapping pages if you want to avoid skips — but you do not have to, because a dangling reference is reported and re-sendable rather than fatal.
- [ ] **On the connector arm, inspect `skipped[]` even on a clean `complete`.** A full-mirror sync that dropped 200 mappings because their products are not promoted looks identical to one that dropped none.
- [ ] **Never let absence mean deletion on the connector arm.** A row missing from a page is a row on another page. Retire a stub or pair with a `removedAt` tombstone; hard-delete a mapping or surface through the explicit `deleted` object.
- [ ] On a synchronous 4xx, surface `error.message` / `error.field` to the curator; on 5xx, retry (same `jobId`) then escalate `trace_id`. On `status: "errored"`, surface `error.code` / `error.message` and retry with a new `jobId` (§6).
