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
§8.1(3)); `vendors.verified` is the launch entitlement bit (§8.3(1)). It gates **capability only,
never ranking, placement, or badge trust** — no pay-for-placement.

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
| §6 | AECI-606 | Vendor dashboard — Integrations / attestations tab |
| §7 | AECI-302 | Detector + notification pipeline (email-only) |
| §8 | AECI-607 | Product-version model (**migration 2**) |
| §9 | AECI-303 | Version-diff timeline + per-product version selectors |
| §10 | AECI-608 | Docs: attestation authz + API/schema contract sweep |

**Build order.**

```
§2 authority + schema (603) ──┬─→ §3 promote coexistence (604)
                              ├─→ §5 write API (301) ──→ §6 dashboard tab (606)
                              └─→ §7 notification pipeline (302)

§4 agreement engine (605) ──── independent of §2; MUST land before §5 is enabled in
                               any public environment (see the gate note below)

§8 product-version model (607) ──→ §9 version-diff UI (303)

§10 docs sweep (608) — runs alongside
```

> **Release gate.** §4 changes what a *reader* sees. §5 is what first creates a vendor
> attestation. Shipping §5 before §4 would render a single vendor's self-assertion as
> "Vendor-confirmed" on the public pair page — the exact failure §8.1(4) forbids. **§4 must be
> merged to `stage-2` before §5 reaches staging.** §4 needs no vendor data to build or test: the
> engine's non-`unverified` branches have been unit-tested against synthetic vendor attestations
> since AECI-300.

### 1.2 Schema deltas — **two deliberate migrations**

`STAGE_2_SPEC.md` §2.4 claimed this epic needs **no migration**. That was true of the *agreement
engine* (computed-not-stored) and remains true of the `vendor_a`/`vendor_b` sources. It is **not**
true of the epic as scoped at kickoff: two decisions (§1.3(1) and §1.3(3)) each require schema.
§2.4 has been corrected. Both migrations are **additive** — no column is dropped or retyped, so
they are safe to apply ahead of the code that reads them (`docs/migrations.md`: edit
`apps/api/src/db/schema.ts` → `pnpm db:generate` → `wrangler d1 migrations apply`).

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
`attestations.introduced_version_id` / `deprecated_version_id`.

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
   Real-time delivery is deferred to AECI-516, whose transport is still open (`STAGE_2_SPEC.md`
   §8.2). Nothing in this epic waits on that decision.
5. **`confirmed` requires two *distinct vendor identities*** — a `single_source` state is added so
   one vendor's affirmation is never rendered as bilateral agreement (§4).
6. **Notification dedupe uses `audit_log` as the ledger** — no notifications table (§7.3).

### 1.4 Branch model

`origin/aeci-514` is a **long-lived epic integration branch** (= `stage-2` + this kickoff commit).
Every sub-issue branches from and PRs into **`aeci-514`**, not `stage-2` — each sub-issue has to
*update this doc*, and this doc does not exist on `stage-2`. When the epic completes, `aeci-514`
merges to `stage-2`. **The Linear issue template's `**Base branch:** stage-2` line is stale for
this epic; the sub-issue descriptions override it.** (Same model as AECI-513 / `aeci-513`.)

> **⚠️ `stage-2` is behind `main`.** At kickoff, `origin/stage-2` was **22 commits behind
> `origin/main`**, and the merge conflicts across 29 files (deploy-workflow secret lists,
> `promote.ts`, `CLAUDE.md`, several docs). Three of those PRs rewrote the promote path —
> **AECI-563** (async ingest via a Cloudflare Workflow), **AECI-571** (`promote_jobs` exactly-once
> ledger) and **AECI-568** (stale-`supabaseId` insert fallback). **§3 edits `promote.ts` directly
> and must not start until `main → stage-2` has been reconciled** (ADR 0019 requires that merge
> anyway). Treat the reconciliation as its own tracked task — it is a real integration job, not a
> fast-forward.

### 1.5 What already exists — reuse, don't rebuild

Verified against the tree at kickoff (paths are anchors, not guarantees — check before editing):

- **Schema hooks** — `attestations.source` CHECK already allows `'aeci' | 'vendor_a' | 'vendor_b'`;
  `introduced_at` / `deprecated_at` columns present. `apps/api/src/db/schema.ts` (`claims` ~:321,
  `attestations` ~:349).
- **Agreement engine** — `computeAgreement` / `computeSyncHeadline`, pure and unit-tested
  including the currently-unreachable `confirmed`/`conflict` branches.
  `packages/shared/src/agreement.ts`.
- **Pair read path, end to end** — `integrationPairConfig` → `toProductPairClaim` →
  `computeAgreement` → `toProductPairResponse`. `apps/api/src/lib/drizzle-helpers.ts` (~:149,
  ~:705-787). Wire contract: `packages/shared/src/api/product-pairs.ts`.
- **Pair page render** — direction lanes + per-claim badge + provenance disclosure.
  `apps/web/src/app/products/products-pair.ts`, `agreement-badge.ts`, `claim-provenance.ts`.
  The badge **already carries `confirmed` / `conflict` copy** behind deliberately neutral styling.
- **The vendor write template** — `requireVendor()` + `sessionVendorId()` + one-`db.batch`
  write + `auditInsert` + `waitUntil(purgeTags + forwardAuditLog)` + the 404-not-403
  non-disclosure rule. `apps/api/src/routes/vendor.ts` is the file every §5 endpoint copies;
  `apps/api/src/lib/authz.ts` is the guard.
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

Shipped as **migration 1 of two**: `apps/api/migrations/0006_lyrical_leper_queen.sql`, generated from
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
   `claims_identity_key` unique index `(integration_id, data_object_id, direction)` as the
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
  (§1.4) — the file was restructured by AECI-563 / AECI-571 / AECI-568 on `main`.

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
  subline would be false.
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
row, `waitUntil(purge + Datadog forward)`.

### 5.1 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/vendor/integrations` | The caller's attestable surface: every integration touching a product the vendor owns, with its claims, current agreement, the counterparty's state, and **which slot is the caller's** |
| `POST` | `/api/vendor/claims` | Create a claim (`origin='vendor'`) **and** the caller's affirming attestation, in one batch |
| `PUT` | `/api/vendor/claims/:claimId/attestation` | Assert or deny — upsert the caller's slot (retract-then-insert, §2.1) |
| `DELETE` | `/api/vendor/claims/:claimId/attestation` | Retract the caller's attestation (sets `retracted_at`; the row survives for §9's timeline) |

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

---

## 6. Vendor dashboard — Integrations tab (AECI-606)

**Needs §5.** The authoring surface, added to the existing tabbed dashboard.

- New tab in `apps/web/src/app/vendor/vendor-dashboard-tabbed.ts` — extend the `Tab` union, the
  `tabs` array, and the `@switch`. The component is presentational and takes its payload as an
  input; keep it that way (it renders both the dev preview and the gated `/vendor` route).
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
- Design checklist as in §4.3 — same anchor site as the rest of the vendor dashboard, light theme
  only, axe clean, all strings `$localize`d.

---

## 7. Detector + notification pipeline (AECI-302)

**Needs §2 and §4.** Turns conflict and staleness into outbound vendor nudges. **Email-only at
launch** (decision §1.3(4)); real-time delivery is AECI-516.

### 7.1 Detectors

Run as one daily sweep. Each yields `(claim, recipient vendor, detector kind)`.

| Detector | Fires when |
|---|---|
| **silent-counterparty** | a claim sits at `single_source` for > N days — nudge the *silent* slot's vendor |
| **open-conflict** | a claim is at `conflict` for > N days, unresolved — nudge **both** vendors and raise it to AECi ops |
| **stale-version** | an attestation is older than N months with no version stamps, or its `deprecated_version` has passed — nudge the attesting vendor to re-confirm |
| **aeci-denied** | a vendor **denies** an AECi-seeded claim — this is a correction signal to **AECi**, not a vendor nudge; route it to the ops surface, since a denial-only claim renders `unverified` (§4.2) and would otherwise be invisible |

> **⚠️ `cross-grain` needs a definition or it gets dropped.** `STAGE_2_SPEC.md` §2.4 lists
> "cross-grain" as a fourth detector and `docs/DATA_OBJECT_VOCABULARY.md` §1 says cross-grain
> detection "keys off these terms" — but **no doc in this repo defines it**, and the external
> concept doc that AECI-302 cites (§4.5/§7) is not in the tree. **Proposed definition:** because
> claims anchor to the *mechanism* row (`STAGE_1_5_SPEC.md` §3.1, ADR 0018), the same
> `data_object` between the same product **pair** can be claimed with contradictory directions
> through different mechanisms — the native connector says `a_to_b`, the Zapier app says `b_to_a`
> — so the *pair-level* picture is inconsistent while no individual claim is in `conflict`.
> Cross-grain detects that. **The sub-issue must either adopt this definition or drop the
> detector; it must not ship an undefined one.**

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
- **No real-time.** The §2.3 / AECI-516 channel is additive later; nothing here assumes it.

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
re-check against `main`, which has added crons since `stage-2` forked (§1.4). Emit a Datadog
metric per detector per run (`docs/OBSERVABILITY.md`), including the zero case, so the cron's
liveness is observable.

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
"entitlements are data, not code branches scattered across the app"). It defaults to `true` until
the Paid Tiers epic (AECI-515) lands the entitlement engine; AECI-304 then swaps the implementation
without touching this epic's code. Design checklist applies as in §4.3.

---

## 10. Docs: attestation authz + API/schema contract sweep (AECI-608)

Runs alongside; finishes what each sub-issue seeds (the AECI-525 pattern).

- **`docs/AUTH_AND_RLS.md`** — add the `/api/vendor/claims*` and
  `/api/vendor/products/:id/versions` rows to the §4.4 endpoint table (auth + scope + audit), and
  document the §2.1 two-slot authority rule as the canonical extension of the `vendor_id`-scoping
  invariant.
- **`docs/API_CONTRACTS.md`** — the §5 and §8.3 endpoint shapes, Zod schemas, error codes.
- **`docs/DATABASE_SCHEMA.md`** — both migrations (it trails `schema.ts`; bring it forward).
- **`docs/REVIEW_APP_PROMOTE_API.md`** — the §3.3 replace-by-origin carve-out.
- **`docs/CACHE_STRATEGY.md`** — the §5.2 purge tag set for attestation writes; the §9.2
  `cacheKeyParams` addition.
- **`docs/email.md`** — the §7.2 template catalogue entries.
- **`docs/OBSERVABILITY.md`** + **`docs/POST_LAUNCH_MONITORING.md`** — the §7.4 detector metrics
  and the launch-tunable thresholds.
- **`docs/STAGE_1_5_SPEC.md`** §10 — mark the carve-outs activated, pointing at this doc.

---

## 11. Out of scope / deferred

- **Real-time notification delivery** — AECI-516; transport still open (`STAGE_2_SPEC.md` §8.2).
  §7 ships email + in-portal only.
- **Paywall *enforcement*** — AECI-304 under the Paid Tiers epic (AECI-515). §9.3 ships the seam,
  not the gate.
- **Promote ingest of version stamps / `product_versions`** — §8.3; vendor-authored only at launch.
- **Per-pair Algolia records / claims in the search index** — still deferred
  (`STAGE_1_5_SPEC.md` §9); attestation state does not reach search in this epic.
- **Self-serve seat invite/revoke**, **dark theme**, **a public/partner write API** — unchanged
  deferrals from `STAGE_2_VENDOR_PORTAL_SPEC.md` §11 and `STAGE_2_SPEC.md` §9.
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

---

*This is the build contract for AECI-514. As each sub-issue lands, keep this doc current with the
code (per the "update all documents" rule) and add an "As built" subsection under its anchor — the
file/line references in §1.5 are anchors, not guarantees; verify them before editing the cited
files.*
