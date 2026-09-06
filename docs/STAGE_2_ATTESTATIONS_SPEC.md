# AEC Integrations — Stage 2: Integration Attestations & Conflict (build spec)

**Version:** 1.0 — **build contract** for the AECI-514 epic
**Date:** August 2026 (epic review / kickoff 2026-08-14)
**Spec parent:** `docs/STAGE_2_SPEC.md` §2.4 (scope outline) — **this doc supersedes it as the build contract**
**Inherits from:** `docs/STAGE_1_5_SPEC.md` §3 (the claim/attestation model), `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` (the vendor seam this builds on)
**Base branch:** `aeci-514` (long-lived epic integration branch — see §1.4)

> **Data-layer note (ADR 0016 / 0017).** The application database is **Cloudflare D1 + Drizzle**;
> Supabase is **auth-only**. Every write in this epic goes through `getDb(env)` and a single
> `db.batch([...])` that includes its `audit_log` row (the §26.1 invariant of `STAGE_1_SPEC.md`).
> There is **no Prisma, no Postgres, no RLS on app tables** — authorization is the 3-layer Worker
> model in `docs/AUTH_AND_RLS.md`.

---

## 1. Overview & the launch model

Stage 1.5 shipped the claim/attestation spine **AECi-seeded and dormant**: `attestations.source`
reserves `vendor_a`/`vendor_b`, `introduced_at`/`deprecated_at` ride unused, and `computeAgreement`
can only ever return its `unverified` branch because AECi does not vote (the **AECi-never-red**
rule, `STAGE_1_5_SPEC.md` §3.4). AECI-513 shipped the vendor portal on 2026-07-25. **This epic is
where a vendor's word finally enters the model.**

The reader-facing invariant that governs every decision below is `STAGE_2_SPEC.md` §8.1(4):
**one-sided states are visibly labeled — absence of a vendor attestation is never rendered as
agreement.** Everything in §4 exists to make that structurally true rather than a copy promise.

**Capability gate.** Attestation authoring is a **Verified-vendor** capability (`STAGE_2_SPEC.md`
§8.1(3)). It gates **capability only, never ranking, placement, or badge trust** — no
pay-for-placement. This epic reads `vendors.verified` directly (`assertVerifiedVendor`), which was
the launch entitlement bit per §8.3(1); since AECI-609 that column is a **mirror** of a
`vendor_entitlements` row (`STAGE_2_SPEC.md` §8.5(1)), so these routes still read the right thing
but are gated on the mirror rather than on the `attestation.author` **capability** the registry now
declares. Behaviourally identical while the ladder is binary; **AECI-623** does the swap.

### 1.1 Issue map & critical path

This doc is the contract for the AECI-514 sub-issues. Each opens with
`**Spec section:** docs/STAGE_2_ATTESTATIONS_SPEC.md §X` per the `spec-anchor` convention.
**The subsection numbering below is load-bearing — do not renumber without updating the issues.**

| Anchor | Issue | Surface |
|---|---|---|
| §2 | AECI-603 | Attestation authority + claim provenance schema (**migration 1**) |
| §3 | AECI-604 | Promote coexistence — stop clobbering vendor attestations |
| §4 | AECI-605 | Agreement engine: `single_source` + the conflict / one-sided read path |
| §5 | AECI-301 | Vendor attestation authoring API (`/api/vendor/*`) |
| §6 | AECI-606 | Vendor portal — Integrations / attestations tab |
| §7 | AECI-302 | Detector + notification pipeline (email-only) |
| §8 | AECI-607 | Product-version model (**migration 2**) |
| §9 | AECI-303 | Version-diff timeline + per-product version selectors |
| §10 | AECI-608 | Docs: attestation authz + API/schema contract sweep |
| §13 | AECI-616 | Maintenance marker: real `last_reviewed_at` + vendor-maintained branch (**migration 3**) |
| §14 | AECI-705 | Connector-powered edges are not attestable (gate over the shipped epic; no migration) |

**Build order.**

```
§2 authority + schema (603) ──┬─→ §3 promote coexistence (604)
                              ├─→ §5 write API (301) ──→ §6 dashboard tab (606)
                              └─→ §7 notification pipeline (302)

§4 agreement engine (605) ──── independent of §2; MUST land before §5 is enabled in
                               any public environment (see the gate note below)

§8 product-version model (607) ──→ §9 version-diff UI (303)

§10 docs sweep (608) — runs alongside

§13 maintenance marker (616) ── needs §5's write path to light its vendor branch

§14 connector gate (705) ────── a review-and-gate pass over §2/§5/§6/§7 once all
                                four had shipped; MUST land before Stage 2 launch
```

> **Release gate.** §4 changes what a *reader* sees. §5 is what first creates a vendor
> attestation. Shipping §5 before §4 would render a single vendor's self-assertion as
> "Vendor-confirmed" on the public pair page — the exact failure §8.1(4) forbids. **§4 must be
> merged to `stage-2` before §5 reaches staging.** §4 needs no vendor data to build or test: the
> engine's non-`unverified` branches have been unit-tested against synthetic vendor attestations
> since AECI-300.

### 1.2 Schema deltas — **three deliberate migrations**

`STAGE_2_SPEC.md` §2.4 claimed this epic needs **no migration**. That was true of the *agreement
engine* (computed-not-stored) and remains true of the `vendor_a`/`vendor_b` sources. It is **not**
true of the epic as scoped at kickoff: two decisions (§1.3(1) and §1.3(3)) each require schema, and
§13 (AECI-616, added after kickoff) requires a third. §2.4 has been corrected. All three migrations
are **additive** — no column is dropped or retyped, so they are safe to apply ahead of the code that
reads them (`docs/migrations.md`: edit `apps/api/src/db/schema.ts` → `pnpm db:generate` →
`wrangler d1 migrations apply`).

**Migration 1 (§2)** — claim provenance + attestation authority:

| Table | Change |
|---|---|
| `claims` | `+ origin TEXT NOT NULL DEFAULT 'aeci'` CHECK `IN ('aeci','vendor')` |
| `claims` | `+ created_by_vendor_id TEXT NULL` → `vendors(id)` `ON DELETE SET NULL` |
| `attestations` | `+ attested_by_vendor_id TEXT NULL` → `vendors(id)` `ON DELETE SET NULL` |
| `attestations` | `+ retracted_at TEXT NULL` (supersession — **not** the version stamp, see below) |
| index | `+ attestations_slot_key` — **partial unique** on `(claim_id, source)` `WHERE retracted_at IS NULL` |
| index | `attestations_active_idx` predicate changes `deprecated_at IS NULL` → `retracted_at IS NULL` |

**Migration 2 (§8)** — the product-version model: a new `product_versions` table plus
`attestations.introduced_version_id` / `deprecated_version_id`. **Shipped as `0008_slim_iron_lad.sql`,
renumbered to `0017` by AECI-619 and to `0022_slim_iron_lad.sql` by AECI-750** (see §1.4), and the two `ALTER`s are
hand-authored for the reason §2.5 documents; see §8.4.

**Migration 3 (§13)** — the maintenance marker: `last_reviewed_at` + `maintained_by` on `vendors`,
`products`, and `integrations`. Shipped as `0023_chilly_joseph.sql`, additive, **hand-authored for
the reason §2.5 documents** — see §13.4. Scoped in after this section was originally written
(AECI-616 postdates kickoff), which is why several docs briefly said "two"; AECI-608 swept that.

> **⚠️ `deprecated_at` is a version stamp, not a retraction — the shipped schema comment says
> otherwise.** `STAGE_1_5_SPEC.md` §3.3 defines `introduced_at`/`deprecated_at` as **version
> stamps for the Stage 2 timeline** ("this flow existed until …"). But `schema.ts`'s
> `attestations_active_idx` comment reads *"partial on the dormant version stamp so Stage 2 can
> retire an attestation without deleting its history"* — i.e. it treats `deprecated_at` as
> retirement. Conflating the two would make an attestation vanish from the read path the moment a
> vendor records that a data flow was deprecated in v6, which is the opposite of what §9 needs.
> **§3.3's definition wins** (AECI-303 depends on it). Supersession gets its own column,
> `retracted_at`, and the index predicate moves onto it.

### 1.3 Decisions taken at the epic review (2026-08-14, Chris)

Promoted into `STAGE_2_SPEC.md` §8.4; restated here because they are the contract.

1. **Vendors may CREATE claims, not just attest to AECi-seeded ones.** A vendor knows its own
   integration surface better than AECi's curation does; attest-only would cap coverage at what
   AECi happened to seed. Cost: claim provenance (`claims.origin`) and the §3 promote carve-out.
2. **Attestation authority derives from product ownership** (§2.1), never from anything the client
   sends — the AECI-520 `vendor_id`-scoping invariant, extended to a two-slot model.
3. **A real product-version model is added** (§8). The dormant date stamps alone cannot express
   "source-version × target-version", which is what AECI-303 asks for; there is no version entity
   anywhere in the schema today.
4. **Notifications ship email-only** (Resend) with cron-driven detectors and an in-portal list.
   Live in-portal delivery is AECI-516; nothing in this epic waited on it, and nothing it shipped
   changes. *(**Transport resolved 2026-08-19** — `STAGE_2_SPEC.md` §8.6 / ADR 0023 /
   `docs/STAGE_2_REALTIME_SPEC.md`: **scoped client revalidation**, not Durable-Object WebSockets or
   SSE. New nudges appear in-portal within one poll interval and surface as a session-scoped count,
   never a banner; **email stays the primary channel**. That §7 is cron-driven and daily is in fact
   the load-bearing input to that decision — a socket would have delivered a 24-hour-stale event
   with 50 ms of transport latency.)*
5. **`confirmed` requires two *distinct vendor identities*** — a `single_source` state is added so
   one vendor's affirmation is never rendered as bilateral agreement (§4).
6. **Notification dedupe uses `audit_log` as the ledger** — no notifications table (§7.3).

### 1.4 Branch model

`origin/aeci-514` is a **long-lived epic integration branch** (= `stage-2` + this kickoff commit).
Every sub-issue branches from and PRs into **`aeci-514`**, not `stage-2` — each sub-issue has to
*update this doc*, and this doc does not exist on `stage-2`. When the epic completes, `aeci-514`
merges to `stage-2`. **The Linear issue template's `**Base branch:** stage-2` line is stale for
this epic; the sub-issue descriptions override it.** (Same model as AECI-513 / `aeci-513`.)

#### As built: the `main` reconciliation (AECI-619, 2026-08-18) — **done**

At kickoff `stage-2` was 22 commits behind `main`, and this section carried a ⚠️ blocking §3 until
that was reconciled. It has been, as its own tracked task (AECI-619), in two merges:
`main → stage-2`, then `stage-2 → aeci-514`. By landing it was **29 commits / 79 files** touched on
both sides. **AECI-604 is unblocked.**

**The resolution rule, recorded because the next epic branch will need it:** `stage-2` wins on cache
architecture (ADR 0020 / WC-1…WC-11), `main` wins on promote structure (ADR 0021 / AECI-563, 571,
568). Neither branch was a superset. `promote.ts` was where they met head-on — `main` had rewritten
it (`createPromoteHandler` → `runPromoteIngest` + `dispatchPromoteHooks` over a `PromoteRunCtx`)
while still purging over HTTPS with `CF_PURGE_API_TOKEN`, which `stage-2` had **deleted** in WC-10.
`main`'s structure was kept and `purgeAfterPromote` re-implemented as a `CACHE_PURGE_QUEUE` enqueue;
`stage-2`'s claimed-vendor write block (AECI-520) was then re-applied onto the new ingest by hand.

**Migrations were renumbered.** `main` had reached `0015`, so this epic's two migrations moved:
`0006_lyrical_leper_queen` → **`0016`**, `0008_slim_iron_lad` → **`0017`**. The `0007` reservation
(§8.4) was never needed in the end, but it cost nothing. Critically, this was **not** the three-file
rename `docs/migrations.md` §0 describes — across a ten-migration gap the snapshots had to be
*regenerated* against the merged schema, with the hand-authored SQL bodies swapped back in, or the
newest snapshot would have omitted every table `main` added. That doc now carries the distinction.
`aeci-515` still holds a `0006` and takes `0018`+ when it reconciles.

**Six defects surfaced that were not merge conflicts** — each a place where the two branches were
individually correct and jointly wrong. Recorded because they are the class of thing a conflict-free
merge hides: `wrote` counting `promote.blocked` audit rows (a fully-blocked promote claimed a write);
`vendorEditableData` still writing `verified`, which AECI-520 made grant-only; `/trades` shipping
without the WC-3 resilience pair; duplicated `DD_*` keys in two workflow `env:` maps (invalid YAML);
three `stage-2` fixtures predating `main`'s `TaxonomyResponse.trades` / `VendorLinkSchema.verified`;
and a cache-HIT page-view spec driving a stub WC-3 had deleted. The §7 detector sweep also became a
first-class 11th cron (`AdminCronJob` / `CRON_SCHEDULES`), so it appears on `/admin/system`.

### 1.5 What already exists — reuse, don't rebuild

Verified against the tree at kickoff and **re-verified at close (AECI-608)** — every path below
still resolves, and the line numbers are refreshed to the epic's merge state. They are anchors, not
guarantees: check before editing.

- **Schema hooks** — `attestations.source` CHECK already allows `'aeci' | 'vendor_a' | 'vendor_b'`;
  `introduced_at` / `deprecated_at` columns present. `apps/api/src/db/schema.ts` (`claims` ~:469,
  `attestations` ~:523, and — added by §8 — `productVersions` ~:426). *(Kickoff cited ~:321 / ~:349;
  the shift is `main`'s tables arriving via the AECI-619 reconciliation, not a move.)*
- **Agreement engine** — `computeAgreement` / `computeSyncHeadline`, pure and unit-tested
  including the currently-unreachable `confirmed`/`conflict` branches.
  `packages/shared/src/agreement.ts`.
- **Pair read path, end to end** — `integrationPairConfig` → `toProductPairClaim` →
  `computeAgreement` → `toProductPairResponse`. `apps/api/src/lib/drizzle-helpers.ts`
  (`integrationPairConfig` ~:225, `toProductPairClaim` ~:995, `toProductPairResponse` ~:1077, and
  the shared `liveAttestationsWhere` §4 extracted at ~:168). Wire contract:
  `packages/shared/src/api/product-pairs.ts`.
- **Pair page render** — direction lanes + per-claim badge + provenance disclosure.
  `apps/web/src/app/products/products-pair.ts`, `agreement-badge.ts`, `claim-provenance.ts`.
  The badge **already carries `confirmed` / `conflict` copy** behind deliberately neutral styling.
- **The vendor write template** — `requireVendor()` + `sessionVendorId()` + one-`db.batch`
  write + `auditInsert` + `waitUntil(purgeTags + forwardAuditLog)` + the 404-not-403
  non-disclosure rule. `apps/api/src/routes/vendor.ts` is the file every §5 endpoint copies;
  `apps/api/src/lib/authz.ts` is the guard. **Since §8/AECI-607 those mechanics live in
  `apps/api/src/routes/vendor-shared.ts`** — `sessionVendorId`, `parseJsonBody`, `purgeTags`,
  `afterVendorWrite`, the audit source, plus `requireOwnedProduct()` (product-grain ownership,
  the sibling of §2.3's integration-grain `resolveAttestationSlots`) and `assertVerifiedVendor()`
  (the §1 capability gate). **§5 imports them; it does not re-implement them.** *(As built: it
  did, and the only change it needed was an array overload on `afterVendorWrite`, because a
  claim write emits more than one audit row — §5.4.)*
- **`data_object` find-only resolution** — `loadDataObjectResolver` /`safeSlugify` in
  **`apps/api/src/lib/data-object-vocabulary.ts`**, shared by promote and §5 (extracted from
  `promote.ts` by AECI-301). §7's detectors should read the vocabulary through it too rather
  than re-deriving the slug-or-alias match.
- **Cache-Tag helpers** — `pairCacheTag(a, b)` / `sortedPairSlugs` (`apps/api/src/routes/promote-pair.ts`)
  and `cacheTagsForPromote` (`apps/api/src/routes/promote-cache-tags.ts`) already emit the exact
  `pair:{min}__{max}` tag the pair page sets. §5 purges through the same tag.
- **Cron → queue → consumer** — `apps/api/src/scheduled.ts` (ADR 0013): the cron enqueues, the
  queue consumer runs the job. Cron strings must stay **byte-equal** to `apps/api/wrangler.jsonc`
  `triggers.crons`. §7's detector sweep is a new entry in this pattern.
- **Resend client** — `apps/api/src/lib/email.ts`, fail-open, `EmailTemplate` union +
  `docs/email.md` catalogue. §7 adds template ids here.
- **`data_object` vocabulary** — frozen and closed (`docs/DATA_OBJECT_VOCABULARY.md`).
  Find-only resolution; **a vendor cannot mint a term** any more than promote can.

---

## 2. Attestation authority + claim provenance schema (AECI-603)

**Blocks §3, §5, §7.** Migration 1 (§1.2) plus the one helper every write path resolves through.

### 2.1 The authority rule — which slot is the caller's?

`vendor_a` / `vendor_b` are defined by `STAGE_1_5_SPEC.md` §3.3 as "the integration's endpoint-A /
endpoint-B vendors", where **A = `integrations.source_product_id`** and **B =
`target_product_id`** (§3.2). Product ownership lives in `product_vendors`. So, for a session
`vendorId` and an integration row:

| Ownership (`product_vendors` row exists for…) | Result |
|---|---|
| the integration's `source_product_id` | may attest **`vendor_a`** |
| the integration's `target_product_id` | may attest **`vendor_b`** |
| **both** endpoints | may attest **both slots** — but see the distinct-identity rule below |
| neither | **404**, not 403 |

**Ownership is necessary, not sufficient (AECI-705 / §14).** A second question runs immediately
after this one: *may this EDGE be attested at all?* A **connector-powered** edge — `powered_by_product_id`
set, or `mechanism_kind = 'iPaaS'` — answers no with a **403**, because neither endpoint built the
plumbing. It is deliberately not folded into the table above or into `ownedEndpointJoin`: that join
is the scoping predicate the AECI-627 freshness cursor must match exactly, and narrowing it would
silently change what a vendor's portal considers fresh.

**404, not 403** is the AECI-520 non-disclosure rule (`apps/api/src/routes/vendor.ts` header): a
vendor must not be able to probe for the existence of another vendor's integration. The check runs
**before** any other read or write, in its own wave, for the reason documented on
`createUpdateVendorProductHandler` — folding it into a `Promise.all` lets a validation error win
the race and answer a request that should have been a flat 404.

**The distinct-identity rule.** `product_vendors` is many-to-many and `profiles.vendor_id` is
many-to-one, so (a) one vendor can own *both* endpoints of an integration, and (b) two different
vendor accounts can own the *same* product and target the same slot. Consequences:

- **`confirmed` requires two distinct `attested_by_vendor_id` values** (§4). One company owning
  both endpoints can affirm both slots and will still render `single_source` — it is not a
  bilateral signal, and pretending otherwise would let a vendor manufacture "Vendor-confirmed" on
  its own intra-portfolio integrations.
- **One live attestation per slot**, enforced by the partial unique index
  `(claim_id, source) WHERE retracted_at IS NULL`. Two accounts on the same vendor overwrite each
  other's slot; two accounts on *different* vendors owning the same product is a data-quality
  problem for AECi, not something this epic resolves — the index makes last-write-win explicit
  instead of silently accumulating duplicate votes.
- **Supersession is retract-then-insert**, never `UPDATE` — both statements in the same
  `db.batch` as the audit row. The history stays append-only, which is what §9's timeline reads.

### 2.2 Claim provenance

`claims` gains `origin` (`'aeci' | 'vendor'`, default `'aeci'`) and `created_by_vendor_id`.
Invariants:

- `origin = 'vendor'` ⟺ `created_by_vendor_id IS NOT NULL`. Enforced in application code; a D1
  CHECK across two columns is possible but keep it in one place (the §5 handler + a unit test).
- Existing rows backfill to `'aeci'` via the column default — every claim in D1 today came from
  promote.
- `origin` is what §3 filters on so promote can replace AECi curation without touching vendor rows.
- **Provenance is not trust.** A vendor-created claim is *not* automatically more or less credible
  than an AECi-seeded one; it renders through the same §4 agreement states. `origin` exists for
  write arbitration (§3) and for the AECi ops view, not as a reader-facing badge.

### 2.3 The helper seam

`resolveAttestationSlots(db, vendorId, integrationId)` in
**`apps/api/src/lib/attestation-authority.ts`** returns the caller's permitted slots for one
integration (or throws `notFoundError('integration', …)`), and a batched variant for the §5 list
endpoint that resolves slots for many integrations in one query. Every §5 write and the §7
detectors resolve through it — nothing re-derives the rule inline. Unit tests must cover all four
ownership cases in the §2.1 table plus the both-endpoints case.

### 2.4 Acceptance

- Migration 1 generated by `pnpm db:generate` and applied locally + to preview; `schema.ts` is the
  source of truth and `docs/DATABASE_SCHEMA.md` is updated to match.
- The partial unique index rejects a second live attestation on the same `(claim_id, source)`.
- `resolveAttestationSlots` unit-tested across the ownership matrix.
- No behavior change on any public surface — this sub-issue is schema + helper only.

### 2.5 As built (AECI-603 — 2026-08-14)

Shipped as **migration 1 of two**: `apps/api/migrations/0021_lyrical_leper_queen.sql` (shipped as
`0006_*`, renumbered by AECI-619 — §1.4), generated from
`apps/api/src/db/schema.ts` (`claims` / `attestations` + their `relations`), plus the helper seam
`apps/api/src/lib/attestation-authority.ts` and its spec. Constraint coverage lives in
`apps/api/src/test/d1.spec.ts` (the harness applies the real migration files, so the CHECK, the
partial unique index and the SET NULL FKs are genuinely exercised). `docs/DATABASE_SCHEMA.md` §5a is
brought forward to match. Decisions taken at build that this section did not pre-specify:

- **The migration body is hand-authored, and it had to be.** drizzle-kit answers a new CHECK
  constraint on SQLite with a full table recreate — `PRAGMA foreign_keys=OFF` → `CREATE __new_claims`
  → `INSERT…SELECT` → `DROP TABLE claims` → `RENAME`. All three parts fail here: its
  `INSERT…SELECT origin, created_by_vendor_id … FROM claims` reads columns that do not exist yet
  (the statement errors outright); D1 does not support `PRAGMA foreign_keys = on|off`, only
  `defer_foreign_keys`; and with FKs enforced `DROP TABLE claims` fires
  `attestations.claim_id ON DELETE CASCADE`, deleting **every attestation in the database**.
  Separately, `ALTER TABLE … ADD COLUMN … .references()` emits a bare `REFERENCES vendors(id)` with
  **no `ON DELETE` clause**, silently dropping the SET NULL this section specifies. So: generate for
  the snapshot, then replace the SQL body with additive `ALTER`s. Drift-check still passes — it
  diffs `schema.ts` against `meta/0006_snapshot.json`, never the database — and a re-run of
  `db:generate` reports "No schema changes". The general rule is now recorded in `docs/migrations.md` §0.
- **The 404 is structural, not a branch.** `resolveAttestationSlots` runs one `INNER JOIN` of
  `integrations` against `product_vendors` scoped to the caller's vendor, so "this integration does
  not exist" and "you own neither endpoint" produce the *same empty result*. There is no code path
  that could distinguish them, which is stronger than remembering to return the same error from two
  branches. Pinned by a spec that asserts the two responses are byte-identical in shape.
- **Both endpoint ids come back with the slots.** `AttestationAuthority` carries `sourceProductId` /
  `targetProductId` alongside `slots`, because every §5 caller needs them anyway — for the
  `pairCacheTag` purge and for translating stored direction into the caller's frame — and re-reading
  the integration row would be a second D1 hop on the Worker.
- **The batched variant is vendor-keyed, not id-keyed.** `resolveAttestationSlotsForVendor(db,
  vendorId, { integrationIds? })`: omit the scope and it returns the caller's *entire* attestable
  surface, which is precisely what `GET /api/vendor/integrations` (§5.1) is. Passing ids scopes it.
  One private `loadAuthorities()` backs both entry points so the §2.1 table is computed in one place.
- **`slotsForOwnership(ownsSource, ownsTarget)` is exported** as a pure function. §7's detectors need
  the *inverse* lookup (slot → which vendors to notify), which is deliberately **not** built here —
  AECI-302 should build it on this function rather than as a second copy of the ownership table.
- **Provenance is a type, not a checked pair.** `claimProvenance(vendorId | null)` returns a
  discriminated union, so `origin='vendor'` without a vendor id is unrepresentable rather than
  merely rejected; `assertClaimProvenance()` is defence in depth for paths that assemble the two
  columns by hand, and raises **500 `INTERNAL_ERROR`** — a violation is a programming fault and must
  never be blamed on the caller. An empty-string vendor id resolves to `'aeci'`, not to a
  `'vendor'` row with no vendor.
- **`ON DELETE SET NULL`, not cascade, on both new FKs.** Losing a vendor row must not delete the
  claim or erase its historical assertion; the claim survives as an orphan for AECi to re-curate and
  the attestation stays readable by §9's timeline.
- **One three-line guard added to `promote.ts` — the only production code this issue touched.**
  `attestations_slot_key` is enforced against the *existing* writer too, so a payload repeating a
  source on one claim (nothing in `PromoteAttestationSchema` prevents it) would newly fail the
  **whole** `db.batch`, turning a duplicated vote into a 500 on the entire promote. The claims loop
  already collapses in-payload identity duplicates for exactly this reason; the attestation loop now
  does the same, first-occurrence-wins, with a regression spec. This is the "don't ship an index
  without the guard that keeps the current writer working" half of the change — the real
  replace-by-origin rework is still §3/AECI-604's.
- **Pre-flight before any tier with data.** `CREATE UNIQUE INDEX attestations_slot_key` fails if a
  tier already holds two live rows for one `(claim_id, source)`. Run against all four tiers on
  2026-08-14: **zero duplicates everywhere** — demo and production each carry 951 claims / 951
  attestations (a clean 1:1, since promote has only ever written one `aeci` row per claim); preview
  and staging hold none. Re-run before the epic merges, because the count moves with every promote:

  ```sql
  SELECT claim_id, source, COUNT(*) c FROM attestations
  WHERE retracted_at IS NULL GROUP BY 1,2 HAVING c > 1;
  ```

- **Applied to remote `aeci-app-preview` by hand.** CI applies migrations remotely for staging, demo
  and production only (`scripts/d1-apply-migrations.sh`, invoked from `deploy.yml` /
  `promote-to-demo.yml` / `promote-to-prod.yml`) — **nothing migrates remote preview**, which PR
  previews bind to, so it drifts silently. It was one migration behind before this issue and is now
  current; `wrangler d1 migrations apply aeci-app-preview --env preview --remote` is the command,
  and it stays a manual step until a CI job owns it.

> **✅ Handoff to §4 (AECI-605) — discharged.** At the time of writing,
> `integrationPairConfig` (`apps/api/src/lib/drizzle-helpers.ts`) had **no `where`** on its
> `attestations` sub-query, so every attestation still reached `computeAgreement` — harmless while
> no code could create a retracted row, but a latent hole once §5 ships the retract endpoint.
> §4 closed it: both claim-loading read configs now apply the shared `liveAttestationsWhere`
> (`isNull(attestations.retractedAt)`), and `computeAgreement` re-checks `retractedAt` itself so
> the shared engine is safe for callers that assemble attestations another way. See §4.4.

**Why no public surface moved:** both read configs use an explicit column allowlist
(`claims: { id, direction }`, `attestations: { source, asserted, note, introducedAt, deprecatedAt }`),
so the new columns cannot leak into a response; and promote's inserts omit them, so SQLite applies
the `origin` default. Every pre-existing spec — including the promote and product-pair suites —
passes **unmodified**; the only test files this issue touched are the new
`attestation-authority.spec.ts` and four added cases in `d1.spec.ts` (`pnpm test:unit`: 72 files /
914 tests green in `apps/api`, 23 / 311 in `packages/shared`).

---

## 3. Promote coexistence — stop clobbering vendor attestations (AECI-604)

**Blocks §5 reaching any environment that promotes.** This is a **live defect**, not a new feature.

### 3.1 The defect

`POST /api/promote` replaces claims by wholesale delete-and-reinsert:

```
db.delete(claims).where(eq(claims.integrationId, integrationId))   // apps/api/src/routes/promote.ts ~:1295
```

Attestations cascade via `attestations.claim_id ON DELETE CASCADE`. The review app (bamako) only
ever emits `source: 'aeci'` attestations. So **the first re-promote of a claimed product silently
deletes every vendor attestation on it**, and — because the re-insert mints fresh
`crypto.randomUUID()` claim ids — churns every claim id even for claims whose identity triple
never changed.

No spec mentions this. It is the exact analogue of `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.2 ("claimed
vendors are not promote-writable") and needs the same treatment: **AECi keeps curating; the vendor's
word survives.**

### 3.2 Replace-by-origin semantics

Promote's merge-by-replacement stays, but scoped:

1. **Upsert claims by identity, don't delete-and-reinsert.** Use the existing
   `claims_identity_key` unique index `(anchor_id, data_object_id, direction)` — the anchor being the mechanism row in either delivered-tier table since AECI-721 — as the
   `ON CONFLICT` target so a surviving claim keeps its id — and therefore keeps the attestations
   hanging off it. This alone fixes the id churn.
2. **Delete only AECi claims the payload dropped** — `WHERE integration_id = ? AND origin = 'aeci'
   AND id NOT IN (<upserted ids>)`. Vendor-origin claims are never in the payload and are never
   deleted.
3. **Replace only AECi attestations** — `DELETE FROM attestations WHERE claim_id = ? AND source =
   'aeci'`, then insert the payload's. `vendor_a`/`vendor_b` rows are untouched.
4. **Retiring an AECi claim that a vendor has attested → convert, don't delete.** When step 2
   would drop a claim carrying ≥1 non-retracted vendor attestation, instead set
   `origin = 'vendor'`, `created_by_vendor_id = <the attesting vendor>`, and delete only its
   `aeci` attestation. AECi has withdrawn its curation; the vendor's assertion still stands on its
   own authority and renders `single_source`. Lossless, and it keeps the pair page honest.

All of it stays inside the existing single `db.batch([...])` with its `audit_log` rows (§26.1) —
D1 has no interactive transactions. Statement order stays FK-safe:
integration → claim upserts → claim deletes → attestation deletes → attestation inserts → audits.

### 3.3 Contract + review-app follow-through

- `docs/REVIEW_APP_PROMOTE_API.md` §5's merge-by-replacement text needs the carve-out spelled out:
  **`claims[]` replaces AECi curation only.** A claim absent from the payload is no longer a
  guaranteed delete.
- The bamako-facing note (analogue of vendor-portal §4.2): once an integration carries vendor
  attestations, the review app is no longer the sole author of its claim set. Re-curation is still
  safe; it just cannot assume it owns every row.
- The promote **response** should surface what it preserved — extend `skipped[]` or add a
  `preserved[]` counter so an operator re-promoting a claimed product can see that vendor rows
  survived rather than inferring it. (Shape decided in the sub-issue.)

### 3.4 Acceptance

- A promote that drops a claim carrying a live vendor attestation converts it to `origin='vendor'`
  and preserves the attestation — regression test with a seeded vendor attestation.
- Re-promoting an unchanged payload leaves every claim id stable (assert on ids before/after).
- Existing promote specs stay green; the claims-ingest specs gain the origin-scoped cases.
- **Rebase note:** this sub-issue must be written against the post-`main`-merge `promote.ts`
  (§1.4) — the file was restructured by AECI-563 / AECI-571 / AECI-568 on `main`. *(Discharged:
  AECI-619 landed first; this was built on `promote.ts` @ `f2c9249e`.)*

### 3.5 As built (AECI-604 — 2026-08-18)

The rule lives in a new module, **`apps/api/src/lib/promote-claims.ts`**, exporting one function:
`planClaimIngest(db, resolveDataObject, items)` → `{ statements, audits, skipped, preserved }`.
It executes nothing — `runPromoteIngest` splices the statements into the same atomic
`db.batch([...])` that already carries the integration writes and their audit rows, so the §26.1
invariant is unchanged. The call site is eight lines. Decisions taken at build that §3.2 did not
pre-specify:

- **The upsert needs a pre-read; `ON CONFLICT` alone cannot do it.** §3.2(1) says to use
  `claims_identity_key` as the `ON CONFLICT` target, and the insert does — but D1 has no
  interactive transactions and `db.batch` cannot feed one statement's result into the next, so the
  surviving claim's **id** has to be known before the batch is built or the attestation inserts
  have nothing to point at. One batched read up front (`inArray` over the **anchor** ids, chunked —
  `integration` ids before AECI-721 made the anchor polymorphic) is what actually delivers id
  stability; the `onConflictDoUpdate` is a race guard behind it. Mechanism rows this promote
  *created* are excluded from the read, so a first-time promote pays nothing.
  - **The `ON CONFLICT` target had to move with the index** (AECI-721). `claims_identity_key` is
    now `(anchor_id, …)`, and `anchor_id` is a generated column — so targeting `integration_id`
    would name no index at all and SQLite would reject the statement rather than degrade to an
    insert. The race guard would have become a hard batch failure on the first genuine race.
- **An identity match emits no claim statement at all** — not even an `UPDATE`. The claim row's
  content *is* its identity; there is no other editable column, so an update would move
  `updated_at` and nothing else while adding an audit row per claim per promote. Production
  carries ~950 claims, so that churn is the thing §3.1 was complaining about, one level down.
- **Promote may write only `source: 'aeci'`, enforced at ingest.** `PromoteAttestationSchema`
  permits `vendor_a`/`vendor_b` and always has. Inserting one now collides with a live vendor row
  on the `attestations_slot_key` partial unique index and rolls back the **entire** promote, so a
  non-`aeci` source is dropped into `skipped[]` (`kind: 'claim'`) instead — the same
  degrade-and-report shape the unresolved-`dataObject` path already uses. Tightening the Zod enum
  was rejected: a 400 on the whole bundle for a field bamako never sends is a harsher contract
  change than a per-claim skip.
- **A payload claim matching a vendor-created claim does not seize it.** The row is re-used and
  `origin`/`created_by_vendor_id` are left alone — provenance records who *created* the claim, and
  that is still the vendor. Seizing it would also strip the §3.2(2) protection on the next promote.
- **The conversion has a null-vendor branch.** `attestations.attested_by_vendor_id` is
  `ON DELETE SET NULL`, so the attesting vendor can be unknown; converting then would write
  `origin='vendor'` with a null `created_by_vendor_id`, which `assertClaimProvenance` (§2.5) raises
  a **500** on. Instead the `aeci` attestation is dropped, the row stays `origin='aeci'`, and a
  later promote retries — reported as its own `preserved[]` reason. Unreachable while §5 is the
  only vendor writer (it always stamps the vendor); it exists so a data anomaly degrades instead of
  becoming an outage. `vendor_a` is preferred over `vendor_b` purely for determinism.
- **`preserved[]` is a new top-level array, not more `skipped[]` kinds** (§3.3 left the shape
  open). The two carry opposite signals: `REVIEW_APP_PROMOTE_API.md` §4 tells the review app to
  inspect `skipped[]` and act, whereas `preserved[]` is never actionable — it is the operator's
  receipt. Folding them together would make every claimed product's re-promote look like it had
  problems. Entries are `{ ref, kind: 'claim' | 'attestation', reason, count }` aggregated per
  `(ref, kind, reason)`, `ref` being the enclosing integration's. `PromoteJobLedger.response`
  stores the whole response, so it survives an AECI-571 replay with no ledger change.
- **Two new audit actions, closing a real §26.1 gap.** `claim.deleted` (with `beforeState`) and
  `claim.converted` (with `before`/`afterState`). The wholesale delete this replaces emitted **no**
  audit row for the rows it destroyed — every one of those 951 production claims could have
  vanished unlogged. `DATABASE_SCHEMA.md`'s action catalogue already reads `'claim.*'`, so no
  catalogue edit was needed; `ADMIN_PANEL_SPEC.md` and the `catalog.claims_created` metric row did
  need one, because both cited the claim-spine churn as the reason catalog counts are
  unreconstructable.
- **Duplicate `supabaseId` across two payload entries is handled explicitly.** The old
  delete-then-reinsert absorbed it (each delete cleared the previous insert, last entry winning);
  an id-reusing planner would instead emit two inserts for one identity and fail the batch. Items
  are de-duplicated by `integrationId`, last wins, matching the previous net effect.
- **Residual race, accepted and documented.** Two concurrent promotes of the same integration can
  interleave between the pre-read and the batch; the loser's attestation insert references a claim
  id that never landed, the FK rejects it, and D1 rolls back — a retryable 500, the same posture as
  the existing `409 SLUG_CONFLICT`. Closing it needs a transaction D1 does not offer.

**Tests.** Nine cases in `runPromoteIngest — replace-by-origin claim coexistence (AECI-604)`
(`apps/api/src/routes/promote.spec.ts`), against the real-migration D1 harness so the cascade, the
FK and both unique indexes are genuinely exercised. Eight were confirmed by mutation testing —
breaking identity matching, the vendor-attestation check, and the `origin='vendor'` guard each
failed the expected subset. Every pre-existing promote spec passes unmodified; the only edits to
old tests were `preserved: []` added to 23 hand-built `PromoteResponse` fixtures.

---

## 4. Agreement engine + the reader-facing states (AECI-605)

**Independent of §2; gates §5 (see §1.1).** This is where the §8.1(4) one-sided invariant becomes
structural.

### 4.1 The gap in the shipped engine

`computeAgreement` (`packages/shared/src/agreement.ts`) returns `confirmed` when **any** vendor
affirms and none deny:

```
if (affirms && denies) return 'conflict';
return affirms ? 'confirmed' : 'unverified';
```

With one vendor affirming and the counterparty silent, that renders **"Vendor-confirmed"** — which
is precisely "absence of a vendor attestation rendered as agreement", the thing `STAGE_2_SPEC.md`
§8.1(4) and AECI-304 forbid. In Stage 1.5 the branch was unreachable, so the gap was latent. §5
makes it reachable.

### 4.2 The state set

`AGREEMENT_STATES` gains **`single_source`**. Votes are non-`aeci` attestations with
`retracted_at IS NULL`, **deduped by `attested_by_vendor_id`** (§2.1):

| Distinct vendor voters | Outcome |
|---|---|
| 0 | `unverified` — the Stage 1.5 baseline, unchanged |
| 1, affirming | **`single_source`** *(new)* |
| ≥1, denying only | `unverified` — a denied-but-unconfirmed claim is not a conflict (`STAGE_1_5_SPEC.md` §3.4, preserved) |
| ≥2 distinct, all affirming | `confirmed` — bilateral, the only state that earns the word |
| ≥2 distinct, affirm **and** deny | `conflict` |

`AgreementAttestation` widens to carry the voter identity and the retraction flag. The
**AECi-never-red** rule is unchanged and now doubly true: AECi never votes, and `conflict` needs
two distinct vendors.

### 4.3 Render contract

- **`conflict` is the only red state.** It is a genuine vendor-vs-vendor disagreement and should
  read as "these two vendors describe this differently", not as a defect in either product. The
  existing `AgreementBadge` copy (`Needs review`) is a placeholder — the tone is a design decision
  in this sub-issue.
- **`single_source` is neutral and attributed** — "Confirmed by {vendor}" with the counterparty's
  silence visible, not implied. It must never borrow `confirmed`'s affirmative treatment.
- **`confirmed` earns the positive treatment.** Bilateral only.
- **`unverified`** keeps its Stage 1.5 neutral "not yet vendor-confirmed" reading (§8) — never a
  warning.
- **Sync headline** (`STAGE_1_5_SPEC.md` §3.5) widens from `{ total, confirmed }` to
  `{ total, confirmed, single_source }` — additive on the Zod object. `confirmed` stops being
  structurally 0 for the first time; the headline copy must distinguish the two.
- Surfaces to update in lockstep: the pair page claim lanes
  (`apps/web/src/app/products/products-pair.ts`), `agreement-badge.ts`, `claim-provenance.ts`, and
  the product-detail integrations table's `context_direction` (`effectiveContextDirection`,
  `packages/shared/src/integration-context.ts`) — a **denied** claim must not keep contributing its
  direction to the table, or the table and the pair page contradict each other again (the bug
  `STAGE_1_5_SPEC.md` §7.1 already had to fix once).

- **The provenance disclosure renders a note only for a VENDOR-authored attestation** (AECI-779).
  An `aeci`-sourced note is curation-internal and arrives as `null` — the API suppresses it at both
  reader mappers, so this is a contract the surface receives rather than a rule it enforces. The
  reason it needed saying: §4.3 specified every other string on this surface down to the CVD glyph
  and required all copy through `$localize`, while the note was the one string that was neither
  localized nor specified — **because it is data occupying a copy slot**, and nobody had assigned it
  an audience (`STAGE_1_5_SPEC.md` §3.3). Note the History section (§9.1) renders the same note from
  a **different** route, so both mappers suppress; see `readerFacingNote`.

**UI-touching, so the `CLAUDE.md` design checklist applies:** critique → the pair page's existing
Mobbin anchor site (the anchor-site rule — do not introduce a second site for badge states) →
craft/refine → polish → `npx impeccable detect` zero P0 → **light theme only** (no `dark:`
variants) → axe pass. All copy through `$localize` / `i18n` attributes.

### 4.4 Acceptance

- `computeAgreement` unit tests cover the full §4.2 matrix, including the both-endpoints
  same-vendor case resolving `single_source`.
- No claim anywhere renders `confirmed` without two distinct attesting vendors — assert it.
- The pair page renders all five states from fixtures with no vendor data in the DB.
- `?view=basic` still collapses the lanes; cache-key behavior unchanged.

### 4.5 As built (AECI-605 — 2026-08-14)

Shipped **after** AECI-603, so the vendor identity and the retraction column were real and every
state is exercised end-to-end in the API's D1 harness rather than only in shared unit tests. No
migration. Decisions taken at build that §4.1–§4.4 did not pre-specify:

- **A voter's stance is `affirm` only if *every* one of its live votes asserts — any deny wins.**
  `attestations_slot_key` is unique per `(claim, slot)`, **not** per vendor, so one company owning
  both endpoints can affirm one slot and deny the other. §4.2's matrix has no row for it. That is
  self-contradiction — neither bilateral agreement nor a vendor-vs-vendor conflict — so it resolves
  `unverified`. Failing toward "not verified" is the safe direction, and it collapses the matrix
  back to exactly five outcomes.
- **Unattributable votes collapse into ONE voter bucket.** `attested_by_vendor_id` is
  `ON DELETE SET NULL` (§2.1), so deleting a vendor row leaves a *live* attestation with a null
  identity. Two such orphans must not read as two distinct vendors. All null-identity votes fold
  into a single module-private sentinel, which makes `confirmed` unreachable without provable
  distinctness — the §4.4 acceptance criterion enforced structurally rather than by convention.
- **`isClaimRefuted()` is a second exported predicate, not a sixth state.** The §4.3
  denied-claim carve-out cannot be read off `AgreementState`: `unverified` conflates "nobody voted"
  (an AECi-seeded claim that still describes a real flow) with "every vendor denies". Only the
  latter may stop feeding `effectiveContextDirection`. Both functions share one private
  `tallyVoters()` so the dedupe rule has a single implementation.
- **`effectiveContextDirection` takes claims, not bare directions.** Its second parameter widened
  from `readonly ClaimDirection[]` to `readonly DirectionalClaim[]` (`{ direction, attestations }`)
  and it filters refuted claims itself. Filtering at the call site was the alternative; putting it
  in `integration-context.ts` keeps the rule in the single home for direction framing, which is
  what §7.1's drift bug argues for. A `conflict` claim still counts — disputed is not withdrawn.
- **Attribution ships as a context-relative `attestor`, not a vendor id.**
  `PairClaimAttestation` gains `attestor: 'aeci' | 'context' | 'other'`, resolved server-side by the
  new `attestorForContext()` (the same A/B mirror as `claimDirectionForContext`). The pair page
  renders "Confirmed by {vendor}" against the two `ProductListItem.vendor` links the response
  already hydrates — **no join through `attested_by_vendor_id`, and no new query cost**. The raw
  vendor UUID is deliberately not exposed: attribution is a display concern.
- **`sync_headline.single_source` carries `.default(0)`.** The SSR and API Workers deploy
  per-commit but not atomically, so the SSR schema must still parse a response from an API Worker
  that predates the field (the same reason `claims` uses `.default([])`).
- **The product-detail read got wider, deliberately.** `productDetailIntegrationConfig` now
  hydrates each claim's attestations (`source`, `asserted`, `attestedByVendorId`, `retractedAt` —
  no `note`, no version stamps) to feed the refuted-claim filter. That is roughly
  integrations × claims × attestations rows on an edge-cached product-detail read; the column list
  is kept minimal because none of it is serialised.
- **Copy and tone (the design decision §4.3 left open).** `conflict` → **"Vendors disagree"**;
  `single_source` → **"Confirmed by {vendor}"** (falling back to "Confirmed by one vendor" when the
  product has no `product_vendors` row); `confirmed` → **"Both vendors confirmed"**; `unverified`
  unchanged. `conflict` is the only red state and uses `--status-error` — **`DESIGN.md`'s Error
  token was widened** from "form/validation error text and icons" to cover it. It also carries an
  `✕` glyph so it survives greyscale and CVD (WCAG 1.4.1); every state has a distinct visible label
  and `aria-label`, and `single_source`'s aria states the counterparty's silence outright.
  `single_source` shares the neutral chip with `unverified` — by design, so a lone affirmation can
  never borrow the affirmative treatment.
- **The badge stays a `rounded.sm` chip, never the pill.** `DESIGN.md` reserves the pill for
  `VerifiedBadge`, which means an AECi-verified vendor *account* — a different claim entirely. A
  spec asserts the shape so the two cannot converge.
- **`@@pair.dataflow.subline`** ("Vendor confirmation arrives with the vendor portal") is now
  conditional on no vendor having attested at all — keyed off the presence of a vendor attestation,
  not off the agreement state, because a claim every vendor *denied* is still `unverified` yet the
  subline would be false. **Amended 2026-09-04 (AECI-781):** the vendor portal shipped with the
  Stage 2 dark launch on 2026-09-03, so all three strings on this page that described it as
  forthcoming were retired and re-keyed —
  `@@pair.claim.provenance.closing` → `@@pair.claim.provenance.closing.unverified`
  ("No vendor has confirmed this flow."),
  `@@pair.dataflow.subline` → `@@pair.dataflow.subline.aeciAsserted`
  ("These flows are asserted by AECi."), and
  `@@pair.dataflow.empty.subline` → `@@pair.dataflow.empty.subline.cataloguing`
  (the trailing sentence dropped — with zero claims there is nothing to be unconfirmed about).
  The replacement copy states who has and has not spoken without promising a feature or implying a
  refusal, per §3.4's never-a-warning rule. **The `awaitingVendors` gate above is unchanged**; only its
  justification moves — a vendor that has spoken to deny makes "asserted by AECi" no longer the
  whole provenance of the pair. **The band subline says *who asserted*, never *how many are
  confirmed*:** the `confirmedRatio` line directly beneath it always reads "0 of N
  vendor-confirmed" in exactly the state the subline renders, so a subline phrased around the
  absence of confirmation would restate it verbatim. The provenance popover's closing line has no
  ratio beneath it and so keeps the confirmation phrasing.
- **No Mobbin anchor exists for the pair page.** DESIGN.md and the AECI-289/294/300 commits name
  none, so the anchor-site rule had nothing to anchor to. No second site was introduced: the badge
  states reuse the in-repo chip vocabulary and the `VerifiedBadge` token set.

**Test coverage:** the §4.2 matrix plus the both-endpoints, null-identity, self-contradiction and
retraction cases in `packages/shared/src/agreement.spec.ts`; the refuted-claim carve-out and
`attestorForContext` in `integration-context.spec.ts`; all five outcomes end-to-end (real vendor
rows, real `retracted_at`) in `apps/api/src/routes/product-pair.spec.ts`; the direction fallback in
`products.spec.ts`; and all five rendered from fixtures — plus the `?view=basic` collapse — in the
three `apps/web/src/app/products/*.component.spec.ts` files. Suites green at merge: `packages/shared`
23 files / 328 tests (`agreement.spec.ts` 20, `integration-context.spec.ts` 23), `apps/api` 72 / 926
(`product-pair.spec.ts` 19), `apps/web` 107 / 754 under `ng test` plus 37 / 570 under plain Vitest.

---

## 5. Vendor attestation authoring API (AECI-301)

**Needs §2. Gated by §4 (§1.1).** The `/api/vendor/*` surface a Verified vendor writes through.
`apps/api/src/routes/vendor.ts` is the template: `requireVendor()`, the ban gate, `vendorId` from
`c.get('auth')` and **never** from the request, one `db.batch` per write carrying its `audit_log`
row, `waitUntil(purge + §26.5 audit forward)`.

### 5.1 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/vendor/integrations` | The caller's attestable surface: every integration touching a product the vendor owns, with its claims, current agreement, the counterparty's state, and **which slot is the caller's** |
| `POST` | `/api/vendor/claims` | Create a claim (`origin='vendor'`) **and** the caller's affirming attestation, in one batch |
| `PUT` | `/api/vendor/claims/:claimId/attestation` | Assert or deny — upsert the caller's slot (retract-then-insert, §2.1) |
| `DELETE` | `/api/vendor/claims/:claimId/attestation` | Retract the caller's attestation (sets `retracted_at`; the row survives for §9's timeline) |
| `GET` | `/api/vendor/data-objects` | The closed `data_object` vocabulary the §6 picker offers — **added by AECI-606**, see §6.1 |

The last row shipped with §6/AECI-606, not with AECI-301; §5.4 remains an accurate record of what
AECI-301 built. It lives in this table because §5.1 is the epic's only inventory of the
`/api/vendor/*` attestation surface.

**`POST` and `PUT` additionally answer 403 on a connector-powered edge** (AECI-705 / §14); `DELETE`
and the two `GET`s do not. Retract stays open because an edge can *become* powered after a vendor has
attested, and a vendor must always be able to withdraw a position it holds.

Shapes, Zod schemas and error codes go in `packages/shared/src/api/` and are documented in
`docs/API_CONTRACTS.md` (new subsection alongside the AECI-520 `/api/vendor/*` section).

### 5.2 Rules

- **`data_object` is find-only.** Resolve the slug against the frozen `taxonomy_data_objects`
  vocabulary, directly or via `aliases` (`docs/DATA_OBJECT_VOCABULARY.md` §2). A vendor cannot
  mint a term. Unlike promote — which lands a miss in `skipped[]` because it is a batch job — this
  is an interactive caller, so an unmatched term is a **`400 VALIDATION_FAILED`** naming the field.
  The UI (§6) should offer the closed list rather than free text in the first place.
- **Authority through §2.3 only.** No handler re-derives the slot rule. A claim on an integration
  the caller touches neither endpoint of is a **404**.
- **Verified gate.** Authoring requires `vendors.verified` (§1). Unverified → `403 FORBIDDEN` with
  copy that points at the claim/verification flow, never at ranking.
- **Connector gate, and it runs FIRST of the two 403s** (AECI-705 / §14). A connector-powered edge is
  `403 FORBIDDEN` on `POST` / `PUT` whatever the caller's tier, with copy that points at the
  connector and never at verification — verification will never unlock it. Order:
  authority → 404, powered → 403, verified → 403.
- **Direction is stored canonically** (`a_to_b` / `b_to_a` / `both`, relative to the integration
  row's own endpoints — `STAGE_1_5_SPEC.md` §3.2) and translated to the caller's frame at the API
  boundary. The vendor UI speaks "inbound/outbound"; the DB never does.
- **Audit** — `claim.created`, `attestation.created`, `attestation.retracted`, each with
  `metadata.source = 'vendor-portal'` (the tag that distinguishes a vendor's write from promote's,
  since `actor_type` is `'user'` for reviewers and vendor admins alike) plus `vendorId` and the
  resolved slot.
- **Cache-Tag purge**, post-commit via `waitUntil` → `CACHE_PURGE_QUEUE` (WC-5 / ADR 0020). Tags:
  `pairCacheTag(sourceSlug, targetSlug)` — the **same** tag the pair page emits, via
  `apps/api/src/routes/promote-pair.ts`, keep them in lockstep — plus `product:{sourceSlug}` and
  `product:{targetSlug}` (the detail pages carry the claims-aware direction column). Best-effort:
  a purge failure must never fail a committed write.
- **No Algolia reindex.** Claims do not feed the index today; vendor edits reach search on the
  nightly watermark sync (`STAGE_2_SPEC.md` §8.3(5)). **UI copy must not promise instant search.**

### 5.3 Acceptance

- Authz matrix spec (mirroring `vendor.authz-matrix.spec.ts`): anonymous / reviewer / admin /
  banned vendor / unverified vendor / non-owning vendor / owning vendor, per endpoint.
- A non-owning vendor gets 404 (never 403, never a 400 that leaks existence).
- Every write emits its audit row **in the same batch** — assert on the batch contents, not on a
  follow-up read.
- Retract-then-insert never violates the §2 partial unique index.

### 5.4 As built (AECI-301 — 2026-08-17)

Shipped as **API only** (the §6 dashboard tab is AECI-606) and with **no migration** — §2 and §8
had already landed every column and index it needs. The handlers are
`apps/api/src/routes/vendor-attestations.ts`, the wire contract is
`packages/shared/src/api/vendor-attestations.ts`, and the surface is mounted on the existing
`authVendor` sub-router in `apps/api/src/index.ts`. `docs/API_CONTRACTS.md` §6.14,
`docs/AUTH_AND_RLS.md` §4.2a/§4.4 and `docs/CACHE_STRATEGY.md` §5(b2) are brought forward to match.

Decisions taken at build that §5.1–§5.3 did not pre-specify:

- **A vendor owning BOTH endpoints writes ALL the slots it owns.** `product_vendors` is
  many-to-many, so one company can hold `vendor_a` *and* `vendor_b` on one integration, and §5 never
  said which to write. Writing only `vendor_a` was the cheaper option and is wrong: it cannot
  retract a pre-existing `vendor_b` row from the same company, so a claim could carry two live rows
  from one vendor that disagree — exactly the self-contradiction §4.5 had to add a special case for
  — and `DELETE` would leave half the position standing. Writing every owned slot changes nothing
  for the reader (§4 dedupes voters by `attested_by_vendor_id`, so one company is one voter and
  still renders `single_source`) and keeps the slot off the wire, which §2.1 requires. The
  alternative of letting the request name its slot was rejected on that last point alone.
- **`GET /api/vendor/integrations` is ownership-gated but NOT Verified-gated**, exactly as §8.4
  settled for the version list. Authoring is the Verified capability; reading your own surface is
  not, so the §6 tab renders read-only and explains what verification unlocks rather than 403-ing a
  vendor out of its own data.
- **The gate ORDER needed one adaptation, and it is load-bearing.** §8.3's rule — prove ownership
  first, in its own wave, parse the body last — assumes the id is a path param. `POST
  /api/vendor/claims` carries its `integration_id` in the **body**, so authority cannot be resolved
  before the body is read. The order is: shape-only Zod parse (touches no DB, so a 400 from it is
  existence-independent and leaks nothing) → authority alone in its wave, with only the caller's own
  `vendors` row alongside → everything else. Folding vocabulary resolution or the duplicate check
  into the authority wave is the precise mistake `createUpdateVendorProductHandler` warns about: a
  400 naming a bad `data_object` would win the race and answer a request that should have been a
  flat 404. A spec asserts a non-owner still gets 404 when the body is *also* invalid.
- **The claim-grain 404 needed its own helper, to close a real existence leak.**
  `resolveClaimAuthority(db, vendorId, claimId)` was added to `lib/attestation-authority.ts`. The
  obvious composition — load the claim, then call `resolveAttestationSlots` on its `integration_id`
  — answers `details.resource: 'claim'` for a claim that does not exist and `'integration'` for one
  belonging to another vendor. Those are **distinguishable** 404s, so a vendor could walk claim ids
  and learn which are real. One join collapses both into the same empty result, exactly as §2.5 did
  one grain up; the indistinguishability is structural, not a branch someone has to remember to
  write identically twice. It reuses `slotsForOwnership` — the §2.3 rule is not re-derived.
- **`data_object` resolution was extracted rather than copied.** Promote's find-only slug-or-alias
  matcher was a closure inside `promote.ts`, unimportable. It now lives in
  `apps/api/src/lib/data-object-vocabulary.ts` (`loadDataObjectResolver` + `safeSlugify`) and
  promote was refactored onto it — the matching rule is identical for both callers and only the
  failure mode differs (`skipped[]` for a batch job, `400 VALIDATION_FAILED` for an interactive
  one). The resolver returns the whole term, not just the id, so the vendor path echoes
  `data_object_name` without re-reading the row it just matched. Every promote spec passes
  unmodified.
- **A duplicate claim identity is a `400` carrying `details.claim_id`.** `claims_identity_key` is
  the guarantee; the pre-check exists so a vendor gets a field-keyed 400 instead of a constraint
  violation surfacing as a 500 (the `assertLabelFree` discipline from §8.4). Returning the existing
  id is what lets the §6 UI pivot to `PUT` instead of dead-ending. Note the collision is narrower
  than it looks: claims anchor to the **mechanism row** (`STAGE_1_5_SPEC.md` §3.1 / ADR 0018), so
  two mechanisms moving the same `data_object` between the same products are two independent claims.
- **`claimDirectionFromContext` is a new shared pure function**, the exact inverse of the shipped
  `claimDirectionForContext`, added to `packages/shared/src/integration-context.ts`. Every read path
  so far only needed the outward translation because the DB was the only author; this is the first
  *writer* that speaks the caller's frame. It lives beside its inverse because that module is the
  single home for direction framing — the two surfaces drifted once already (`STAGE_1_5_SPEC.md`
  §7.1). A round-trip property test pins them together in both frames.
- **The retract `UPDATE` filters on slot, not on vendor id.** `attestations_slot_key` is unique per
  `(claim, slot)` among live rows, so an incoming write must clear whatever holds a slot it owns —
  including a row another vendor co-owning the product wrote (§2.1's data-quality case, which the
  index deliberately makes last-write-wins). `DELETE` is the exception: it retracts only the
  caller's OWN rows, because withdrawing your position must never silently withdraw someone else's.
- **`DELETE` with nothing to retract is a 404, not an idempotent 204.** §26.1 wants no audit row
  without a state change, and a 204 would claim one happened.
- **One audit row per attestation row**, not one per request: `attestation.created` /
  `attestation.retracted` each carry their own `entityId` and `metadata.slot`, which is what §7.3's
  `audit_log`-as-ledger dedupe will read. `POST` therefore emits `claim.created` plus one
  `attestation.created` per owned slot, all in the same batch. `afterVendorWrite` gained an array
  overload so every row is forwarded (§26.5), not just the headline one.
- **`attestation.retracted` is a new action string** — it did not exist in the tree.
  `errors.ts` gained `claim` and `attestation` resource kinds so the 404 envelope names the right
  thing.
- **Version stamps are enforced per slot.** §8.2's "the referenced version always belongs to the
  attesting side's own endpoint product" cannot be expressed by the FK, so the handler checks it: a
  version outside the caller's owned endpoints is a `400` naming the field, and an *unknown* id
  answers identically so the response cannot be used to probe another product's release history. For
  a both-slot caller the stamp lands only on the slot whose endpoint owns that version; the other
  slot's stays null.
- **The list endpoint queries by owned PRODUCT ids, not by integration ids.** The authority map
  already holds the integration ids, but every one would become a bound parameter, and D1's
  per-query ceiling is far below what a large vendor's surface would need. The owned-product list is
  bounded by the vendor's own catalog (single digits, typically) and expresses the same set. The
  authority map remains the authority — a row it does not know about is filtered out.
- **The response is composed in memory, never re-read.** `PUT` builds the post-write attestation set
  from the pre-read live rows minus the slots it superseded, plus what it wrote — the `vendor.ts`
  discipline ("re-reading would only cost a round-trip — and could 404 a write that actually
  succeeded"). `agreement` is recomputed and echoed so the dashboard never re-derives it.
- **The counterparty view is keyed off vendor identity, not off the slot**, and is reduced to
  `asserted` + `note`. Usually that is the other endpoint's vendor; it can also be a second vendor
  holding the caller's own slot. Both are genuinely someone else's assertion, and hiding the second
  would make the vendor's dashboard disagree with the public pair page. The AECi seed is never the
  counterparty, and version stamps / `attested_by_vendor_id` are deliberately not exposed.

**Test coverage:** `apps/api/src/routes/vendor-attestations.spec.ts` (50 cases — the four endpoints,
both-endpoint slot writes, the agreement matrix end-to-end through real rows, retract-then-insert
run three times against the real partial unique index, direction round-trip, find-only vocabulary,
version-stamp authority, the purge tag set, and the §26.1 rollback proved by a ghost `actor_id` that
makes `auditInsert` throw *inside* the batch); the four routes added to every cell of
`vendor.authz-matrix.spec.ts` plus its own Verified-gate and cross-vendor 404 blocks (117 cases
total); `resolveClaimAuthority` in `attestation-authority.spec.ts`; the round-trip property in
`integration-context.spec.ts`; the extracted resolver in `data-object-vocabulary.spec.ts`; and the
wire contract in `packages/shared/src/api/vendor-attestations.spec.ts`. Suites green at merge:
`apps/api` 75 files / 1110 tests (was 72 / 926), `packages/shared` 26 / 390 (was 23 / 328). Every
pre-existing spec passes **unmodified**.

> **⚠️ Release gate, restated.** §4/AECI-605 is merged on `aeci-514`, so the §1.1 gate is discharged
> *on this branch*. It is still the reason this must not be cherry-picked anywhere §4 is absent.

---

## 6. Vendor portal — Integrations tab (AECI-606)

**Needs §5.** The authoring surface, added to the existing tabbed dashboard.

- New tab in `apps/web/src/app/vendor/vendor-dashboard-tabbed.ts` — extend the `Tab` union, the
  `tabs` array, and the `@switch`. The component is presentational and takes its payload as an
  input; keep it that way (it renders both the dev preview and the gated `/vendor` route).
  *(As built that is where it landed. **The three edit points moved** when the portal gained real
  URLs — `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2: there is no `Tab` union or `@switch` any more, and a
  section is now one entry in `vendor/vendor-nav.ts` plus one lazy child route in
  `vendor/vendor.routes.ts`. The shell is still presentational and still takes only `me`, and the
  section component itself is unchanged.)*
  *(**And moved again** — `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.5, 2026-08-27: Integrations is no
  longer a vendor-level tab at all. It is a section of a PRODUCT
  (`…/products/:productSlug/integrations`), listed in `VENDOR_PRODUCT_NAV_ITEMS`. Three
  consequences for this spec: `GET /api/vendor/integrations` emits **one entry per owned
  endpoint** rather than one per integration, so `id` is no longer unique in the response and the
  key is `(id, context_product.id)`; an owns-both integration is listed under **both** products,
  framed each way, still sharing ONE position (`slots`/`mine`/`counterparty`/`agreement` identical
  on both, per §2.1 and §4); and the §5 write paths take an optional `context_product_id`, which
  is load-bearing on `POST /api/vendor/claims` because the old endpoint-A default stored the
  reverse flow for a vendor authoring from its other product's tab. The read is still ONE
  vendor-wide call — only the view narrows.)*
- **Per integration:** the counterpart product, the mechanism, and each `data_object` claim lane
  with the caller's control (**Affirm / Deny / Clear**) alongside the counterparty's current state.
  A conflict must be legible from the vendor's side, with the counterparty's position shown.
- **Add a data flow:** `data_object` picker over the closed vocabulary + direction control +
  optional note and version stamps (§8). Per ADR 0010, new discrete-choice controls use
  **Angular Aria** (`@angular/aria`) — combobox/listbox stand in for the `select`/`radio` Aria@22
  does not ship — and bridge into Signal Forms via `[(value)]` + `(valueChange)`, not
  `[formField]`.
- **Copy discipline:** no instant-search promise (§5.2); no implication that attesting affects
  ranking or placement; "Verified" framed as an account status.
- Design checklist as in §4.3 — same anchor site as the rest of the vendor portal, light theme
  only, axe clean, all strings `$localize`d.

### 6.1 As built (AECI-606 — 2026-08-18)

**No migration** — §2 and §8 had already landed every column. One **new endpoint**, because §6 as
written could not be built: it requires the picker to "offer the closed list rather than free
text", and nothing served `taxonomy_data_objects` to a browser. `GET /api/taxonomy` carries only
the four product facets, and the one surface exposing the vocabulary
(`/api/admin/catalog/coverage`) is admin-gated.

Decisions taken at build that §6 did not pre-specify:

- **`GET /api/vendor/data-objects` is its own module** (`apps/api/src/routes/vendor-data-objects.ts`),
  not a fifth handler in `vendor-attestations.ts`. That file's first rule is "AUTHORITY IS DERIVED,
  NEVER SENT" and every handler in it resolves `product_vendors` before reading anything; this one
  resolves nothing. Sitting it among four handlers that all prove ownership is how a reviewer comes
  to assume a check that is not there. `vendor-notifications.ts` is the one-read-endpoint-per-module
  precedent.
- **It is the surface's only route with no `vendor_id` filter, and that is a contract rather than an
  omission.** The vocabulary is AECi-curated, has no `vendor_id` column and no vendor-owned rows, so
  the filter would be *vacuous*. `docs/AUTH_AND_RLS.md` §4.4 obligation 1 states the scoping rule as
  an absolute, so it now carries an explicit carve-out naming this route — without it the next
  reviewer either flags the handler as a bug or cites it as precedent somewhere it matters. A spec
  asserts two seats get byte-identical bodies, so a later "restore the missing filter" edit fails
  loudly instead of reading as a fix.
- **Not Verified-gated**, following `GET /api/vendor/integrations` and `/notifications`: 403-ing the
  vocabulary would leave the read-only tab unable to label its own claims. `assertVerifiedVendor` is
  deliberately not imported there, keeping its call sites at one-per-authoring-handler.
- **`aliases` is off the wire, and it is the load-bearing exclusion.** The picker submits a
  canonical slug, which always resolves, so alias matching buys nothing; shipping them would invite
  a client-side match that reimplements `safeSlugify`, and a second matcher is exactly the drift
  `lib/data-object-vocabulary.ts` was extracted from `promote.ts` to eliminate. They are also raw
  curation metadata ("ITB", "P6", "AP"), not translatable copy. `id` is off the wire because nothing
  takes one, and `display_order` because the array arrives ordered.
- **The ordering is NULLs-last, matching the claim sort.** `createListVendorIntegrationsHandler`
  coerces a null `display_order` to `MAX_SAFE_INTEGER` in JS; SQLite sorts NULLs *first*. Without
  the explicit `IS NULL` term the endpoint's rows and the tab's lanes would disagree on any
  hand-inserted row — invisible today, since all 27 seeded terms carry an order, which is what would
  make it expensive later. Pinned by a test in both the route and lib specs.
- **The picker renders the vocabulary ALPHABETICALLY, not in `display_order` (2026-08-26).** A
  later change, and the one place in the portal that re-sorts the vocabulary — `dataObjectOptions`
  in `vendor-add-claim-form.ts`. The bullet above still holds for the wire and for the lanes; only
  this control diverges. The lanes are **read**, and `display_order`'s project-lifecycle sequence
  (Models → Drawings → … → Directory & Contacts) is the information in them. The picker is
  **searched**: the vendor already knows they want "Submittals", and `AecSelect` is a non-editable
  Aria combobox with no type-to-filter, so an unfamiliar semantic order makes finding a known label
  a 20-item linear scan with no anchor. Sorted client-side on the rendered `name` via
  `localeCompare` rather than in SQL, because the terms are translatable copy and alphabetical order
  is per-locale. Both halves are pinned — sorted in the component spec, unsorted in the route spec —
  so "restoring" the wire order in the picker fails rather than quietly reverting the decision.
  Recorded in `docs/DATA_OBJECT_VOCABULARY.md` §4.1.
- **An unseeded vocabulary is `200 { data_objects: [] }`, never a 500** — a fresh local D1 without
  `seed/data-objects.sql` would otherwise take the whole tab down. The UI degrades the
  "add a data flow" affordance instead. **No audit row** (a pure read), no `Cache-Tag`, no purge.
- **The tab's data-loading lives in the SECTION, not the dashboard shell.** §6's "presentational,
  payload as an input" holds for `vendor-dashboard-tabbed.ts`, which still takes only `me`; the rule
  lands one level down exactly as it already does for `vendor-seat-roster.ts` and
  `vendor-products-section.ts` — the child injects `VendorApi`, and the preview shadows `VendorApi`
  through DI. So the same component runs verbatim on both surfaces with no conditional code, and the
  heavier read stays off every other tab's SSR path. `@switch` also means it only fires when a
  vendor opens the tab — and a lazy child route means the same thing after the §6.2 routing change,
  since the component is not instantiated until its route is active.
- **`DELETE` triggers a targeted re-read; the claim is never reconstructed locally.** A `204` echoes
  nothing, and `counterparty` is a *lossy* reduction of every other voter — with a third vendor in
  play, dropping the caller's own row can leave a genuine `conflict` that a local guess renders as
  `single_source`. `POST`/`PUT` reconcile from their echo, so only the retract path re-reads.
- **The PUT-replaces-not-patches hazard is closed in the type system.** `VendorAttestationPosition`
  (`vendor-api.ts`) makes every field required — the inverse of `UpsertVendorAttestationSchema`'s
  `.nullable().optional()` — so an incomplete body is a compile error rather than silent data loss.
  It is a live hazard because every neighbouring write on this dashboard is a PATCH of
  only-changed-fields. Three more layers back it up: one `position()` builder, a note field that
  renders inline and populated (never a collapsed empty disclosure), and a named regression test.
- **The owns-both divergence warning covers `note` and `asserted` only.** Version stamps
  legitimately differ across slots — §8.2 lands a stamp on the one slot whose endpoint owns that
  version — so treating that as divergence would fire on every stamped both-endpoints claim.
- **Affirm / Deny / Clear are plain buttons, not an Aria listbox.** ADR 0010 governs discrete-choice
  *form controls*; these are commands that fire a write on activation, map to two different HTTP
  verbs, and Clear is a withdrawal rather than a third value. Aria is used where §6 asks for it: the
  `data_object` combobox, the direction listbox, and the version pickers.
- **The add form is hand-rolled signals validated against the shared `CreateVendorClaimSchema`**,
  matching its two siblings in `vendor/` rather than Signal Forms. Signal Forms does not materialise
  a field seeded `undefined`, which is the shape of both required choices here (there is no valid
  "nothing chosen yet" member of `ContextDirection`). One Zod schema still owns validity either way.
- **`admin/admin-select.ts` was promoted to `shared/aec-select/aec-select.ts`** (`AecSelect`) rather
  than copied, gaining `placeholder` / `disabled` / `idPrefix` / `layout` / `describedBy`, all
  additive. Note Aria **soft-disables**: the trigger keeps `tabindex="0"` and carries
  `aria-disabled="true"` without ever taking the native attribute, so the obvious `disabled:`
  Tailwind variant silently never fires — style off `aria-disabled:`.
- **`products-pair.ts`'s direction copy was lifted to `products/pair-direction-labels.ts`** with the
  `@@pair.direction.*` ids unchanged, so the vendor's frame and the public pair page cannot drift
  into two wordings and the tab's highest-traffic copy adds no new translation units.
- **Per-instance ids derive from entity ids** (`vendor-claim-{id}-*`, `vendor-integration-{id}-*`),
  never a module counter — the tab renders one control set per claim.
- **One polite live region for the whole tab, many assertive ones.** Success mutates a single
  persistent `role="status"` at the section (which can name the subject, "RFIs · position saved");
  failures are lane-local `role="alert"` beside the control that failed. Never both for one event.
  *(Superseded 2026-08-19 by AECI-631: the region moved **out of this section** to the dashboard
  shell, because the shell destroys this component mid-announcement on a tab switch — an `@switch`
  branch then, a `<router-outlet/>` swap now — and the integration card carried a second
  `role="status"` of its own. The tab now announces through
  `VendorPortalAnnouncer` — the wording still originates here, only the channel moved.
  `STAGE_2_REALTIME_SPEC.md` §6.3.)*
- **§7.2's in-portal notification list now has its first UI consumer**, rendered as a **collapsed**
  disclosure. These rows are a 90-day archive of what was *emailed*, not live state, so rendered
  prominently a stale "Vendors disagree" nudge would sit above a lane whose badge reads `confirmed`.
  The ops-only `aeci-denied` detector is filtered defensively even though its ledger rows carry
  `vendorId: null` and can never match a caller.
  *(**Relocated by `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.5**, 2026-08-27: it moved out of the
  Integrations tab — which followed the product down a level — into the new vendor-level
  **Messages** section, alongside claim/correction status. So §7.2's "surfaced on the §6 tab" now
  reads "surfaced on the Messages section". Still a collapsed disclosure, still a session-scoped
  "N new" count, still no banner, badge, auto-expand or mark-as-read: giving the archive a findable
  home is a findability change, not a promotion of historical rows to live assertions, which is
  what `STAGE_2_REALTIME_SPEC.md` §6.2 actually forbids. Nothing about the endpoint, the
  `audit_log` ledger, or decision §1.3(6) changes.)*
- **No new Mobbin anchor was picked, deliberately** — the same call `ADMIN_PANEL_SPEC.md` §9.10 made
  for the operator console. The tab inherits the vendor dashboard's own language (bordered
  `--surface-raised` cards, eyebrow-then-heading headers, the `vendor-profile-form.ts` field
  classes) and reuses `products/agreement-badge.ts` verbatim so the vendor's view of a claim cannot
  disagree with the public pair page's. One publication, one voice. The `/vendor` surface had no
  `DESIGN.md` section at all, so this PR adds one and retro-records the AECI-522 anchor decision.
- **Copy discipline as §6 requires it**, and asserted by spec rather than by review: no wording
  implies ranking or placement, the only search reference is "search refreshes within a day"
  (`STAGE_2_SPEC.md` §8.3(5)), and "Verified" is framed as an account status arranged with AEC
  Integrations. The conflict disclosure uses `--surface-sunken`/`--border-strong`, **not**
  `--status-error`: red on this surface belongs to the agreement badge alone.

**Test coverage:** `apps/api/src/routes/vendor-data-objects.spec.ts` (8 — the exact key set, both
ordering rules incl. NULLs-last, the empty vocabulary, the deliberate cross-vendor *sameness*, an
unverified caller, and the response-schema contract); `lib/data-object-vocabulary.spec.ts` +4 for
`listDataObjectTerms`; the route added to every cell of `vendor.authz-matrix.spec.ts` plus its own
unverified-read and sameness cases (134 total, was 117); `packages/shared/src/api/vendor-attestations.spec.ts`
+8 for the two new schemas, incl. the positive assertion that `aliases`/`id`/`display_order` are
*stripped*. On the web side, five new `*.component.spec.ts` files (92 vendor cases): the
PUT-replaces regression, the duplicate-400 pivot **and its negative** (a `data_object` error with no
`claim_id` must not pivot), the unverified read-only state driven by `me.vendor.verified` rather
than an error, the vendor-frame direction cases including the `vendor_b`-only integration and a
no-`a_to_b` assertion, the collapsed-combobox-only Aria convention, and the notification list's four
states. `apps/web/e2e/vendor-dashboard.spec.ts` gains the tab's live axe pass and an
affirm→assert→clear round-trip against the real endpoints, backed by a claim seeded into
`apps/api/seed/phase2-fixtures.sql` (every environment had zero claims, so the tab rendered
correctly but empty). Suites green: `apps/api` 104 files / 1825 tests, `packages/shared` 26 / 458,
`apps/web` 134 component files / 1146 tests + 43 / 741 under plain vitest.

---

## 7. Detector + notification pipeline (AECI-302)

**Needs §2 and §4.** Turns conflict and staleness into outbound vendor nudges. **Email-only at
launch** (decision §1.3(4)); live in-portal delivery is AECI-516 — **transport resolved 2026-08-19**
as scoped client revalidation, not sockets (`STAGE_2_SPEC.md` §8.6 / ADR 0023 /
`STAGE_2_REALTIME_SPEC.md` §6.2). **Email remains primary**; the portal gains a faster read of the
same ledger, not a second channel.

### 7.1 Detectors

Run as one daily sweep. Each yields `(claim, recipient vendor, detector kind)`.

| Detector | Fires when |
|---|---|
| **silent-counterparty** | a claim sits at `single_source` for > N days — nudge the *silent* slot's vendor |
| **open-conflict** | a claim is at `conflict` for > N days, unresolved — nudge **both** vendors and raise it to AECi ops |
| **stale-version** | an attestation is older than N months with no version stamps, or its `deprecated_version` has passed — nudge the attesting vendor to re-confirm |
| **aeci-denied** | a vendor **denies** an AECi-seeded claim — this is a correction signal to **AECi**, not a vendor nudge; route it to the ops surface, since a denial-only claim renders `unverified` (§4.2) and would otherwise be invisible |

> **✅ `cross-grain` is DROPPED (resolved at build, AECI-302, 2026-08-17).** The callout below is
> kept because the reasoning is the decision. `STAGE_2_SPEC.md` §2.4 listed "cross-grain" as a
> fourth detector and `docs/DATA_OBJECT_VOCABULARY.md` §1 says cross-grain detection "keys off
> these terms" — but **no doc in this repo defined it**, and the external concept doc AECI-302
> cited (§4.5/§7) is not in the tree. The **proposed definition** was: because claims anchor to
> the *mechanism* row (`STAGE_1_5_SPEC.md` §3.1, ADR 0018), the same `data_object` between the
> same product **pair** can be claimed with contradictory directions through different mechanisms
> — the native connector says `a_to_b`, the Zapier app says `b_to_a` — so the *pair-level* picture
> is inconsistent while no individual claim is in `conflict`.
>
> **Why it was dropped rather than adopted:** that definition fires on legitimate data. Two
> mechanisms genuinely can move the same object in opposite directions — a native connector that
> pushes and a Zapier app that pulls is a true description of both, not a contradiction, and the
> pair page renders them as the separate mechanism lanes they are. The detector therefore has no
> false-positive floor, and a detector operators learn to ignore is worse than none. Recorded in
> §11 as an explicit deferral, not silently omitted. **Nothing undefined shipped** (the §7 AC).

**Every vendor-addressed finding on a connector-powered edge is dropped (AECI-705 / §14)**, by one
filter in `runAttestationDetectors` rather than four edits inside four detectors. The **ops-routed**
findings survive — `aeci-denied` entirely, and `open-conflict`'s AECi finding alongside its two
suppressed vendor nudges — because those are AECi's correction signal on its own curation, not a
nudge to a vendor who built nothing.

Thresholds (`N`) are launch-tunable constants, documented in `docs/POST_LAUNCH_MONITORING.md`
alongside the other tunables.

### 7.2 Delivery

- **Resend**, through `apps/api/src/lib/email.ts`, fail-open like every other send. New
  `EmailTemplate` ids (`attestation-silent-counterparty`, `attestation-open-conflict`,
  `attestation-stale-version`) added to the union **and** to the `docs/email.md` catalogue.
- **In-portal list** — `GET /api/vendor/notifications`, scoped to the caller's vendor, surfaced on
  the §6 tab. Reads the same ledger as §7.3; no separate store.
- Recipient is the vendor's seats (`profiles` with `role='vendor_admin'` + `vendor_id`), emails via
  the existing `fetchAuthUserEmails` seam (degrades to no-send without
  `SUPABASE_SERVICE_ROLE_KEY`).
- **No real-time in this epic.** The §2.3 / AECI-516 surfacing is additive later; nothing here
  assumes it. **As decided 2026-08-19** (ADR 0023 / `STAGE_2_REALTIME_SPEC.md`) that later work adds
  **no channel at all** — it re-reads *this* endpoint on a poll and renders new rows as a
  session-scoped count. So there is no push contract for this section to anticipate, and the
  `audit_log` ledger below stays the single source for both the email and the in-portal view.

### 7.3 Dedupe ledger — `audit_log`, no new table

A daily sweep must not re-nag daily. Suppression uses the existing `audit_log`:
`action: 'notification.sent'`, `entity_type: 'claim'`, `entity_id: <claim id>`,
`metadata: { detector, vendorId }`. Before sending, query the ledger for a matching row inside the
detector's suppression window; after a successful send, write one. This keeps the epic to two
migrations and gives the in-portal list its backing query for free.

### 7.4 Cron wiring

New daily trigger following ADR 0013 (cron enqueues, queue consumer runs). Add the constant to
`apps/api/src/scheduled.ts` and the **byte-equal** string to `triggers.crons` in
`apps/api/wrangler.jsonc` — for **every** env block that carries triggers, staging and production
both. Pick a slot that does not collide with the existing sweeps (04:00 data-quality, 06:00
moderation, 07:00 stats, 08:00 Algolia sync, 09:00 drift, `*/15` reconciliation, hourly WAF) — and
re-check against `main`, which has added crons since `stage-2` forked (§1.4). Emit a
metric per detector per run (`docs/OBSERVABILITY.md`), including the zero case, so the cron's
liveness is observable. **The zero case is not optional** — a failure-only series is empty on
healthy days, so anything watching it can never distinguish "nothing to detect" from "the cron
never ran". That distinction is why absence detection is a separate mechanism entirely: under
ADR 0024 it is an **external CI liveness sweep** (AECI-647), because PostHog has no
`notify_no_data` equivalent.

### 7.5 As built (AECI-302 — 2026-08-17)

**No migration** (the ledger is `audit_log`, as §7.3 designed), and `0007` stays reserved for the
`aeci-514` / `aeci-515` collision. Decisions taken at build that §7.1–§7.4 did not pre-specify:

- **Thresholds: silent-counterparty 14d, open-conflict 7d, stale-version 12mo, suppression 30d.**
  Exported constants in `apps/api/src/lib/attestation-detectors.ts` /
  `attestation-notify.ts`, documented in `docs/POST_LAUNCH_MONITORING.md` §3. `open-conflict` is
  the tightest because it is the lowest-volume, highest-signal state; `stale-version` is annual
  because **nothing in D1 carries version stamps** (AECI-607 shipped the columns, no backfill), so
  a 6-month N would turn the entire vendor corpus into re-confirm mail six months after the portal
  opens.
- **`cross-grain` dropped** — see the §7.1 callout for the reasoning, §11 for the deferral.
- **The sweep is near-free until vendors actually attest.** Every detector keys off a vendor's
  word, so the shared read pre-filters to claims carrying ≥1 live non-`aeci` attestation:
  `claim_id IN (SELECT claim_id FROM attestations WHERE retracted_at IS NULL AND source <> 'aeci')`.
  That is **zero rows** in every environment today (promote has only ever written `source='aeci'`;
  prod holds 951 claims / 951 attestations), so the job's cost scales with adoption rather than
  with catalog size. It is an `IN (SELECT …)` and not a fetch-ids-then-`inArray` round trip
  because **D1 caps bound parameters per query** — an id list would break silently once adoption
  outgrew the cap.
- **Where each detector measures age from, and why the two directions differ.**
  `silent-counterparty` measures from the **oldest** live affirmation (how long the claim has
  actually been one-sided; using the newest would let the *affirming* vendor's re-confirmation
  reset a clock the silent side never touched). `open-conflict` measures from the **newest** live
  vendor vote — the moment the disagreement came into being. **Both** of `stale-version`'s
  clauses (aged-and-stampless, and deprecation-has-passed) are restricted to **affirmations**: the
  re-confirm email describes the flow as one the vendor recorded, so chasing a denial would invert
  its position, and a denial of a flow that ended needs no re-confirming regardless. The
  deprecation clause additionally carries **no** age threshold — "the version this ended in is
  gone" is a fact, not a duration. Either way the vendor's remedy (retract or extend) removes the
  row from the detector, so it terminates rather than nagging forever.
- **`open-conflict` notifies the *attesting* vendors, not the slot occupants.** `conflict` means
  two identities took opposing positions and those identities are on the rows; a co-owner of the
  same product who never voted is not party to the dispute. An orphaned vote
  (`attested_by_vendor_id` nulled by `ON DELETE SET NULL`) has nobody to notify and is skipped —
  the ops finding still fires, which is precisely why §7.1 pairs the two.
- **`silent-counterparty` is silent in ~~two~~ THREE cases, all correct.** One company owning both
  endpoints affirms both slots → §4.5 collapses it to one voter, so the state *is* `single_source`
  but there is no silent slot and nobody to nudge. A silent product with no `product_vendors`
  row has no seat to email — that is AECi's outreach problem, not a nudge. And, **since AECI-705**,
  the edge is connector-powered, so the silent slot's vendor is silent about plumbing it did not
  build (§14.4). The third is the only one of the three enforced *outside* the detector.
- **`aeci-denied` uses `isClaimRefuted`, not an `unverified` check**, and excludes
  `origin = 'vendor'` claims: a vendor denying a claim it created itself is a self-correction the
  §5 retract path handles, not an error in AECi's curation.
- **The inverse slot→vendors lookup landed where §2.5 asked for it.**
  `vendorsForIntegrationSlots(db, integrationIds)` in `apps/api/src/lib/attestation-authority.ts`
  — a different query from the forward resolver (it has no vendor to filter on) but folded through
  the same `slotsForOwnership`, so the §2.1 table still has one implementation. The 404
  non-disclosure rule does not apply: a cron has no caller to disclose anything to, so an unowned
  endpoint is an empty slot rather than an error.
- **`liveAttestationsWhere` is now exported** from `lib/drizzle-helpers.ts` rather than restated —
  the detector read builds its own config (it does not want the pair page's render payload) but
  must apply the identical `retracted_at IS NULL` predicate.
- **Per-item ops emails, and a FOURTH template id.** §7.2 named three vendor ids; AECi-facing mail
  needs its own because the id *is* the `template:` metric tag and the `docs/email.md` catalogue
  key, and an ops alert is a different message to a different audience. So:
  `attestation-silent-counterparty`, `attestation-open-conflict`, `attestation-stale-version`
  (vendor prose, with the pair + portal links) plus **`attestation-ops-alert`** (operator
  `opsText`/`opsTable` format, naming the detector, one email per finding to `ADMIN_ALERT_EMAIL`).
- **The ledger metadata carries more than `{ detector, vendorId }`** — also `integrationId`,
  `dataObject`, `counterpartProduct` and `pairSlugs`. This is what makes §7.2's "gives the
  in-portal list its backing query for free" literally true: `GET /api/vendor/notifications`
  renders from the snapshot with **zero joins**, and a year-old notification stays legible after
  the claim it names has been re-curated or deleted.
- **A ledger row is written only after a successful send**, in `db.batch` chunks of 25. Chunked so
  a batch failure costs at most 25 suppressions (which re-send tomorrow) instead of the run's; and
  written *after*, never on attempt, because writing on attempt silently consumes a nudge — the
  failure nobody notices for a month. A missing `SUPABASE_SERVICE_ROLE_KEY` (so no resolvable seat
  address) is therefore `skipped` **with no ledger row**, not a silent success on a preview.
- **Banned seats are excluded** — `role='vendor_admin' AND vendor_id=? AND banned_at IS NULL`.
  Deliberately unlike `seatsOf` in `routes/vendor.ts`, which keeps banned seats on the roster so
  co-admins can see a colleague is locked out; a banned seat fails every `/api/vendor/*` call and
  so cannot act on a nudge.
- **`NOTIFY_BATCH_CAP = 200` sends per run**, ordered most-signal-first (open-conflict →
  aeci-denied → silent-counterparty → stale-version) so the cap drops the least urgent work, and
  **logging the dropped count** — no silent truncation. Suppression is applied *before*
  the cap so a suppressed backlog cannot starve findings that need sending.
- **Cron slot `0 10 * * *`** (10:00 UTC = 05:00 EST), last of the daily jobs so a nudge describes
  the state the site is serving. Verified free on this branch **and** on `main` (which has added
  00:15, 03:00 and 05:00 since `stage-2` forked). Queue-backed —
  `aeci-attestation-notify-{staging,demo,production}` + the `ATTESTATION_NOTIFY_QUEUE` binding,
  provisioned by the three deploy workflows — unlike the queue-less read-only gauges, because this
  job sends mail and writes D1. It is also the one job that **rethrows** on an unexpected failure,
  so the consumer retries: a sweep that never ran is a nudge nobody is ever told about, and the
  ledger makes the re-run idempotent for everything already delivered.
- **`GET /api/vendor/notifications` is the codebase's first production read of `audit_log`.**
  Everything else only ever wrote to it. `audit_log_action_idx (action, created_at)` carries the
  scan over a 90-day window (deliberately longer than the 30-day suppression window, so a vendor
  can see the nudge currently suppressing a repeat), capped at 50 rows; the vendor filter is a
  `json_extract` on unindexed `metadata`, which is a considered trade — indexing JSON needs a
  migration and a generated column, and the window already bounds the predicate. Not
  verified-gated (reading is not the capability). Ops rows store `vendorId: null`, so they can
  never match a caller — the isolation is structural, not a clause someone must remember. The
  mapper is tolerant: an unreadable snapshot is skipped, because these rows outlive the code that
  wrote them.
- **⚠️ Merge hazard for `stage-2` / `main`.** `main` carries
  `apps/api/src/lib/cron-schedules.ts` — a `CRON_SCHEDULES` / `ADMIN_CRON_JOB` registry with a
  spec that asserts **byte-equality against `wrangler.jsonc`**. That file does not exist on
  `aeci-514`. When this epic reaches `main`, the new cron must be registered there too (all three
  records plus the display-order array) or that spec fails.

**Test coverage:** `apps/api/src/lib/attestation-detectors.spec.ts` (27 — every detector with its
zero-result case, both threshold boundaries, the both-endpoints and orphaned-vote cases, the
aged-and-stampless denial carve-out, and the `origin='vendor'` carve-out),
`attestation-notify.spec.ts` (18 — the suppression window incl.
per-recipient and per-detector scoping, the Resend-outage and missing-key fail-open paths asserting
**no** ledger row, banned-seat exclusion, ops routing, the cap, and the always-emitted per-detector
gauge), `routes/vendor-notifications.spec.ts` (9 — shape, ordering, window, page cap, cross-vendor
and ops isolation, unreadable-snapshot degradation), plus the new endpoint added to
`routes/vendor.authz-matrix.spec.ts` (85), the inverse lookup in `lib/attestation-authority.spec.ts`
(25), the four templates in `lib/email.spec.ts` (39), and the cron/queue/ack/retry cells in
`scheduled.spec.ts` (27). Suites green: `apps/api` 76 files / 1084 tests, `packages/shared` 25 /
360.

---

## 8. Product-version model (AECI-607)

**Blocks §9.** Migration 2. This is the piece `STAGE_2_SPEC.md` §2.4 assumed was already dormant
in the schema and is not.

### 8.1 Why the dormant stamps are not enough

`introduced_at` / `deprecated_at` are plain ISO dates on an attestation. AECI-303 asks for
"per-product version selectors" and a "source-version × target-version" diff — that needs a
**version entity per product**, which exists nowhere in the schema. Dates cannot answer "what
flowed between Procore 2026.1 and BIM 360 v5"; only a version can.

### 8.2 Shape

`product_versions`:

| Column | Notes |
|---|---|
| `id` | UUID PK |
| `product_id` | → `products(id)` `ON DELETE CASCADE` |
| `label` | e.g. `2026.1`, `v5.2` — vendor-authored, free text |
| `released_at` / `sunset_at` | ISO date, nullable |
| `sort_key` | **INTEGER NOT NULL** — the load-bearing column |
| `created_at` / `updated_at` | conventions as elsewhere |

Indexes: unique `(product_id, label)`, plus `(product_id, sort_key)` for the ordered read.

> **`sort_key` is not optional.** Version labels do not sort lexically — `'2026.10' < '2026.9'` as
> strings, and `'v10' < 'v9'`. Every ordering, every "is this version before that one" comparison
> in §9, and the "latest" default all key off `sort_key`, never off `label` or `released_at`
> (which is nullable). The API must never expose an ordering derived from the label.

`attestations` gains `introduced_version_id` / `deprecated_version_id` → `product_versions(id)`
`ON DELETE SET NULL`, **alongside** the existing date stamps, which stay as the coarse fallback for
claims with no version data. **The referenced version always belongs to the attesting side's own
endpoint product** — a `vendor_a` attestation stamps versions of product A. That keeps versioning
inside the same authority boundary as §2.1, so no vendor can make claims about the counterparty's
release history.

### 8.3 Authoring

Vendor-authored only at launch: `/api/vendor/products/:id/versions` (CRUD), scoped by the same
ownership check `PATCH /api/vendor/products/:id` already uses — ownership proven first, miss is a
404. **Promote does not ingest versions** at launch: that would need an Airtable table, a
`claims[]` contract extension and a bamako change for a capability only Verified vendors can use
anyway. Recorded as a deferral (§10), not an oversight.

### 8.4 As built (AECI-607 — 2026-08-14)

Shipped as **migration 2 of two**: `apps/api/migrations/0022_slim_iron_lad.sql` (shipped as
`0008_*`, renumbered by AECI-619 — §1.4), plus the pure
ordering primitive `packages/shared/src/version-sort.ts`, the wire contract
`packages/shared/src/api/product-versions.ts`, the CRUD handlers
`apps/api/src/routes/vendor-product-versions.ts`, and a new shared guard seam
`apps/api/src/routes/vendor-shared.ts`. Constraint coverage lives in
`apps/api/src/test/d1.spec.ts` alongside §2.5's. `docs/DATABASE_SCHEMA.md` §5a.2/§5a.3,
`docs/API_CONTRACTS.md` §6.14, `docs/AUTH_AND_RLS.md` §4.4 and `docs/CACHE_STRATEGY.md` §5(b2) are
brought forward to match. Decisions taken at build that §8.1–§8.3 did not pre-specify:

- **The migration shipped as `0008`, and the gap was deliberate.** (It is `0017` now — AECI-619
  moved both of this epic's migrations to the end of the chain when `main`, already at `0015`,
  merged in. The reservation still did its job: nothing had to be squeezed into a gap.)
  `origin/aeci-514` and
  `origin/aeci-515` (Paid Tiers) each independently generated a **different** `0006_*.sql` —
  `0006_lyrical_leper_queen` here, `0006_easy_sandman` (`vendor_entitlements`, AECI-609) there.
  They collide when both epics merge to `stage-2` and whichever merges second must renumber;
  leaving `0007` free gives that reconciliation somewhere to land without touching this file.
  Verified that the gap is inert: `db:generate` still reports "No schema changes" (drizzle-kit
  reads `meta/_journal.json`, not the file sequence), `wrangler d1 migrations apply` applies in
  filename order, and the test harness sorts `*.sql`. **The `aeci-514`/`aeci-515` `0006` collision
  itself is unresolved and is not this issue's to fix.**
- **The two `ALTER`s are hand-authored — §2.5's finding reproduced exactly.** `drizzle-kit
  generate` emitted `ALTER TABLE attestations ADD introduced_version_id text REFERENCES
  product_versions(id)` with **no `ON DELETE` clause at all**, silently dropping the SET NULL §8.2
  specifies. Left as generated, SQLite's default RESTRICT would have made deleting a version
  *fail outright* rather than degrade the stamp. The `CREATE TABLE` + indexes are untouched
  generator output (`CREATE TABLE` does emit the full FK clause). The `d1.spec.ts` case
  "degrades an attestation version stamp to NULL on version delete" is the regression guard — it
  runs the real migration files, so a future regeneration silently reverting the clause fails CI.
- **`sort_key` is derived from the label, and overridable.** `deriveVersionSortKey` packs the first
  three numeric runs into one base-100000 integer — `2026.9` → 20_260_000_900_000, `2026.10` →
  20_260_001_000_000 — maxing out at `MAX_VERSION_SORT_KEY` (999,999,999,999,999), an order of
  magnitude under `Number.MAX_SAFE_INTEGER`, so the value survives JSON, D1's INTEGER column and JS
  arithmetic intact. Segments beyond the third are ignored and an oversized run clamps; both are
  lossy on purpose, since the alternative is a key that leaves the safe-integer range. A digit-free
  label (`'LTS'`, `'Fall release'`) derives **0**, which is why the create API accepts an explicit
  `sort_key` — the derivation is the default, not the rule.
- **The tiebreak is `created_at`, then `id` — never `label`.** Ties are legal (the unique index is
  on `(product_id, label)`, not `sort_key`, and every digit-free label derives 0), and §9's
  "previous version pair" needs a *total* order. Falling back to the label would reintroduce
  precisely the lexical ordering this section forbids; insertion order is arbitrary but honest.
  `compareProductVersions` and the SQL `ORDER BY` are the same rule written twice and say so.
- **`PATCH` never re-derives `sort_key` implicitly.** Changing `label` alone leaves the key where it
  is; explicit `sort_key: null` means "recompute from the (new) label"; a number sets it. A silent
  re-derive would discard a deliberate override the moment a vendor fixed a typo in a label. This
  is the only field on the `/api/vendor/*` surface where `null` means *recompute* rather than
  *clear*, and it is called out in the schema doc-comment for that reason.
- **Writes are Verified-gated; the read is not.** §8.3 named only the ownership check, but §1 makes
  authoring a Verified-vendor capability and versions exist solely to stamp attestations, so
  `POST`/`PATCH`/`DELETE` require `vendors.verified` (**403**) while `GET` needs only ownership —
  gating the read would 403 a vendor out of its own data instead of letting §6's tab render
  read-only and explain what verification unlocks. **Ownership (404) is evaluated before
  verification (403)**, so a non-owner never gets the 403 that would confirm the product exists.
  The check is `assertVerifiedVendor()`, deliberately ONE function with ONE call site per handler:
  it is a stand-in for `requireCapability('attestation.author')`, whose registry AECI-610 has
  already shipped on `aeci-515` (`@aeci/shared/entitlements` declares the id) and whose guard
  AECI-611 adds. Swapping it at the `stage-2` merge is mechanical. It **reads** `vendors.verified`
  and never writes it — `aeci-515` lints that column's writes down to the entitlement mirror.
- **A shared vendor-route seam was extracted, and §5 should build on it.**
  `routes/vendor-shared.ts` now owns `sessionVendorId` / `parseJsonBody` / `purgeTags` /
  `afterVendorWrite` / the audit source, plus `requireOwnedProduct()` — the **product-grain**
  counterpart to §2.3's integration-grain `resolveAttestationSlots()`. Same `product_vendors`
  source, same 404-never-403 property, different question; neither re-derives the other.
  `createUpdateVendorProductHandler` was refactored onto it so the ownership rule has exactly one
  implementation. `requireOwnedProduct` returns the caller's `vendors` row alongside the product
  precisely so the capability gate costs no extra D1 hop.
- **The purge is `product:{slug}` and nothing else.** The pair page embeds `product:{slug}` for
  both endpoints (`CACHE_STRATEGY.md` §3 rule 2), so one tag also drops every pair page the product
  appears on — where §9's selectors will render. `index:products` is omitted because versions never
  appear on the catalog. And `products.updated_at` is deliberately **not** stamped: versions do not
  feed the Algolia record, so bumping it would drag the product through the nightly sync for
  nothing — the exact inverse of the taxonomy-edit case, whose comment explains why the bump *is*
  mandatory there.
- **`errors.ts` gained a `product_version` resource kind** so the 404 envelope names the right
  thing. `audit_log.entity_type` needed nothing — it is deliberately unconstrained.
- **Duplicate labels are pre-checked, with the index as the backstop.**
  `product_versions_label_key` is the guarantee; the read before the batch exists so a vendor gets
  a `400` naming `label` instead of a constraint violation surfacing as a 500 — the same
  resolve-everything-that-can-fail-first discipline as taxonomy-term resolution.
- **Applied to remote `aeci-app-preview` by hand**, per `docs/migrations.md` §0 — CI still migrates
  staging/demo/production only.

---

## 9. Version-diff timeline + per-product selectors (AECI-303)

**Needs §8.** The reader-facing payoff, and the first concretely gateable paid capability.

### 9.1 The view

- Two selectors on the pair page — **context-product version × other-product version** — defaulting
  to **latest × latest**.
- For a selected version pair, each claim resolves to **added / removed / unchanged** relative to
  the previous version pair. Presence rule: a claim is present at (vA, vB) when, for each attesting
  side, `introduced_version.sort_key <= selected.sort_key` and (`deprecated_version` is null **or**
  `selected.sort_key < deprecated_version.sort_key`). **A claim with no version stamps is always
  present** — that is the Stage 1.5 baseline and it must not vanish from the default view.
- Per-claim timeline from the append-only attestation rows (§2.1 retract-then-insert + the version
  stamps).

### 9.2 Two things that are easy to miss

- **Cache key.** The selectors are **content-affecting URL params**, so they must be added to the
  pair route's `cacheKeyParams` in `apps/web/src/server-runtime.ts` — exactly as `?view` was for
  the Basic/Detailed toggle (`STAGE_1_5_SPEC.md` §8, `CACHE_STRATEGY.md` §4a). Omitting this
  serves one visitor's version selection to everyone.
- **SEO.** A non-default version selection must be **`noindex`** and canonicalise to the default
  pair URL. Otherwise every (vA × vB) combination is an indexable near-duplicate — a combinatorial
  explosion against the canonical discipline of `STAGE_1_5_SPEC.md` §7.3 / §11.2.

### 9.3 The entitlement seam (for AECI-304 / AECI-515)

The hard invariant from `STAGE_2_SPEC.md` §8.1(4): **the latest-version view — and the latest
conflict / single-source state — are always free and full-fidelity to readers.** Only the
*historical* diff depth is gateable.

Implement it as **one seam**, `canViewVersionDiff(...)`, consulted in the pair resolver and the API
— **not** as entitlement branches scattered through the render path (`STAGE_2_SPEC.md` §2.2:
"entitlements are data, not code branches scattered across the app"). Design checklist applies as
in §4.3.

**Built (AECI-304, 2026-08-19).** The seam no longer defaults to `true`: it forks on **the pair's
two endpoint vendors' tiers**, and historical depth is open when *either* holds
`'integration.version_diff'`. The `!historical → 'full'` early return is untouched and still runs
first, so the free latest view is decided before any entitlement is consulted. Exactly the two
consult sites AC5 fixed remain — `resolveDiffAccess` (`apps/api/src/lib/pair-version-diff.ts`) and
the web pair resolver's `gateHistoricalDepth` — asserted by `version-diff.consult-sites.spec.ts`.
Tiers are derived by `vendorTiersFromMirror` off `vendors.verified`, because
`STAGE_2_PAID_TIERS_SPEC.md` §2.5 forbids a public read path from querying the entitlement table;
the mirror exists precisely so reads do not have to. See the two resolved ⚠️ notes in §9.4.

### 9.4 As built (AECI-303 — 2026-08-18)

**No migration.** Every column already existed: `product_versions` and the two attestation FKs
landed with §8/AECI-607. The work is a pure read + render layer, plus one new public endpoint.

Shipped as the pure rule module `packages/shared/src/version-diff.ts` (reached as
`@aeci/shared/version-diff`), the row-shaped glue `apps/api/src/lib/pair-version-diff.ts`, the wire
additions in `packages/shared/src/api/product-pairs.ts`, the widened pair read + the new timeline
handler in `apps/api/src/routes/integrations.ts`, and on the web the selector component
`apps/web/src/app/products/pair-version-select.ts` plus changes to `products-pair.ts`,
`products-pair.resolver.ts`, `claim-provenance.ts`, `app.routes.ts` and `server-runtime.ts`.
`docs/API_CONTRACTS.md` §6.3/§6.14, `docs/CACHE_STRATEGY.md` §4a/§7.2, `docs/AUTH_AND_RLS.md` §4.4,
`docs/DATABASE_SCHEMA.md` and `docs/STAGE_1_5_SPEC.md` are brought forward to match.

Decisions taken at build that §9.1–§9.3 did not pre-specify:

- **The params carry a version LABEL, not an id** — `?context_version=2026.1&other_version=v5`.
  Labels are unique per product (`product_versions_label_key`), so they are a natural key, and the
  whole value of the feature is a link somebody sends a colleague. It also let the wire drop both
  `id` **and** `sort_key`: the browser has nothing to compare because the API resolved everything,
  and withholding `sort_key` is what structurally stops it re-deriving the ordering §8.2 forbids.
  Accepted cost: a rename rots an old link. It degrades to latest, and §9.2 keeps such URLs out of
  the index anyway. Names live in `@aeci/shared/version-diff` because **four** places across three
  packages must agree on the spelling — including the SSR Worker's `cacheKeyParams`, which cannot
  import them (it is the Worker entry) and so carries a literal, asserted in `cache-key-url.spec.ts`.
- **A bad label degrades to latest; it never 404s.** Unknown, renamed, empty, or over-60-char all
  resolve to latest, and `version_diff.selected` echoes what was actually used. A 404 would render
  the NotFound shell for a page that exists. Matching is exact and **case-sensitive** — the unique
  index has no `NOCASE` collation, so a case-insensitive match could be ambiguous, and ambiguity
  here silently shows a different diff.
- **"The previous version pair" steps each side back ONE release, independently** (§9.1 leaves it
  undefined). A side with no predecessor holds its current version; `null` when *neither* can step
  back, and then every present claim reads `unchanged` — the earliest pair is a baseline, not a wave
  of additions. Two rejected alternatives, both worth naming because both look reasonable:
  *step only the context side* breaks orientation symmetry (the same pair from its two URLs would
  compute different diffs from identical data), and *merge the two timelines and step back the
  globally-newer version* requires comparing `sort_key` **across products**, which is meaningless
  arithmetic that looks like it works — the key is packed from each product's own labels
  (Procore `2026.1` → 20_260_000_100_000, Revit `v5.2` → 50_000_200_000). A third option, walking
  back until the claim set actually differs so the diff is never a no-op, is nicer UX but O(|A|×|B|)
  and makes "added" mean "added at some unspecified earlier point"; noted, not built.
- **Presence compares through `compareProductVersions`, not raw `sort_key`.** §9.1 words the rule in
  terms of `sort_key <= sort_key`, which is the same thing whenever keys are distinct. The
  comparator is used anyway because ties are legal (the unique index is on `(product_id, label)`,
  and every digit-free label derives 0) and §8.4 records that the `created_at`/`id` tiebreak exists
  *precisely* so §9's previous-pair has a total order. One comparator, not two that agree by luck.
- **A claim present at NEITHER the selected nor the previous pair is dropped from the response.**
  The rule §9.1 omits, and without it a pair with a long release history renders every flow it ever
  had. `removed` claims (absent now, present before) DO render, struck through — and are excluded
  from `sync_headline`, because "N data objects sync" must not count a flow that has stopped. That
  filter sits at the single `computeSyncHeadline` call site rather than inside the shared engine,
  which stays a pure function of `{ agreement }` and owes the diff contract nothing.
- **The diff applies uniformly, INCLUDING at latest × latest** (confirmed with the PO). Once a vendor
  stamps a deprecation, that flow stops rendering as live on the free, indexable view and stops
  counting in the headline. §8.1(4) demands the latest view be *full-fidelity*, and rendering a flow
  the vendor says is gone is the opposite of fidelity. The alternative — diff only on non-default
  selections — would make the default the one place presence is not enforced.
- **`version_diff` is `null` unless a release exists AND a live attestation is stamped**, and that
  single null is the entire browser-side suppression rule: no selectors, no markers, no summary, no
  history affordance. Both facts are server-side only, which is what turns "renders identically to
  today" from a rendering discipline into a structural guarantee. A side with fewer than two
  releases additionally renders no selector — a one-option combobox is the no-op control `hasDetail`
  already exists to suppress, and a *disabled* control is worse than none.
- **`noindex` follows the RESPONSE, not the request** (`version_diff.is_default === false`). A stale
  or garbage label degrades to latest, so the page *serves* canonical content and marking it
  `noindex` would describe a page nobody is being shown; the already-query-stripped canonical
  dedupes the URL. More importantly it keeps `applyResolvedMeta` a pure function of the payload,
  which both resolver branches already call with nothing else — making SSR/client divergence
  **structurally** impossible rather than test-enforced. That is strictly stronger than the
  `taxonomy-browse.resolver.ts` precedent it follows, which has to keep `kind` in scope. The
  canonical itself needed no code: it was already orientation-normalised and query-stripped.
- **The route needs an explicit `runGuardsAndResolvers`, and it must be the PREDICATE form.**
  Angular's default policy is `paramsChange`, which its own typedoc says "does not include query
  parameters" — so copying the `?view` pattern verbatim gives selectors that rewrite the URL and
  refetch *nothing*, dead until a reload. `paramsOrQueryParamsChange` would fix that and regress
  `?view` into an API round trip on every Basic/Detailed toggle. The predicate fires only when a
  version selector moves. Both halves are pinned in `products-pair.spec.ts`.
- **A pre-existing TransferState orientation bug was fixed here** (in scope by the PO's call, since
  AECI-303 touches the same line). The key was `orientation-independent` (`{min}__{max}`) and the
  resolver's comment described the shared slot as a feature — but the payload is
  orientation-**dependent** (`context_product`/`other_product`, the context-relative `direction`,
  `attestor`), `TransferState.get()` never deletes, nothing clears the store after hydration, and
  only ONE of a pair's two URLs is SSR'd per document. So the shared slot could only ever produce a
  **false** hit, reachable in two clicks: SSR from revit, rail-link to `/products/procore`, then
  into the procore-context pair — path params changed, the resolver re-ran, `hasKey` was still true,
  and the page rendered the two products swapped relative to its URL. The key now carries every axis
  the payload depends on: `contextSlug|otherSlug` **in URL order**, plus the selection. Both
  regressions have their own test. `STAGE_1_5_SPEC.md` §11.2 (AECI-340, dual-orientation indexing)
  is the issue that would have surfaced this loudly; it inherits the fix.
- **The timeline is a separate, lazy, browser-only endpoint** — `GET
  …/integrations/:otherSlug/timeline` — not inline on the pair response. The decisive argument is
  the cache, not payload size: history is the gateable depth, and the pair page lands in a shared,
  URL-keyed 900s edge entry, so baking it in would break `STAGE_1_SPEC.md` §9.1a the moment AECI-304
  makes the gate visitor-dependent. An `/api/*` response is `private, no-store`, a legal home for
  per-reader content. It is also the only unbounded payload in the system. Pair-scoped rather than
  claim-scoped so one fetch serves every popover, which is why `ProductPairClaim` gained an
  `id` — exposing nothing new in kind, since `ProductPairMechanism.id` is already a UUID on the wire
  and AECI-604 guarantees claim ids survive a re-promote.
- **`integrationTimelineConfig` is the ONE read in the system that omits
  `liveAttestationsWhere`.** Retracted rows are the point. Its doc comment says so loudly and
  forbids calling `computeAgreement` on its output — routing history through the vote engine is
  exactly how a withdrawn assertion finds its way back into a tally, the hazard §2.5 handed to §4.
- **The seam clamps; it never 403s.** A 403 would make the gate a control-flow branch (§2.2 forbids
  that) and the SSR resolver treats a non-200 as the NotFound shell — so a shared historical link
  would cost the reader the **free** latest view, inverting §8.1(4). Gated ⇒ 200, selection clamped
  to latest, `previous: null`, no `version_status`, `diff_access: 'latest_only'`. The web renders a
  locked state from that one enum.
- **The seam lives in `version-diff.ts`, NOT `entitlements.ts`.** That path is already taken on
  `origin/aeci-515` by AECI-610, whose `CAPABILITIES` list already declares
  `'integration.version_diff'` — a same-path file would be a merge conflict at the `stage-2`
  reconciliation. The `!historical → 'full'` early return **is** §8.1(4) written as a labelled line
  of code; AECI-304 must replace only the line below it. Taking `historical` as an input, rather
  than asking the seam a bare entitlement question, is what makes the invariant
  unremovable-by-accident. `aeci-515` also adds a file-scoped `no-restricted-imports` for its
  zod-free domain modules; `version-diff.ts` was added to that rule at the merge — **done**, see the
  last bullet below.
- **AC5's "exactly two places" needed a wrapper.** Two API handlers need the access answer (the pair
  read, whose `historical` depends on the selection, and the timeline read, which is always
  history), so a direct call in each would make three. `resolveDiffAccess` in
  `lib/pair-version-diff.ts` is the sole `canViewVersionDiff` importer in `apps/api`; the web pair
  resolver is the other. The `assertVerifiedVendor` precedent — "ONE function with ONE call site per
  handler" — is a looser rule that would not have satisfied the literal AC.
- **✅ The cache constraint AECI-304 inherited — discharged by construction.** This note warned that
  the clamp was edge-cache-safe only while the seam returned a constant, and named three escape
  routes if it started depending on a cookie or session. **None were needed:** AECI-304 kept the
  gate **URL-derived.** The pair's two endpoint vendors are a function of the two product slugs in
  the URL, so a gated pair page is still storable in the shared, URL-keyed entry and still
  shareable — no cookie, no session, no `Cache-Control: private`, no new cache-key axis, and
  `cacheKeyParams` is unchanged. Invalidation needed nothing new either: an entitlement flip already
  purges `vendor:{slug}` for every product an entitled vendor owns
  (`apps/api/src/lib/vendor-cache-tags.ts`), and the pair route embeds both endpoints' `product:`
  tags (`apps/web/src/server/cache-tags.ts`). **The one place it still bites:** SSR `TransferState`
  is serialized into the cached document, so the gate must run **before** `transferState.set` —
  clamping after would ship the full payload inside the cached HTML.
- **✅ Whose entitlement is this? Resolved: the PAIR'S VENDORS, never the reader.**
  `entitlements.ts` puts `'integration.version_diff'` in the **vendor** tier ladder, §9.3 puts the
  seam in the **public reader** path, and `STAGE_2_SPEC.md` §8.1(4) says vendors pay, always —
  viewer-pays tooling is out of scope. Only one reading satisfies all three, and it is the one that
  shipped: historical depth opens when **either endpoint vendor of the pair** holds the capability.
  A reader never pays, is never identified, and is never asked to sign in. The weak
  `viewerTier: string | null` parameter is **gone** — the request carries **no viewer axis at all**,
  which is simultaneously the §8.1(4) guarantee and the reason the page stays cacheable.
  `VersionDiffRequest` now takes `{ historical, pairVendorTiers }`.
- **The zod-free lint rule landed.** `packages/shared/eslint.config.mjs` carries a
  `NO_ZOD_IN_VERSION_DIFF` block scoped to `src/version-diff.ts`, banning `zod` and `api/*` for the
  same reason as `entitlements.ts`: the module ships in the lazy product-pair route, and
  `api/product-pairs.ts` imports **from** it, so the dependency must stay one-way. See
  `ANGULAR_STYLE_GUIDE.md` §24 "Package-local guards".
- **The selector is the first SSR-rendered Angular Aria combobox in the repo**, and that forced one
  divergence from `admin-select.ts`: **static ids derived from the side, never a module counter.**
  Both existing instances carry `let nextId = 0`, justified in their own comments by being
  browser-only; module state persists per Worker isolate, so a counter would emit ids that differ
  between the server render and the client and break `aria-labelledby` after hydration. Verified
  live: two separate SSR requests emit identical `pair-version-trigger-{context,other}`, the listbox
  is **not** in the SSR payload (it lives inside `[cdkConnectedOverlayOpen]`), and the page hydrates
  with zero console errors. A shared `choice-select` extraction covering all three call sites is a
  real consolidation signal but needs its own issue.
- **No cookie counterpart to `aeci_pair_view`.** That cookie works because Basic/Detailed is a
  global, product-independent preference. A remembered `2026.1` is meaningless on another pair,
  §9.3's invariant is that a reader lands on the LATEST view, "latest × latest is the default" must
  track newly-published releases, and the cookie's cache-safety proof (written on click, read only
  post-hydration) would mean a **content** change plus a robots-tag flip *after* the crawler read
  the head.
- **Diff markers sit at the row START, never in the right-hand cluster.** Separation by position is
  what stops them competing with the agreement badge: left = what changed in this version, right =
  who agrees about it. `added` takes a Forest **start rule** (not the `--accent-primary-soft` wash,
  which is the `confirmed` chip's and would read as "confirmed" by proximity); `removed` takes a
  neutral strong rule plus a strikethrough and a step to `--text-secondary` — **never**
  `--status-error`, since `conflict` is the only red and a second one would collapse "vendors
  disagree" into "no longer supported". Clay is excluded on both counts. `unchanged` renders
  nothing, which is both the majority state and what keeps the default view byte-identical. Each
  state carries a glyph **and** a visible text label, so nothing is colour-only (WCAG 1.4.1).
- **No Mobbin anchor was picked, deliberately** — the same call §6's as-built recorded and the
  standing precedent for anchorless surfaces (`DESIGN.md` §"Named Rules"; the Phase 8.3 admin
  console). The pair page has three shipped layers and a settled chip/token vocabulary, which this
  surface inherits. **The Linear AC's phrase "the pair page's existing Mobbin anchor site" is not
  satisfiable as written** and should be amended to name the inherited vocabulary instead.
- **History dates are UTC-pinned**, per the `maintenance-marker` precedent. The stamps are date-only
  (`2026-01-15`, which `Date` parses as UTC midnight), so ambient-zone formatting would render
  **January 14** for every reader in the Americas *and* drift from the UTC SSR render. The version
  **label** is the primary token in each entry and the date a secondary clause, because the ordering
  axis is the version, never the nullable `released_at`.
- **The pair page had no row in the axe sweep at all** (`apps/web/e2e/phase2-a11y.spec.ts`), which is
  how the design checklist's axe step went unenforced in CI for the surface that owns the claim
  lanes. Added — and it passes, as does a dedicated `products-pair.spec.ts`. That file's interaction
  block is **self-skipping** on whether any pair has a stamped attestation (the `search.spec.ts`
  shape), because no environment has one; `apps/api/seed/version-diff-fixtures.sql` +
  `pnpm --filter @aeci/api db:seed:version-diff:local` is the reproducible local input that makes it
  run. It is deliberately NOT part of `db:seed:local` — every other pair page should keep showing
  the launch-reality default so a regression there stays visible.

---

## 10. Docs: attestation authz + API/schema contract sweep (AECI-608)

Runs alongside; finishes what each sub-issue seeds (the AECI-525 pattern).

- **`docs/AUTH_AND_RLS.md`** — ✅ **done by AECI-301**: the four `/api/vendor/claims*` rows are in
  the §4.4 endpoint table, and §4.2a carries the two-slot authority rule plus the claim-grain 404
  uniformity note. *(The four `/api/vendor/products/:id/versions` rows and the
  ownership-before-verified precedence landed with AECI-607 — §8.4; AECI-606 added the
  `/api/vendor/data-objects` row **and** the obligation-1 carve-out naming it as the one route with
  no `vendor_id` filter — §6.1.)* Verify rather than re-add.
- **`docs/API_CONTRACTS.md`** — ✅ **done by AECI-301**: the §5 endpoint shapes, Zod schemas and
  error codes are the §6.14 "Attestations" subsection. *(§8.3's landed with AECI-607, in the §6.14
  "Product versions" subsection; AECI-606 extended §6.14 with the `data-objects` route, its schemas
  and the source-of-truth handler list.)* Verify rather than re-add.
- **`DESIGN.md`** — ✅ **done by AECI-606**: the vendor portal had no §5 Components subsection at
  all, so the Anchor-Site Rule's own "record the anchor site with the surface" had never been
  satisfied for `/vendor`. §6.1 adds one, retro-recording the AECI-522 decision.
- **`docs/DATA_OBJECT_VOCABULARY.md`** — ✅ **done by AECI-606**: the vocabulary gained its first
  wire surface, so §1's consumer list, §2's governance note (it is now an exhaustive vendor-facing
  picker) and §3's settled `aliases` hedge are brought forward.
- **`docs/STAGE_2_VENDOR_PORTAL_SPEC.md`** — ✅ **done by AECI-606**: §6.1's component inventory and
  its "shared by both" clause are extended for the new tab.
- **`docs/TESTING_STRATEGY.md`** — ✅ **done by AECI-606**: §8.2's axe list gains the vendor
  dashboard, with the same authorized-session caveat `/admin/traffic` carries.
- **The §13 surfaces** — ✅ **done by AECI-616**, and listed here because §10 predates that section
  entirely (§13 was scoped in after kickoff): `DATABASE_SCHEMA.md` §4.1/§4.2/§4.3 for the
  `last_reviewed_at` + `maintained_by` columns and the three rules governing them,
  `REVIEW_APP_PROMOTE_API.md` §3.6 for the `lastReviewedAt` promote signal (absence = untouched),
  and `API_CONTRACTS.md` §6 for the `maintenance` object on the two detail responses.
- **`docs/DATABASE_SCHEMA.md`** — all **three** migrations (it trails `schema.ts`; bring it
  forward). *(§5a.2's provenance/authority columns landed with AECI-603, §5a.3 `product_versions`
  with AECI-607, §4.1/§4.2/§4.3's `last_reviewed_at` + `maintained_by` with AECI-616, and AECI-301
  added the writer/statement-order notes to §5a.1–§5a.2 and the `attestation.retracted` action to
  §8.4; verify rather than re-add.)* **AECI-608 closed the residue**: §8.4's consolidated
  action/`entity_type` lists were the one place enumerating every action, and they still named only
  `attestation.retracted` from this epic.
- **`docs/REVIEW_APP_PROMOTE_API.md`** — ✅ **done by AECI-604**: the replace-by-origin carve-out
  is **§5.2** ("`claims[]` replaces AECi curation only"), not the §3.3 this list originally
  guessed — §3.3 is the `product` request-body section. §3.6 additionally carries AECI-616's
  `lastReviewedAt` signal, and §4's `skipped[]` gained the `vendor-origin claim left untouched`
  reason. Verify rather than re-add.
- **`docs/CACHE_STRATEGY.md`** — ✅ **done.** The §5.2 attestation purge tag set landed with
  AECI-301 in §5(b2), alongside the AECI-607 version-write tag; the §9.2 `cacheKeyParams`
  addition landed with AECI-303 (the §4a pair row now carries `context_version` /
  `other_version`, plus the inverse `MULTI_VALUE_CACHE_KEY_PARAMS` rule and the §7.2
  URL-derived-`noindex` qualification). Verify rather than re-add.
- **`docs/email.md`** — ✅ **done by AECI-302**: §7.2's catalogue carries all four `attestation-*`
  template rows, and §9's `ADMIN_ALERT_EMAIL` row records that an unset address resolves those
  findings `skipped` (retried next sweep, no ledger row). Verify rather than re-add.
- **`docs/OBSERVABILITY.md`** + **`docs/POST_LAUNCH_MONITORING.md`** — ✅ **done by AECI-302** for
  the §7.4 detector metrics (§4's four `aeci.attestation.*` rows) and the launch-tunable thresholds
  (`POST_LAUNCH_MONITORING.md` §"Attestation detector tunables", every default matching its
  constant). **AECI-608 closed the residue**: the sweep became this system's **eleventh** cron, and
  `OBSERVABILITY.md`'s cron ↔ `job_runs` reconciliation table had no row for it — directly under a
  paragraph asserting "every cron emits both" as a reviewer-checkable invariant — while
  `POST_LAUNCH_MONITORING.md`'s `0 10 * * *` row was a cell short of its four-column table, so its
  monitor text rendered in the `job_runs.job` column. `ADMIN_PANEL_SPEC.md` said "ten crons" in
  four places; those too.
- **`docs/STAGE_1_5_SPEC.md`** §10 — mark the carve-outs activated, pointing at this doc.
  **AECI-608**: AECI-303 was marked shipped by its own issue; AECI-301 and AECI-302 were not, and
  the §3.3 `retracted_at` correction still read as future tense after `0016` landed it.
- **`docs/STAGE_2_SPEC.md`** §2.4 + **`docs/STAGE_1_SPEC.md`** §16 — **AECI-608**, outside the
  issue's original list. §2.4's bullet list still read AECI-301/302/303 as future work, and
  `STAGE_1_SPEC.md` carried the last unqualified "vendor attestations light up … with no migration".
  The acceptance criterion is worded doc-wide, so scope followed it rather than the list.

### 10.1 As built (AECI-608 — 2026-08-18)

**The sweep was mostly a verification, and that is the finding.** The AECI-525 pattern held: every
doc in the list above except `DATABASE_SCHEMA.md` §8.4 had already been brought forward by the
sub-issue that made it stale. `AUTH_AND_RLS.md` §4.4 carries all thirteen `/api/vendor/*` rows;
`API_CONTRACTS.md` §6.14 carries the attestation, version and `data-objects` shapes;
`CACHE_STRATEGY.md`, `email.md`, `OBSERVABILITY.md`'s metric catalogue and
`POST_LAUNCH_MONITORING.md`'s tunables all match their constants. Those were re-read against the
files they cite and left untouched. **Proving that is the deliverable**, and it is worth stating
plainly so the next epic's sweep budgets for verification rather than rewriting.

Four things it did change, and one of them was not a doc:

1. **A live code defect** — `apps/api/src/lib/admin-catalog.ts` computed the admin panel's
   `claims_with_active_attestation` as `deprecated_at IS NULL`: the exact conflation §1.2's ⚠️
   callout forbids, left behind when `0016` moved `attestations_active_idx` onto `retracted_at`.
   Inert while every attestation in D1 was `source='aeci'` — wrong the first time a vendor either
   retracts (coverage over-counts) or stamps the release that deprecated a flow (under-counts).
   Swapped onto the shared `liveAttestationsWhere`, with a regression test for the *inverse* case
   (deprecated-but-not-retracted still counts) that fails under the old predicate. **This is what
   makes `DATABASE_SCHEMA.md` §5a.2's flat claim "Nothing reads `deprecated_at` as a gate" true** —
   it was false when written, by one call site. Documenting the deviation instead would have meant
   weakening a correct invariant in a second doc, which is the wrong direction.
2. **§8.4's consolidated audit lists.** They named only `attestation.retracted` from this epic and
   were missing `product_version.created`/`.updated`/`.deleted` (§8), `claim.converted` (§3) and
   `notification.sent` (§7.3), plus the `product_version` `entity_type`. Each action *was*
   documented in its topical home — `API_CONTRACTS.md`, `AUTH_AND_RLS.md`, here — so the gap was
   narrower than "undocumented": §8.4 is the one place that enumerates them all, and a consolidated
   list that silently omits four is worse than no list.
3. **The eleventh cron.** §7's sweep became a first-class `AdminCronJob` (§1.4), which made four
   "ten crons" claims in `ADMIN_PANEL_SPEC.md` wrong and left two tables in a state their own prose
   contradicted — see the `OBSERVABILITY.md` bullet above. Neither was caught by review because
   neither doc is on this epic's scope list; the epic still made them stale.
4. **This doc.** §1.2's heading said "two deliberate migrations" against three shipped, §1.5's line
   anchors had drifted by ~150 lines (the AECI-619 reconciliation inserting `main`'s tables, not
   anything moving), and §10 above listed the promote carve-out as "still open" pointing at a §3.3
   that was never where it landed.

**The one generalizable lesson.** Three of the four items are *cross-doc* staleness — a doc nobody
on the issue thought to open. The sub-issue pattern reliably updates the doc a change is *about*;
it does not catch the doc that merely *counts* things (`ten crons`, `two migrations`) or the
consolidated list that enumerates them. Grep for the artifact across `**/*.md`, not for the topic.

---

## 11. Out of scope / deferred

- **Live in-portal notification delivery** — AECI-516. §7 ships email + the in-portal list only.
  **Transport resolved 2026-08-19** (`STAGE_2_SPEC.md` §8.6 / ADR 0023 /
  `docs/STAGE_2_REALTIME_SPEC.md`, decomposed into AECI-626…632): **scoped client revalidation**
  over a per-vendor freshness cursor, **not** Durable-Object WebSockets or SSE. The follow-on epic
  adds no delivery channel — it polls a cursor whose `notifications` scope reuses **this** section's
  exact `audit_log` predicate (`routes/vendor-notifications.ts:132-140`) and refetches the same
  endpoint. **Email stays primary**, and new rows surface as a session-scoped count rather than a
  banner, for the reason `vendor-notifications-list.ts:11-26` argues: these rows are the history of
  a nudge that was sent, not a claim's current state.
- **The `cross-grain` detector** — **dropped at build** (AECI-302; see the §7.1 callout). The only
  definition ever proposed — contradictory directions for one `data_object` across different
  mechanism rows on the same product pair — describes legitimate data, since two mechanisms
  genuinely can move the same object in opposite directions. Reviving it needs a definition with a
  false-positive floor, not just a query. *(AECI-608: the two docs that referenced it without
  defining it now record the drop — `STAGE_2_SPEC.md` §2.4 names it as the dropped fifth detector,
  and `DATA_OBJECT_VOCABULARY.md` §1 no longer lists it as a consumer of the vocabulary. This
  bullet previously said both "reference it", which stopped being the useful statement once the
  decision was final.)*
- ~~**Paywall *enforcement*** — AECI-304 under the Paid Tiers epic (AECI-515). §9.3 ships the seam,
  not the gate.~~ **SHIPPED 2026-08-19.** §9.3 shipped the seam and AECI-303 unblocked the gate, so
  AECI-304 landed on the `aeci-515` branch: `canViewVersionDiff` forks on the **pair's endpoint
  vendors' tiers**, never the reader's, at the same two consult sites. Both §9.4 ⚠️ notes are
  resolved there. The free latest view, the never-paywalled dispute, and the visible labeling of
  one-sided states are unchanged.
- **Promote ingest of version stamps / `product_versions`** — §8.3; vendor-authored only at launch.
- **Per-pair Algolia records / claims in the search index** — still deferred
  (`STAGE_1_5_SPEC.md` §9); attestation state does not reach search in this epic.
- **Self-serve seat invite/revoke**, **dark theme**, **a public/partner write API** — unchanged
  deferrals from `STAGE_2_VENDOR_PORTAL_SPEC.md` §11 and `STAGE_2_SPEC.md` §9.
- **A `powered_by`-vendor attestation seat** — the connector's own voice on the edges it delivers.
  AECI-705 (§14) gates endpoint vendors off those edges precisely *because* no such seat exists; it
  deliberately does not invent one. Owned by **AECI-704** / `STAGE_2_SPEC.md` §8.8(2), and bounded by
  two constraints: `vendors.verified` mirrors off `vendor_entitlements.status` rather than `tier`, so
  "a seat but no badge" is not expressible through the entitlement table as built; and a per-edge
  operator override — for the ~10 edges an endpoint vendor genuinely built on an iPaaS, which §14.2's
  union over-includes on purpose — is a separate, untracked opportunity rather than part of the seat.
- **Trust scoring / weighting attestations by vendor reputation** — Stage 3.

---

## 12. Cross-references

| Topic | Doc |
|---|---|
| Claim/attestation model, direction encoding, `computeAgreement`, the sync headline | `STAGE_1_5_SPEC.md` §3 (+ ADR 0018) |
| Vendor authz seam, `requireVendor()`, the 404-not-403 rule, seat/ban model | `STAGE_2_VENDOR_PORTAL_SPEC.md` §4 / §7; `AUTH_AND_RLS.md` |
| Stage 2 scope, the epic map, decisions | `STAGE_2_SPEC.md` §2.4, §7, §8.4 |
| `data_object` closed vocabulary + find-only resolution | `DATA_OBJECT_VOCABULARY.md` |
| Promote contract + merge-by-replacement semantics | `REVIEW_APP_PROMOTE_API.md` |
| Cache-Tag vocabulary, TTLs, `cacheKeyParams` | `CACHE_STRATEGY.md` (+ ADR 0020) |
| Transactional email | `email.md` |
| Cron → queue → consumer | ADR 0013; `apps/api/src/scheduled.ts` |
| Migration workflow (drizzle-kit + `wrangler d1`) | `migrations.md` |
| Branch model (post-launch `main` / `stage-2`) | ADR 0019; `CICD_PLAN.md` §10 |
| Connector lane, `product_role`, the powered hub, who pays | `STAGE_1_5_SPEC.md` §12 Addendum B; `STAGE_2_SPEC.md` §8.8 |

---

*This is the build contract for AECI-514. As each sub-issue lands, keep this doc current with the
code (per the "update all documents" rule) and add an "As built" subsection under its anchor — the
file/line references in §1.5 are anchors, not guarantees; verify them before editing the cited
files.*

---

## 13. Maintenance marker — real `last_reviewed_at` + the vendor branch (AECI-616)

> Numbered §13 rather than §11 because §11/§12 were already taken when this landed, and §1.1's
> anchors are load-bearing (they are what the Linear issues cite). The issue's own
> `**Spec section:** §2.4 (docs/STAGE_2_SPEC.md)` line predates this section; §2.4 defers the whole
> pillar here, and this is where the contract lives.

Stage 1 shipped the marker component to `main` as **attribution only** — `Maintained by AEC
Integrations.` on product detail, vendor detail, and the pair page, mounted with no inputs at all.
The component already contains both dormant branches (the `Reviewed <date>.` clause and the
`Vendor-maintained.` branch, UTC-pinned). This issue is the **data + plumbing** that reaches them.

### 13.1 Why the date was withheld, and why that reasoning is the spec

The tempting source, `products.updated_at`, is unusable on two counts, and the reasoning generalises
to `created_at` and `promoted_at`:

1. It is declared `.$onUpdate(...)` in `schema.ts`, so **any** write restamps it.
2. Promote re-asserts `promotion_status: 'promoted'` on every re-promote, and `product.updated`
   outnumbers `product.created` roughly 2.7:1.

Production settles it: as of 2026-08-17, **60 products share a single `updated_at` day, 40 share
another, 26 a third.** That is a bulk-sweep timestamp, not a review timestamp. A date that refreshes
itself without anyone re-checking the record is worse than no date, because readers believe it —
and a marker whose entire purpose is to be a falsifiable claim cannot be built on one.

Hence the two hard rules, which are constraints and not preferences:

- **`last_reviewed_at` is a plain column.** No `$defaultFn`, and above all **no `$onUpdate`**.
- **No backfill, ever.** Migration `0023` (shipped as `0018`) carries no backfill statement. Existing rows stay `NULL`
  and render bare attribution. Seeding them from any existing timestamp would manufacture exactly
  the fake freshness the feature exists to expose.

### 13.2 Schema (migration 3)

| Table | Change |
|---|---|
| `vendors` / `products` / `integrations` | `+ last_reviewed_at TEXT NULL` — plain, no `$onUpdate` |
| `vendors` / `products` / `integrations` | `+ maintained_by TEXT NOT NULL DEFAULT 'aeci'` CHECK `IN ('aeci','vendor')` |

`vendors` is included even though the issue named only `products` / `integrations`: the marker
renders on vendor detail too, and the issue asks for the vendor read path to be threaded. Neither
column is indexed — both are read with the row.

### 13.3 Who writes what

| Column | Written by | Never written by |
|---|---|---|
| `last_reviewed_at` | `lastReviewedAt` in the promote payload (`REVIEW_APP_PROMOTE_API.md` §3.6); a vendor attestation (§5) | anything else — no default, no trigger, no derivation |
| `maintained_by` | the §5 vendor attestation path only | **promote** — the payload does not accept it |

**Absence is the contract.** The promote projections run through `compact()`, which drops
`undefined`, so omitting `lastReviewedAt` leaves the stored value untouched on both the insert and
update branches. That is what makes a plain re-promote a no-op for the marker, and it is why the
field is a caller-supplied timestamp rather than a server-side `now()`: a `now()` stamp would
advance on replay, and Workflows are at-least-once.

**`maintained_by` is excluded from promote deliberately**, for the reason AECI-520 excluded
`verified` and AECI-604 stopped wholesale claim replacement: a routine Airtable push must not be
able to take a record back off a vendor's name.

### 13.4 The vendor branch

`integrations.maintained_by` flips in `apps/api/src/routes/vendor-attestations.ts`, always inside
the **same `db.batch`** as the attestation mutation, each flip carrying its own `integration.updated`
audit row (§26.1):

- **→ `'vendor'`**, unconditionally, on claim-create and attestation-upsert, together with
  `last_reviewed_at = now`. Unconditional because even a repeat assertion IS a review — that is the
  event the date records.
- **→ `'aeci'`**, conditionally, on retract: only when no live vendor attestation survives **anywhere
  on the integration**. The check is integration-grain, not claim-grain (`hasLiveVendorAttestation`),
  because retracting one claim's attestation must not un-vendor an integration the vendor still
  speaks for through nine others. Returning `null` when the flip is a no-op is what keeps the batch
  from carrying an audit row for a state change that did not happen.
- **`last_reviewed_at` is never cleared on retraction.** Withdrawing an assertion does not un-happen
  the review; blanking the date would make a record that HAS been checked read as one that never was.

`AttestationAuthority` carries `maintainedBy` alongside the two endpoint ids, for the same reason
§2.5 gives for those: the write paths need it and must not pay a second D1 hop.

### 13.5 Read path

`MaintenanceSchema` (`packages/shared/src/api/common.ts`) is `{ maintained_by, last_reviewed_at }`,
carried as a `maintenance` object on `ProductDetail`, `VendorDetail`, and `ProductPairResponse`.
Both fields carry `.default(...)` for the **same reason `SyncHeadlineSchema.single_source` does**
(§4.3): SSR and API deploy per-commit but not atomically.

The pair page is the interesting one — N mechanisms, one header marker. `computePairMaintenance`
(`drizzle-helpers.ts`) folds them:

- `maintained_by` is `'vendor'` if **any** mechanism is. A page carrying even one vendor-authored
  mechanism is no longer purely AECi's word.
- the date is the max **within the winning branch only**. A global max would let an AECi mechanism
  reviewed in July supply the date for a header reading `Vendor-maintained. Updated <date>.` —
  attributing AECi's review to the vendor. Scoping keeps both halves of the sentence about the same
  records.

### 13.6 The marker and the agreement pill coexist

They answer different questions at different grains and both render: the marker is a **page-header**
attribution ("who is on the hook for this page"), the `Unverified · AECi` pill is **per claim**, on
the mechanism cards ("do the two vendors agree about this one `data_object`"). `DESIGN.md` already
keeps their shapes distinct — the marker and the pill are both `rounded.sm` chips, and the
`rounded-full` pill is reserved for `aec-verified-badge`, which means a third thing again (an
AECi-verified vendor *account*). Merging them would collapse three separate signals into one.

### 13.7 Acceptance

- [x] `last_reviewed_at` + `maintained_by` on `vendors` / `products` / `integrations`; neither uses
      `$onUpdate`.
- [x] A re-promote carrying no review signal leaves `last_reviewed_at` byte-stable while
      `updated_at` moves (`promote.spec.ts`).
- [x] A promote carrying the signal advances it on all three entities.
- [x] Promote cannot write `maintained_by`.
- [x] The marker renders a date only for records that have one.
- [x] No migration backfills `last_reviewed_at` from any existing timestamp column.
- [x] `DATABASE_SCHEMA.md`, `REVIEW_APP_PROMOTE_API.md`, `STAGE_2_SPEC.md` §2.4, `API_CONTRACTS.md`,
      `DESIGN.md`, and `CLAUDE.md` updated.

### 13.8 As built (AECI-616 — 2026-08-18)

Shipped as **migration 3 of three**: `apps/api/migrations/0023_chilly_joseph.sql`. Decisions taken
at build that this section did not pre-specify:

- **The migration body is hand-authored, and the issue's own note was wrong about why it had to be.**
  AECI-616 said a `check()` "triggers a drizzle-kit table recreate on D1… At 176 products / 515
  integrations that is survivable." It is not. The generated SQL was inspected before applying, as
  the issue advised, and it does three fatal things: its `INSERT…SELECT` reads `last_reviewed_at` /
  `maintained_by` **from the pre-migration table**, where they do not exist; `DROP TABLE products`
  fires `integrations.source_product_id`/`target_product_id` `ON DELETE CASCADE`, which would delete
  **every integration in the database**; and `DROP TABLE vendors` likewise reaches
  `claims.created_by_vendor_id` and `attestations.attested_by_vendor_id`. D1 does not honour the
  `PRAGMA foreign_keys=OFF` guard drizzle-kit wraps the drop in. Replaced with six additive `ALTER`s
  in the `0016` form; `db:generate` re-runs clean and drift-check passes.
- **`vendors` got the columns too**, on the same reasoning as §13.2 — the issue's scope named only
  two tables but asked for three read paths.
- **The review signal is a caller-supplied timestamp, not a boolean.** A `reviewed: true` flag
  stamping `now()` server-side would advance on a Workflow replay (at-least-once) and on any retry,
  re-manufacturing the freshness this feature exists to prevent. The timestamp is idempotent: the
  same payload written twice produces the same value.
- **Validation is stricter here than the rest of the promote contract.** URL-ish and version-stamp
  fields stay loose strings because over-strict validation would reject legitimate curated values.
  This field gets a parseability `refine`, because an unparseable value renders as *no date* and is
  then indistinguishable from "never reviewed" — a silent failure, which a 400 is strictly better
  than.
- **The audit row for a flip is `integration.updated`, not a new action.** `maintained_by` is
  catalog state on an existing entity (ADR 0022), so it uses the existing vocabulary with
  `metadata.reason = 'maintenance-marker'` to make the cause greppable.
- **Two pre-existing specs were updated, not worked around.** `POST /api/vendor/claims` and the
  supersede path both assert their batch's exact audit-action set; each now legitimately carries an
  extra `integration.updated`. Cache invalidation needed no change — `attestationEditTags` already
  purges the pair tag plus both `product:` tags.
- **No `preserved[]` / `skipped[]` entry for the untouched timestamp.** Leaving `last_reviewed_at`
  alone is the *normal* path for essentially every promote, not an exception worth reporting; a
  receipt would fire on every push and mean nothing.

**Test coverage:** `promote.spec.ts` (re-promote stability, advance-on-signal, promote-can't-write-
`maintained_by`), `d1.spec.ts` (the three CHECKs against the real migration, the ADD-COLUMN default,
and a no-`$onUpdate` regression), `vendor-attestations.spec.ts` (8 cases: both flip directions,
integration-grain vs claim-grain, counterparty survival, the no-op-no-audit rule),
`product-pair.spec.ts` (5 aggregate cases including the branch-scoped date), `products.spec.ts` /
`vendors.spec.ts` (detail surfaces), and `packages/shared` (`lastReviewedAt` validation).

---

## 14. Connector-powered edges are not attestable (AECI-705)

> Numbered §14 for the same reason §13 is numbered §13 — §11/§12 were taken and §1.1's anchors are
> what the Linear issues cite. AECI-705's own `**Spec section:** §2.4 (docs/STAGE_2_SPEC.md)` line
> predates this doc; §2.4 defers the whole pillar here, and this is where the contract lives.
>
> **This is a review-and-gate pass over a shipped epic, not a rebuild.** No migration, no new
> endpoint, no new binding or cron, no change to `computeAgreement` or to any public render path.

### 14.1 The gap

§2.1 derives attestation authority from `product_vendors` on the edge's `source_product_id` /
`target_product_id`, and §4.2 makes `confirmed` require two *distinct* vendor identities. Both
presume the edge has **two accountable endpoint vendors**. On a **connector-powered** edge it does
not: Zapier, Workato or Agave built the plumbing, the connector holds no attestation seat, and the
endpoint vendor's honest answer is "not ours". `STAGE_2_SPEC.md` §8.8(5) records the same gap from
the commercial side and names this issue as its owner.

Opening the portal without a rule fails in two directions at once:

- **False prompts.** `silent-counterparty` (§7.1) emails an endpoint vendor asking it to confirm a
  Zapier connection it never wrote, and the tab's own summary line counts that claim as "waiting on
  your confirmation".
- **Rendered conflicts on true facts.** An endpoint vendor denying a real connector-powered edge
  drops the claim from the product-detail direction column (`isClaimRefuted`, §4.5) and fires the
  `aeci-denied` ops signal against curation that was correct.

**Acceptance:** no vendor is ever prompted to confirm or deny plumbing it did not build, and powered
edges render the AECi-curated state unchanged.

### 14.2 The predicate — a union, and why neither half alone

```ts
// apps/api/src/lib/connector-powered.ts
isConnectorPoweredEdge({ poweredByProductId, mechanismKind })
  === (poweredByProductId !== null || ['iPaaS', 'integrator'].includes(mechanismKind))
```

Two columns describe connector delivery and **nothing cross-validates them**:
`integrations.mechanism_kind` is a property of the **edge**, `products.product_role` a property of
the **product**, and `powered_by_product_id` is the only link between them. Measured against
**production D1 on 2026-08-31** (946 edges):

| predicate | edges | share |
|---|---|---|
| `powered_by_product_id IS NOT NULL` | 79 | 8.4% |
| `mechanism_kind = 'iPaaS'` | 114 | 12.1% |
| both | 61 | 6.4% |
| **union — the rule** | **132** | **14.0%** |

- **53 edges are `iPaaS` with a NULL FK** — Zapier (23), Workato, n8n, Make, Boomi, Trimble
  AppXchange. The FK is NULL because the review app only sends `poweredByProduct` once the connector
  is itself a promoted product, and these are not. **AECI-706's sweep puts `backfillable` at 0**: the
  gap is promotion coverage blocked on the `on_hold` connector decision, not a data defect any script
  can repair. An FK-only gate — which is what AECI-705's scope line proposed — would therefore keep
  prompting on exactly the edges where "we didn't build it" is least arguable, and would keep doing
  it indefinitely.
- **18 edges carry the FK but are typed `marketplace-app` (17) or `partner` (1).** All 79 FK targets
  are `product_role` `connector` (77) or `hybrid` (2), so those are provably connector-powered
  whatever the edge is typed. An `iPaaS`-only gate misses every one.

**The union over-includes, deliberately.** Roughly ten edges are an endpoint vendor's own product
built on an iPaaS (Autodesk's Forma Construction Connect on Workato); those vendors lose an
attestation they could legitimately have made. That is the accepted direction: over-inclusion costs
coverage, under-inclusion breaks the acceptance criterion. It is the same fail-safe choice §4.5 made
when it resolved a self-contradicting voter to `unverified` rather than guessing.

**`integrator` joined the kind disjunct in AECI-721, before it had a single row.** AECI-698 defines
it as *"an SI/consultancy built and maintains it, **neither vendor did**"* — this predicate's
question, word for word — and such an edge carries no `powered_by` by definition, because there is no
connector platform to name. So it would fall through both halves. It was added in the same change
that added the value to the enums rather than afterwards: the day the review app promotes its ~117
re-keyed `partner` rows (AECI-712), an unguarded gate starts asking endpoint vendors to confirm work
an integrator did. The app-DB CHECK has accepted `integrator` since
`0027_powerful_killraven.sql`; only the upstream re-key is outstanding. Zero impact on the numbers
above; correct at re-key time.

**The `iPaaS` disjunct is PERMANENT (AECI-735).** It reads as a transitional accommodation for
edges whose FK has not been backfilled yet, and it is not one. Those 53 edges cannot acquire the FK
— `connector_evidenced_pairs.connector_product_id` is NOT NULL and AECI-700 parks Zapier and Workato
indefinitely — so AECI-735 asked whether `iPaaS` could leave the mechanism vocabulary now that the
connector lane has its own tables, and closed it as **no**. There is no replacement marker short of a
new `integrations` column. This predicate has a sibling that reads the same value for the same
population: `routeIntegrationLane` clause (c) in
`apps/web/src/app/products/connector-lane-grouping.ts`, which keeps those edges on the product page's
"Via" lane. The two change together or not at all.

**`partner` is deliberately NOT in the disjunct.** It is the dumping ground AECI-698 exists to empty
— a sample of six held a Concur app-center listing, a Procore support tutorial and a partnerpage.io
directory entry — so treating it as third-party delivery would suppress attestation on 55 production
edges an endpoint vendor may well have built. Those rows earn `integrator`, or `native`, or
`marketplace-app`, one at a time, upstream, under the rubric. They do not inherit it by proximity.

**AECI-721 also shrinks the FK disjunct's population, without changing the rule.** 19 of the 79
FK-carrying prod edges leave `integrations` for `connector_evidenced_pairs`, so they stop reaching
this predicate at all — an evidenced pair is structurally connector-delivered and has no attestation
seat to gate. The 60 that remain are Convention-A self-references (Aquifer 31, Kroo 29), which keep
their `powered_by` and keep matching here.

**There is no SQL form of the predicate, and that is deliberate.** Every caller already holds the
integration row, so nothing filters *on* it in a `WHERE`. Two forms of one rule is how the direction
helpers drifted once already (`STAGE_1_5_SPEC.md` §7.1), and a SQL form would invite folding this
into `ownedEndpointJoin` — which is the exact predicate the AECI-627 freshness cursor must match
(`STAGE_2_REALTIME_SPEC.md` §2.2). **Ownership and attestability are separate questions and stay
separate.**

### 14.3 The write gate

`AttestationAuthority` (§2.3) gains `poweredByProductId` / `mechanismKind`, carried for the same
reason the two endpoint ids and `maintainedBy` already are: every §5 caller needs them immediately,
and re-reading the integration row would be a second D1 hop on the Worker.

`assertAttestableEdge(authority)` in `routes/vendor-attestations.ts` throws **403 `FORBIDDEN`**:

| Endpoint | Gated? |
|---|---|
| `POST /api/vendor/claims` | **yes** |
| `PUT /api/vendor/claims/:claimId/attestation` | **yes** |
| `DELETE /api/vendor/claims/:claimId/attestation` | **no — see below** |
| `GET /api/vendor/integrations` | no; rows are flagged, not filtered (§14.5) |

Three properties of that table are load-bearing.

1. **403, not the 404 §2.1 returns.** The non-disclosure rule exists so a vendor cannot probe for
   another vendor's integration — but by the time this runs the caller has already proven it owns an
   endpoint, and powered-ness is public on the pair page. There is nothing left to conceal, and a 404
   would be a lie the caller can disprove by loading its own page. It reuses the existing `FORBIDDEN`
   code rather than minting a new one: the portal already knows from `attestable: false`, so the 403
   is a backstop for direct API callers and a new code would cost an `API_CONTRACTS.md` §4 row for no
   reader.
2. **The order is authority → 404, powered → 403, verified → 403.** Reversed, an unverified vendor on
   a powered edge is told to get verified in order to author — a promise verification will never
   keep, because the edge stays closed to it afterwards. The copy points at the connector and never
   at verification, ranking or placement (§5.2).
3. **`DELETE` stays open.** An edge can *become* powered after a vendor has attested: promote sets
   `powered_by_product_id` late, and AECI-706's `backfill.sh` writes it onto rows that already exist.
   Gating retract would trap a vendor holding a position it can no longer withdraw, which is a worse
   failure than the one the gate prevents. **Withdrawing is always allowed; only taking a new
   position is not.**

### 14.4 The prompt gate — one filter, at the registry

`loadDetectorClaims` (§7) hydrates the two columns, and `runAttestationDetectors` drops every
**vendor-addressed** finding on a powered edge:

```
drop when  finding.vendorId !== null && poweredEdges.has(finding.integrationId)
```

One post-filter at the registry rather than four edits inside four detectors. It is a literal
transcription of the acceptance criterion, any detector added later inherits it without anyone
remembering to, and the property is checkable by reading one function.

**`vendorId === null` means AECi ops, and those findings survive on purpose.** `aeci-denied` is
ops-routed by definition (§7.1) and `open-conflict` raises an ops finding alongside its two vendor
nudges. Those are AECi's correction signal on its *own* curation, not a nudge to someone who built
nothing — suppressing them would hide precisely the case an operator needs to see, which is a vendor
disputing an edge that became powered after it attested.

The filter runs **inside** the registry's `try`, so the per-detector gauge
(`aeci.attestation.detector`, `docs/OBSERVABILITY.md`) reports what is actually sent rather than what
was found. `attestation-notify.ts`, the email templates and the §7.3 ledger need no change at all —
they act on findings.

### 14.5 The portal — read-only, not hidden

`VendorIntegrationSchema` gains `attestable: z.boolean().default(true)` and
`powered_by: ProductLinkSchema.nullable().default(null)`. Powered rows stay in
`GET /api/vendor/integrations`; the card renders read-only with one line naming the connector.

- **Hiding was rejected on three grounds**, in order of weight: filtering would change the list's
  scoping predicate and force a matching edit to the `/api/vendor/updates` `integrations` cursor,
  which — with no RLS behind `/api/vendor/*` — *is* the authorization boundary; the vendor's own
  public pair page still shows the edge, so a hole in the portal reads as data loss; and §5.4 already
  set the precedent for unverified vendors ("renders read-only and explains … rather than 403-ing a
  vendor out of its own data").
- **The server computes `attestable`; the client never re-derives it.** The union is non-obvious, and
  a browser-side copy would drift and show controls that collect a 403.
- **`powered_by` is a `ProductLink`, not a raw id** (§4.5, "attribution is a display concern"). It is
  `null` on 53 of the 132 production edges, where the copy falls back to the free-text
  `mechanism_name` — that fallback is the majority path, not an edge case.
- **`.default(true)`, not `false`.** The SSR and API Workers deploy per-commit but not atomically
  (the same reason `sync_headline.single_source` carries `.default(0)`, §4.5). `true` is what an
  older API implies, so the skew window degrades to pre-AECI-705 behaviour instead of blanking the
  tab; the write is refused server-side regardless.
- **The "waiting on your confirmation" count excludes powered edges** while the total does not. The
  total is what is *readable*; only an attestable edge can be waiting on anyone. That phrase is the
  in-portal half of the prompt this issue forbids.
- **The per-card explanation is silent when the vendor is merely unverified.** The section already
  states that reason once, above the list; a second per-card reason would read as two separate
  problems. The card answers only the question the section cannot: why *this* integration stays
  read-only even after verification.

### 14.6 What deliberately did NOT change

- **`computeAgreement` and every public render path.** Powered edges keep whatever attestations exist
  — which is none, anywhere, today — and render exactly as they do now. A connector concept inside a
  claim-grain engine would leak an edge-level column into shared code for no reader.
- **`ownedEndpointJoin` and the `/api/vendor/updates` `integrations` cursor.** Unchanged by
  construction, because the list is not filtered. **Accepted consequence:** the cursor keys off
  `claims.updated_at` ∪ `attestations.updated_at`, so a promote that flips `powered_by_product_id`
  moves neither and an open tab keeps offering the controls until reload. The write is still refused
  server-side; only the affordance is stale. Widening the cursor to notice it would mean editing the
  authorization boundary, which is the trade §14.5 already declined.
- **`vendor.authz-matrix.spec.ts` cells.** That matrix is role × endpoint; this gate is
  resource-scoped, so it adds no cell. The powered variants of "non-owner still gets 404" and "the
  unverified vendor gets the *connector* 403" live in `vendor-attestations.spec.ts`, where the
  fixtures can make an edge powered.
- **`attestation.author` remains a declared capability with no server-side consumer**
  (`STAGE_2_REALTIME_SPEC.md` §6.1). This issue does not promote it.

### 14.7 Out of scope — the connector attestation seat

A `powered_by`-vendor attestation seat is **explicitly future work**, recorded in §11 and owned by
**AECI-704** / `STAGE_2_SPEC.md` §8.8(2). Two constraints bind whoever builds it: `vendors.verified`
mirrors off `vendor_entitlements.status`, not `tier`, so "a seat but no badge" is not expressible
through the entitlement table as built; and a per-edge operator override (for the ~10 vendor-built
iPaaS edges §14.2 over-includes) is a separate, untracked opportunity, not part of that seat.

### 14.8 Acceptance

- The union predicate has one implementation, unit-tested across the full FK × `mechanism_kind`
  truth table including the nullable kind.
- `POST` and `PUT` answer 403 on a powered edge by **either** signal; `DELETE` still answers 204 on
  an edge that became powered after the attestation.
- A non-owning vendor on a powered edge still gets a flat 404, indistinguishable from a resource that
  does not exist.
- An unverified vendor on a powered edge gets the **connector** 403, not the verified one.
- No vendor-addressed detector finding survives on a powered edge, for any of the three vendor
  detectors; the `aeci-denied` and `open-conflict` **ops** findings do.
- The portal renders a powered card with no attestation control and no add-claim form, names the
  connector (or falls back to `mechanism_name`), and excludes its claims from the awaiting count —
  while the direct cards beside it stay fully writable.

### 14.9 As built (AECI-705 — 2026-08-31)

Shipped on `stage-2` with **no migration**. New module `apps/api/src/lib/connector-powered.ts`
(the predicate and the census that justifies it); `AttestationAuthority` widened in
`lib/attestation-authority.ts`; `assertAttestableEdge` plus the two response fields in
`routes/vendor-attestations.ts`; the registry filter in `lib/attestation-detectors.ts`; the wire
fields in `packages/shared/src/api/vendor-attestations.ts`; and the read-only branch in
`apps/web/src/app/vendor/components/vendor-integration-card.ts` +
`vendor-integrations-section.ts`.

Notes worth keeping:

- **Production held 0 non-`aeci` attestations at merge** (1,697 claims / 1,697 attestations), so the
  gate is **purely prospective**: no backfill, no retraction sweep, no render migration. The volume
  it suppresses is **179 claims across 67 edges and 41 distinct vendors**, every one of which has a
  `product_vendors` row on an endpoint — so all 179 would have become live prompts on the day the
  portal opened.
- **The route-spec fixtures make an edge powered by each signal separately**, and the `fk` case
  deliberately sets a *non*-`iPaaS` mechanism alongside the FK. Setting both signals together would
  let the tests pass against either half of the union and prove nothing about the union itself.
- **The detector tests assert on `runAttestationDetectors`, never on a detector directly.** Calling a
  detector in isolation bypasses the gate — which is exactly the property that lets the ops findings
  survive it — so a direct-call test would be asserting the wrong thing.
- **`toEqual` on `AttestationAuthority` broke in two places** in `attestation-authority.spec.ts` when
  the interface widened. That is the assertion doing its job: the shape is part of the seam's
  contract, and two more fields on it is a change a reader should see.

**Test coverage:** `lib/connector-powered.spec.ts` (5 — the truth table, both real production
populations, the nullable kind); `lib/attestation-detectors.spec.ts` (+6 — both signals on
silent-counterparty, the open-conflict ops survivor, the `aeci-denied` survivor, stale-version, and a
direct edge left alone); `routes/vendor-attestations.spec.ts` (+9 — POST and PUT 403 by both signals,
the DELETE carve-out, the gate order against an unverified vendor, the non-owner 404, and the two
list shapes); `packages/shared/src/api/vendor-attestations.spec.ts` (+2 — the fields and their
skew-window defaults); `vendor-integrations-section.component.spec.ts` (+6 — read-only card, both
copy fallbacks, the neighbouring direct cards still writable, and the awaiting count). Suites green
at merge: `apps/api` 123 files / 2,335 tests, `packages/shared` 34 / 639, `apps/web` 155 / 1,632
under `ng test` plus 45 / 773 under plain Vitest.
