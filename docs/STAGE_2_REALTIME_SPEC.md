# AEC Integrations — Stage 2 Real-Time / Live Portal Specification (build spec)

**Version:** 1.0 — **build contract, fully built** (the decomposition of the AECI-516 epic)
**Date:** August 2026 (epic review / kickoff 2026-08-19; **built out 2026-08-19**, AECI-626…632)
**Status:** Build contract — promotes `STAGE_2_SPEC.md` §2.3 from scope outline to a buildable spec. The transport decision it turned on is **ADR 0023** (Accepted 2026-08-19) and is recorded in `STAGE_2_SPEC.md` **§8.6**. **All seven sub-issues have shipped; every section carries an `§X.N As built` subsection recording what landed and what diverged** (§1.5 is the epic-level summary). Where a pre-build sentence and an as-built subsection disagree, **the as-built subsection is the current contract** — the prose above it has been corrected in place, so a disagreement that survives is a doc bug worth raising.
**Supersedes:** `STAGE_2_SPEC.md` §2.3 (that section stays the scope outline; this doc is the contract each sub-issue anchors to) and the **third open item of §8.2** ("Real-time transport … Deferred"), which this epic closes. Also corrects §4(5) and the §7 epic-table row, both of which named **Durable Objects** as though it were a decision — it was §18's assumption carried forward.
**Inherits from:** the **Vendor Portal build contract** (`STAGE_2_VENDOR_PORTAL_SPEC.md`, AECI-513 — the `/api/vendor/*` authz seam and the dashboard this epic makes live), the **Attestations build contract** (`STAGE_2_ATTESTATIONS_SPEC.md`, AECI-514 — the detector/notification pipeline whose in-portal delivery this epic completes), and the **Paid Tiers build contract** (`STAGE_2_PAID_TIERS_SPEC.md`, AECI-515 — the entitlement whose concierge flip is the one event with a real deadline).
**Companion docs:** `AUTH_AND_RLS.md` (Layer-1 Worker authz + the per-`/api/vendor/*`-endpoint row — §2.6), `API_CONTRACTS.md` (endpoint shape — §2), `OBSERVABILITY.md` (the metric catalog row — §7), `POST_LAUNCH_MONITORING.md` (the poll-interval tunables — §4.4), `TESTING_STRATEGY.md` (the `/vendor` axe contract — §6.4), `ANGULAR_STYLE_GUIDE.md` (zoneless/signals/OnPush — §3, §4), `DESIGN.md` (the `/vendor` surface — §6).

> **Data-layer note (ADR 0016 / 0017).** The application database is **Cloudflare D1 + Drizzle**; Supabase is **auth-only**. The one server-side artifact in this epic (§2) is a **pure read** through `getDb(env)`, executed as a single `db.batch([...])`. There is **no Prisma, no Postgres, no RLS on app tables** — authorization is the 3-layer Worker model in `AUTH_AND_RLS.md`.

> **No-cache note (ADR 0020).** `/vendor` and `/api/vendor/*` are private and **never edge-cached** — `json()` stamps `Cache-Control: private, no-store` (`apps/api/src/http.ts:17`), and the SSR route is `noindex` + non-cacheable. **Nothing in this epic emits a `Cache-Tag` or enqueues a purge**, and no cacheable SSR component may import the portal store. If a diff in this epic touches `cache-tags.ts` or a purge producer, something has gone wrong.

---

## 1. The decision

**Live updates are delivered by scoped client revalidation over a cheap per-vendor freshness cursor. Durable-Object WebSockets and SSE are not adopted.** The full reasoning, the event→latency enumeration it rests on, the cost analysis of the DO alternative, and the **re-open trigger** live in **ADR 0023**; this section states only what a builder needs.

The deciding observation: enumerate every event that can change a vendor's portal state and **none is sub-second**. The vendor's own edit needs *zero* transport — the `PATCH`/`PUT` echo already carries post-edit state. Two of the six event classes are produced by a **daily cron** (`ATTESTATION_NOTIFY_CRON = '0 10 * * *'` and `ENTITLEMENT_EXPIRY_CRON = '0 11 * * *'`, `apps/api/src/scheduled.ts`), so a persistent socket would deliver a 24-hour-stale event with 50 ms of transport latency. The only event with a real deadline is the **concierge entitlement toggle** (`PATCH /api/admin/vendors/:id/entitlement`), where an admin is frequently on the phone with the vendor: it needs *about a minute*, not *about a frame*.

**What this is NOT.** It is not "no live updates". Both §2.3 scope bullets ship:

1. **Live vendor edits reflect without a full reload** — a shared portal store with optimistic local mutation and server reconciliation (§3, §5), plus cross-section revalidation so a write in one section moves the counts in another.
2. **A real-time delivery channel for the §2.4 notifications alongside the Resend fallback** — new detector nudges appear in-portal within one poll interval, without a reload (§6.2). **Email stays primary**, exactly as `STAGE_2_ATTESTATIONS_SPEC.md` §7.2 specifies.

### 1.1 Issue map & critical path

This doc is the contract for the AECI-516 sub-issues. Each opens with `**Spec section:** docs/STAGE_2_REALTIME_SPEC.md §X` per the `spec-anchor` convention. **The subsection numbering below is load-bearing — do not renumber without updating the issues.**

| Anchor | Issue | Surface | Status |
|---|---|---|---|
| §1 | AECI-626 | The transport decision — ADR 0023 + this build contract + the cross-doc un-defer (**docs only**) | shipped 2026-08-19 |
| §2, §7 | AECI-627 | `GET /api/vendor/updates` — the per-scope freshness cursor and its metric | shipped 2026-08-19 (§2.6, §7.1) |
| §3 | AECI-628 | `VendorPortalStore` — shared portal state + `revalidate(scopes)` | shipped 2026-08-19 (§3.1) |
| §4 | AECI-629 | `VendorLiveSync` — the visibility-aware revalidation loop | shipped 2026-08-19 (§4.5) |
| §5 | AECI-630 | Optimistic attestation writes with rollback | shipped 2026-08-19 (§5.1) |
| §6 | AECI-631 | Live entitlement flip, new-notification surfacing, the a11y live region | shipped 2026-08-19 (§6.5) |
| §6.4 + every section | AECI-632 | Epic close-out — e2e + a11y coverage over the shipped surface, and the as-built docs reconcile | shipped 2026-08-19 (§1.5, §6.6) |

**Build order.** Seven issues in three waves; wave members have disjoint file ownership and run in parallel.

```
Wave 1   §1 decision (626, docs)  ── it IS the contract; unblocks by existing
         §2 cursor endpoint (627) ─┐
         §3 portal store (628) ────┤
                                   │
Wave 2                             ├─→ §4 sync loop (629)      [needs 627 + 628]
         §3 (628) ─────────────────┼─→ §5 optimistic writes (630)
                                   └─→ §6 surfacing + a11y (631)

Wave 3   §6.4 close-out (632) — last; needs 629 + 630 + 631 on the branch
```

§2 and §3 are the critical path and are genuinely parallel: one adds a Hono route plus a `@aeci/shared` schema, the other adds an Angular root store. They share only the **scope vocabulary** (§2.3), which §1 fixes here in the spec so neither has to wait on the other to name it.

**As-built convention.** As each section ships, its issue appends an `§X.N As built` subsection recording what actually landed and what diverged — the pattern `STAGE_2_ATTESTATIONS_SPEC.md` §5.4 / §7.5 / §9.4 and `STAGE_2_PAID_TIERS_SPEC.md` established. AECI-632 swept them at close-out and reconciled every `AECI-516` / "real-time" mention across the docs against what shipped. **Every section now carries one** (§1.5, §2.6, §3.1, §4.5, §5.1, §6.5, §6.6, §7.1); a future section added here without one has not shipped.

### 1.2 Schema readiness — **no migration**

This epic ships **zero migrations**, and that is a checkable claim rather than an aspiration: §2 is a **read**, and every column it reads already exists and is already indexed for the handler it mirrors (§2.2). §3–§6 are browser-side. If a sub-issue finds itself reaching for `pnpm db:generate`, it has left the contract — raise it (`CLAUDE.md` "When the spec is wrong") rather than adding a table.

The deliberate contrast is with `STAGE_2_PAID_TIERS_SPEC.md` §1.2 ("ONE migration required") and `STAGE_2_ATTESTATIONS_SPEC.md` §1.2 ("three deliberate migrations"). Both of those epics *needed* new state. This one needs only to **report the age of state that already exists**, which is why the cursor is six `MAX()`/`updated_at` reads and not a new `vendor_revisions` table. A revision table would have to be maintained by every writer in three epics — precisely the fan-out coupling ADR 0023 declined to take on for the socket.

### 1.3 Decisions taken at the epic review (2026-08-19, Chris)

Promoted into `STAGE_2_SPEC.md` §8.6; restated here because they are the contract.

1. **Scoped client revalidation, not Durable-Object WebSockets or SSE** — ADR 0023, with a named re-open trigger. This is a dated decision, not a permanent no.
2. **The cursor is per-scope, not one opaque revision** (§2.3). An opaque token turns any counterparty attestation into a three-call full-dashboard refetch, on the interval, forever.
3. **Every cursor query reuses the scoping predicate of the handler it is a cursor for** (§2.2). This is the one invariant a reviewer must check by hand.
4. **Optimistic for toggles, pessimistic for forms** (§5). Showing "Saved" before it saved is a worse lie than a 300 ms wait.
5. **Notifications surface as a session-scoped count, never a banner** (§6.2). These rows are a historical record of an email, not current state.
6. **One polite live region on the surface, hoisted — never a second** (§6.3).

*(As built: (6) shipped with one refinement worth carrying at this level — the hoisted region is fed by a dedicated root service, `VendorPortalAnnouncer`, not by the store. §6.3's as-built note has the reasoning; `STAGE_2_SPEC.md` §8.6(7) and `DESIGN.md` → Vendor portal were corrected in the same sweep.)*

### 1.4 Branch model

`chris/aeci-516-real-time-live-portal-epic`, off `stage-2` @ `8ea629ce`, acts as the **epic integration branch** — the same pattern `aeci-513` / `aeci-514` / `aeci-515` used and for the same reason (`STAGE_2_SPEC.md` §7): the epic adds a companion spec that does not exist on `stage-2` yet, so sub-issues that must edit it cannot base on `stage-2` directly. Sub-issues branch from and PR into the epic branch; the epic branch merges to `stage-2` when it completes. Never base on `main` (ADR 0019).

### 1.5 As built (AECI-626…632 — 2026-08-19) — **epic complete**

All seven sub-issues shipped on the epic branch in one day. **Zero migrations**, exactly as §1.2 promised: nothing under `apps/api/migrations/` moved, and `pnpm db:generate` was never run. **Zero new bindings, zero queue messages, zero `Cache-Tag` emissions** — the §"No-cache note" check ("if a diff in this epic touches `cache-tags.ts` or a purge producer, something has gone wrong") passes; no file under `apps/web/src/server/` was touched.

The whole server side is one Hono route (`apps/api/src/routes/vendor-updates.ts`) plus one `@aeci/shared` module (`packages/shared/src/api/vendor-updates.ts`). The whole client side is five files under `apps/web/src/app/vendor/`:

| File | §  | What it is |
|---|---|---|
| `vendor-portal-store.ts` | §3 | the surface-scoped signal store — state, deferral, optimistic `apply()` |
| `vendor-live-sync.ts` | §4 | the surface-scoped poll loop — cadence, diff, per-scope settle |
| `vendor-announcer.ts` | §6.3 | the **root** announcement channel behind the one live region (new) |
| `vendor-notification-baseline.ts` | §6.2 | the **root** session baseline behind the "N new" count (new) |
| `vendor-dashboard-tabbed.ts` / `vendor-dashboard-single.ts` | §6.1, §6.3 | the two concept shells: the capability gate and the region itself |

**Two of the four services are root singletons and two are deliberately not, and the split is not arbitrary.** `VendorPortalStore` and `VendorLiveSync` are `@Injectable()` **with an explicit `use-injectable-provided-in` lint suppression**, because they inject `VendorApi` and the dev-only preview shadows `VendorApi` in a **component** `providers` array (`preview/vendor-dashboard/vendor-dashboard-preview.ts`); a root-provided service resolves from the root environment injector, walks straight past that shadow, and fires real network calls from a route with no session. So the store is provided by both surface owners (`VendorPage` and `VendorDashboardPreview`), and the sync loop by `VendorPage` alone — the preview has no session to poll with, so it gets a live store and no loop.

`VendorPortalAnnouncer` and `VendorNotificationBaseline` are plain `@Service()` (Angular v22's root singleton). They inject **nothing** and fetch **nothing**, so there is no binding for them to resolve wrongly, and root is what lets *both* dashboard concepts reach them without a provider each. **Adding an `inject(VendorApi)` to either one is the change that would silently break the preview** — treat that as the tripwire, because nothing fails loudly: the preview would simply start issuing real `/api/vendor/*` calls from an unauthenticated route.

**Six divergences from the pre-build prose**, each verified against code and corrected in place above rather than left for a reader to trip over. They are listed here as the single index; each is argued where it belongs.

| # | § | Pre-build text | As shipped |
|---|---|---|---|
| 1 | §6.3 | the region is "fed from the store" | fed by **`VendorPortalAnnouncer`**, a root service the store knows nothing about |
| 2 | §6.1 | *every* `canEdit` re-derives from `me.entitlement.capabilities` | the client gates on **whatever field the API gates on** — capabilities for profile/product edits, `vendors.verified` for attestation authoring |
| 3 | §4.1 | `online` → immediate poll, unconditionally | gated on visibility (`vendor-live-sync.ts:260-263`) |
| 4 | §4.1 | backoff ladder 20 → 40 → 80 → 160 s | `Math.max(baseCadence, backoff)` (`vendor-live-sync.ts:377-388`) — the ladder never polls *faster* than the healthy cadence |
| 5 | §2.2 | the cursor "reuses the ownership set built in `createListVendorIntegrationsHandler`" | the predicates were **extracted into four exported helpers** and imported by both sides |
| 6 | §6.3 | one region, in the dashboard shell | one region **per concept shell** — Concept A *and* Concept B each host one; only one concept renders at a time |

**One thing the section prose could not fix**, recorded here because it is a code change and not a wording change: the vendor tree ships **four conditional `role="status"` elements** besides the announcement region — `vendor-profile-form.ts:247` and `vendor-product-form.ts:195` (the "Saved" confirmations), `vendor-attestation-control.ts:219` (the divergent-slots notice) and `vendor-add-claim-form.ts:218` (the duplicate-lane notice). Each is inserted rather than persistent, and each is a live region by definition, so §6.3's "never a second" is literally violated whenever one of them is on screen. Two of the four sit on the **Integrations section**, which is also the only section that announces through the channel, so the race §6.3 exists to prevent is reachable there rather than theoretical. The `/vendor` axe pass does not catch it (multiple live regions are valid ARIA). See §6.5 for the shape of the fix and why it was not taken inside the close-out.

---

## 2. `GET /api/vendor/updates` — the freshness cursor (AECI-627)

One endpoint, one D1 round trip, no writes. It answers exactly one question: *since when has each part of my portal been stale?*

**Placement.** Contract in `packages/shared/src/api/vendor-updates.ts` (+ the `index.ts` barrel) per the API-contracts rule — shared TypeScript types validated by Zod, no OpenAPI, no codegen (`API_CONTRACTS.md` §2). Handler in `apps/api/src/routes/vendor-updates.ts`, registered in `apps/api/src/index.ts` alongside the other `/api/vendor/*` routes. Its shape row belongs in `API_CONTRACTS.md` §6.14.

**Authorization.** Behind `requireVendor()` (`apps/api/src/lib/authz.ts:422`), which checks ban → `profiles.role = 'vendor_admin'` → non-null `profiles.vendor_id` before the handler runs. Scoped to `c.get('auth').vendorId`; **no vendor id crosses the wire** — the AECI-520 invariant. Passing the guard proves only *which* vendor the caller is; it scopes nothing, so every one of the six queries filters explicitly.

> **Not entitlement-gated.** Do **not** call `requireCapability()` here. `authz.ts`'s own doc comment states the rule — *"Reads are never gated (§4.3 / R13)"* — and the reason applies with extra force to this endpoint: `/vendor` is gated by `vendorMeResolver`, which maps 401/403/404 onto a 404 render, so a gated cursor would take the dashboard down for a vendor whose entitlement lapsed, hiding the renewal notice from exactly the cohort being billed.

**No audit row.** This is a pure read; §26.1 of `STAGE_1_SPEC.md` attaches to **writes**, so there is no `audit_log` row and **adding one would be wrong** — not merely redundant. `audit_log` is also the notification ledger the portal itself queries (`action = 'notification.sent'`, `STAGE_2_ATTESTATIONS_SPEC.md` §7.3), so a row every 20 seconds per open tab would pollute the table the `notifications` scope reads and inflate the very query it exists to make cheap.

**Cacheability.** `private, no-store`, which is the `json()` default (`apps/api/src/http.ts:17`) — take the default, do not set headers by hand.

### 2.1 Response shape

```jsonc
{
  "revisions": {
    "profile":       "2026-08-19T06:11:02.000Z",  // string | null
    "entitlement":   "2026-08-14T09:00:00.000Z",
    "products":      "2026-08-18T22:04:10.000Z",
    "integrations":  "2026-08-19T05:59:00.000Z",
    "notifications": "2026-08-19T10:00:03.000Z",
    "requests":      null
  },
  "server_time": "2026-08-19T06:46:00.000Z"
}
```

Every value is an **ISO-8601 string or `null`**; `null` means *this scope has no rows at all*, which is a legitimate steady state (a vendor with no requests) and must never be conflated with "unchanged". The client compares against its last-seen map: a scope whose value **differs** from the last seen — in either direction, including `null` → timestamp and timestamp → `null` — is stale.

`server_time` is the server's clock at read, carried so the client never has to compare a server timestamp against `Date.now()`. It exists because the two clocks are not the same clock and the difference between them is not bounded; without it, a modest client skew turns a fresh cursor into a permanently-stale one (or the reverse).

**Six SELECTs in one `db.batch([...])`** — one D1 round trip, not six. The batch here is for round-trip economy, not atomicity: this is the one place in the codebase where `db.batch` carries no `audit_log` row, precisely because it carries no write.

### 2.2 Scope → source of truth

| scope | source of truth |
|---|---|
| `profile` | `vendors.updated_at` for the session vendor (also moves on the `verified` mirror flip, since the mirror is written in the same batch as the entitlement — `STAGE_2_PAID_TIERS_SPEC.md` §2.1) |
| `entitlement` | `MAX(vendor_entitlements.updated_at)` for the vendor (`vendor_id` is UNIQUE → ≤1 row, so the `MAX` is a formality that keeps the query shape uniform) |
| `products` | `MAX(products.updated_at)` over `product_vendors.vendor_id = ?` — the shared `ownedProductIds(db, vendorId)` subquery (`apps/api/src/routes/vendor-shared.ts:137`) |
| `integrations` | `MAX` over `claims.updated_at` ∪ `attestations.updated_at` for integrations whose `source_product_id` **or** `target_product_id` is in the owned set — the shared `ownedEndpointJoin(vendorId)` predicate (`apps/api/src/lib/attestation-authority.ts:127`), which is also what `resolveClaimAuthority` and `createListVendorIntegrationsHandler` join on |
| `notifications` | `MAX(audit_log.created_at)` under the **exact** predicate the list endpoint uses — `vendorNotificationLedgerWhere(vendorId)` (`apps/api/src/routes/vendor-notifications.ts:83`): `action = 'notification.sent'` + the 90-day window + `json_extract(metadata, '$.vendorId') = ?` |
| `requests` | `MAX(COALESCE(resolved_at, created_at))` under the **exact** predicate `GET /api/vendor/me` uses — `vendorRequestsWhere(vendorId, ownedProductIds(...))` (`apps/api/src/routes/vendor-shared.ts:155`): requests targeting the vendor itself, plus those targeting any product it owns. `COALESCE` because **`vendor_requests` has no `updated_at`** — a resolution is the only post-creation mutation that matters here |

> **Invariant (the one to check by hand).** **Every cursor query reuses the scoping predicate of the handler it is a cursor for.** A cursor that scopes *differently* from its payload fails in one of two ways, both silent:
>
> - **Too narrow** ⇒ the cursor never moves when the payload does, and that section is permanently stale with no error anywhere. Nothing throws; the tab just stops being live.
> - **Too wide** ⇒ the cursor moves on a row the caller may not read, which **leaks the existence of another vendor's row** through a timestamp. That is the AECI-520 non-disclosure rule failing through a side channel rather than a payload.
>
> The `notifications` row is the sharpest example: ops-routed nudges store `"vendorId": null` in `metadata`, and `json_extract` returns SQL `NULL`, which is never equal to a caller's id — that is *why* the shipped predicate is written the way it is, and copying anything looser would surface AECi's internal ops volume as a vendor-visible heartbeat.

### 2.3 Client scope vocabulary → refetch map

```ts
type VendorPortalScope =
  | 'profile' | 'entitlement' | 'products' | 'integrations' | 'notifications' | 'requests';
```

| moved scope(s) | refetch |
|---|---|
| `profile` · `entitlement` · `products` · `requests` | `GET /api/vendor/me` — **one call**, deduped when several of the four move together |
| `integrations` | `GET /api/vendor/integrations` |
| `notifications` | `GET /api/vendor/notifications` |

Four of the six scopes collapse onto `me` because that is what the payload already is: `GET /api/vendor/me` returns vendor + owned products + claim/correction status + seat count in one shot (`apps/api/src/routes/vendor.ts`). Splitting them at the cursor while collapsing them at the refetch is deliberate — the **cursor** is where per-scope granularity is cheap (one more `MAX` in a batch already being issued) and the **refetch** is where it would cost a round trip.

> **Unchanged by `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.5 (2026-08-27), on purpose.** Integrations became a *per-product* tab, but neither the `integrations` scope nor its refetch is per-product: it is still one vendor-wide `GET /api/vendor/integrations` scoped by `ownedEndpointJoin`, and the tab narrows the result client-side via its `contextProductId` input. Making the fetch per-product would violate §2.2's invariant — the cursor's predicate would no longer match its list's — and would turn one call into one per product for a payload already bounded by the vendor's own catalog. What *did* change is the payload's grain: the handler now emits **one entry per owned endpoint**, so an owns-both integration appears twice and `(id, context_product.id)` is the key. That is invisible to the cursor, which still counts integrations, not listings.

### 2.4 Tests the endpoint must carry

- **Per-scope movement** — a write in each of the six domains moves that scope and **only** that scope.
- **Cross-vendor isolation** — another vendor's write to each of the six domains moves **no** cursor for the caller. This is the test that catches a too-wide predicate.
- **Null when empty** — a vendor with no products / no requests / no notifications gets `null`, not an epoch, not `server_time`.
- **Ops-routed notifications** — an `audit_log` row with `metadata.vendorId = null` never matches any caller.
- **`no-store`** on the response.
- **Authz matrix** — anon, `reviewer`, `admin`, banned `vendor_admin`, and a `vendor_admin` with null `vendor_id` are all rejected. Extend `apps/api/src/routes/vendor.authz-matrix.spec.ts` rather than starting a parallel matrix.

### 2.5 Documentation the endpoint owes

`docs/AUTH_AND_RLS.md` carries **one row per `/api/vendor/*` endpoint** (auth requirement · scoping rule · whether it writes). A new endpoint without a row there is a **hole in the authorization source of truth**, not a formatting miss — that table is where a reviewer checks the §2.2 invariant is even claimed. Plus the `API_CONTRACTS.md` §6.14 shape row, any new error rows in its §4, and the `OBSERVABILITY.md` catalog row for §7's metric.

### 2.6 As built (AECI-627 — 2026-08-19)

Shipped as specified: one route, six SELECTs, one `db.batch`, no writes, no audit row, no new error codes (so `API_CONTRACTS.md` §4 gained nothing — the guard's own 401/403 are the whole error surface). Every §2.4 test landed, in `apps/api/src/routes/vendor-updates.spec.ts` plus five rows extended into the existing `vendor.authz-matrix.spec.ts` rather than a parallel matrix.

Four decisions taken at build that §2.1–§2.5 did not pre-specify:

- **The scoping predicates were extracted into exported helpers, not copied.** §2.2 originally said the `integrations` cursor should "reuse the ownership set built in `createListVendorIntegrationsHandler`" — but that set is built *inside* the handler from an in-memory authority map, so "reuse" would in practice have meant *restate*, which is exactly the drift the §2.2 invariant forbids. The build instead lifted each predicate to a shared export and had **both** the payload handler and the cursor import it: `ownedProductIds` / `vendorRequestsWhere` (`routes/vendor-shared.ts`), `ownedEndpointJoin` (`lib/attestation-authority.ts`), `vendorNotificationLedgerWhere` (`routes/vendor-notifications.ts`). The invariant is now enforced by the module graph instead of by a reviewer's eye, which is what §2.2 wanted and could not express before the helpers existed. The table above has been corrected; the old file:line citations were stale as well.
- **The `integrations` cursor deliberately does NOT filter `retracted_at IS NULL`,** unlike the list handler's `liveAttestationsWhere`. That is a *content* filter, not a scoping one. A bare retract stamps `retracted_at` on the existing row and inserts nothing, so a live-only cursor would sit still while the lane the vendor is looking at empties. This is the one place the cursor's `WHERE` is deliberately **wider** than its payload's, and it is safe because the extra rows are the caller's own. `vendor-updates.spec.ts` pins it ("the cursor must not filter to live rows").
- **`profile` reads `vendors.updated_at` directly and returns `null` for a deleted vendor row** rather than 404-ing. `GET /api/vendor/me` owns that 404; a cursor that threw would take the whole poll loop down alongside it, so the seat would lose its live surface *and* its error message at once.
- **`VENDOR_UPDATES_CHANGE_WINDOW_MS` (60 s) is the `changed` tag's whole definition** — see §7.1, because it is a metric decision rather than a response-shape one.

The `AUTH_AND_RLS.md` row, the `API_CONTRACTS.md` §6.14 shape row and the `OBSERVABILITY.md` catalog row all shipped and were re-verified against the handler at close-out (AECI-632).

---

## 3. `VendorPortalStore` — shared portal state (AECI-628)

Today each section of the dashboard fetches for itself (`vendor-seat-roster.ts` and `vendor-notifications-list.ts` are the pattern). That is correct for a page that loads once; it is the wrong shape for a page that revalidates, because there is no single place to reconcile into and no way for a write in one section to move a count in another.

**`apps/web/src/app/vendor/vendor-portal-store.ts`** — a signal-backed root store, seeded from the `vendorMeResolver` payload (`vendor-me.resolver.ts`) rather than by re-fetching on init, so first paint is unchanged and SSR stays exactly as it is. It owns:

- `me` (vendor + products + requests + seats + `entitlement`), `integrations`, `notifications`;
- a per-section **`dirty`** flag (§5's deferred-reconciliation input);
- `revalidate(scopes: readonly VendorPortalScope[])` — maps scopes through §2.3, **dedupes** (four scopes moving together issue one `me` call), and **coalesces in flight** (a second `revalidate` while one is outstanding must not double-fetch).

Sections read from the store instead of self-fetching. Zoneless + signals + `OnPush` throughout (`ANGULAR_STYLE_GUIDE.md`); the store is injected DI state, not a component input chain. *(As built: **not** `providedIn: 'root'` — see §3.1 and the "preview subclass must keep working" note directly below, which is the constraint that decided it. It is provided by the two surface owners.)*

**The preview subclass must keep working.** `apps/web/src/app/preview/vendor-dashboard/` renders the dashboard against `PreviewVendorApi` (`preview-vendor-api.ts`) with fixture data and no session. Whatever seam the store uses to fetch must be the same seam `PreviewVendorApi` already substitutes, or the preview route breaks silently — it is not covered by the authenticated e2e spec.

> **Rule 1 — never clobber an in-flight edit.** If a section holds unsaved local changes, the store **defers** reconciliation for that section and surfaces a non-blocking *"Updated elsewhere — reload this section"* affordance. **Silently replacing a half-typed form is worse than being stale.** This rule is implemented **here**, in the store, not in each section — a per-section implementation is a rule that six components can each forget.

### 3.1 As built (AECI-628 — 2026-08-19)

`apps/web/src/app/vendor/vendor-portal-store.ts`, seeded from the resolver exactly as specified — `seed()` is a synchronous signal write called from `VendorPage`'s constructor, so SSR's first render pass already has the payload and no round trip was added to first paint. The preview seam held: `VendorDashboardPreview` provides the store in the same `providers` array as its `VendorApi` shadow, so `/preview/vendor-dashboard` still runs the real components against fixtures.

Five things the §3 sketch did not pre-specify:

- **Deferral is per RESOURCE, not per section, and that is forced by the payload shape.** `profile`, `products` and `requests` are three sections of one `GET /api/vendor/me` body, so holding one holds all three, and `reload('profile')` therefore discards the unsaved edits of that whole section. Under `STAGE_2_SPEC.md` §8.1's concierge model (roughly one actively-editing seat per vendor) two sections dirty at once is not a launch scenario; a form that keeps its edits re-registers as dirty on its next change.
- **`markDirty` / `clearDirty` take an owner token.** "Products" is not one form — the section renders one `VendorProductForm` per owned product, and a bare `clearDirty('products')` from a clean sibling would drop a dirty form's registration and let the next poll overwrite it.
- **A deferred payload is STASHED, not dropped.** `reload(section)` takes the stash when there is one rather than re-requesting: the stash *is* the fresh server state, so a refetch would only add latency and a second chance to fail.
- **`apply()` returns a three-way handle** (`reconcile` / `rollback` / `commit`) and each resource carries a monotonic **version counter**. `rollback()` restores its snapshot only when the version is unchanged; if anything else wrote the resource in the meantime it re-reads from the server instead, because unwinding to the snapshot would silently undo the other write. §5's optimistic toggles are the consumer; the plain "splice the echo in" path is `apply(...).commit()`.
- **`revalidate()` never rejects.** A failed refetch sets that resource's status to `failed` and leaves the last good value on screen — a poll that empties the surface on one bad response is worse than a poll that misses a beat. §4 depends on this precise behaviour; see §4.5.

> **Drift hazard: the scope vocabulary is declared three times and the scope→resource map twice.** `VendorPortalScope` exists as a type in `packages/shared/src/api/vendor-updates.ts:81` (derived from the Zod schema's keys, so it cannot drift from the wire), **again** as a hand-written union in `vendor-portal-store.ts:75-81`, and is imported from `@aeci/shared` by `vendor-live-sync.ts:83`. The `SCOPE_RESOURCE` map likewise exists in both `vendor-portal-store.ts:143-150` and `vendor-live-sync.ts:100-107`, because the store's copy is module-private and the sync loop needs it to decide which cursors a failed refetch must hold back (§4.5).
>
> Adding a **seventh** scope is caught: the shared union gains a key, both `Record<VendorPortalScope, …>` maps fail to satisfy it, and `store.revalidate(sharedScopes)` stops typechecking against the store's narrower union. What is **not** caught is a **value** divergence — pointing `notifications` at a different resource in one map than the other compiles cleanly and produces a cursor that is settled against the wrong resource's status, i.e. a section that silently stops being live. If a third consumer ever needs the map, that is the moment to export one copy from the store and delete the other rather than write a third.

---

## 4. `VendorLiveSync` — the revalidation loop (AECI-629)

**`apps/web/src/app/vendor/vendor-live-sync.ts`**, plus `getUpdates()` on `VendorApi` (`vendor-api.ts`) and the start/stop wiring in `vendor-page.ts`. It polls §2, diffs the revision map against the last seen, and calls `store.revalidate(movedScopes)`.

### 4.1 Cadence

| Condition | Behaviour |
|---|---|
| visible **and** focused | poll every **20 s** (`VENDOR_SYNC_FOCUSED_INTERVAL_MS`) |
| visible, unfocused | poll every **60 s** (`VENDOR_SYNC_UNFOCUSED_INTERVAL_MS`) |
| hidden | **paused — no timer**, not a long interval |
| `visibilitychange` → visible | **immediate poll**, then resume the cadence |
| `focus` / `blur` | **reschedule only, never an immediate poll** — refocusing a tab that was visible the whole time has not made anything staler than it already was |
| `online`, **while visible** | **immediate poll**; **while hidden, ignored** |
| error | backoff `min(20 s × 2ⁿ, 160 s)`, floored at the current base cadence — i.e. **`Math.max(base, backoff)`** — reset to the base cadence on the first success |

Hidden is *paused*, not *slowed*: a background tab left open overnight would otherwise issue hundreds of requests nobody will look at, and the immediate poll on `visibilitychange` makes the resumed tab correct in one round trip anyway. The 160 s cap exists so a portal left open through an API outage settles at roughly one request every three minutes instead of compounding indefinitely — and so it recovers on its own when the API returns, without the vendor reloading.

**The `online` handler is gated on visibility, and that gate is load-bearing** (`vendor-live-sync.ts:260-263`). Connectivity returning is the moment a cursor is most likely to have moved, so answering it immediately is right — but a flapping connection fires `online` repeatedly, and a *hidden* tab that answered every one of them would reintroduce exactly the overnight cost the pause exists to remove, through a door the cadence table does not guard. Nothing is lost by ignoring it: a hidden tab polls immediately the moment it becomes visible, which is the only moment its answer can be read.

**The backoff is floored at the base cadence, not applied bare** (`vendor-live-sync.ts:377-388`). The first backoff step (20 s) is *shorter* than the unfocused cadence (60 s), so a bare ladder would make an unfocused tab poll **three times faster while the API is failing** than it does while the API is healthy — answering an outage with more load than the happy path, which is backwards. `Math.max(base, backoff)` means the ladder only ever takes effect once it exceeds the cadence the tab would have used anyway: a focused tab sees 20 → 40 → 80 → 160 s, an unfocused one sees 60 → 60 → 80 → 160 s.

### 4.2 Lifecycle

**Browser only.** Started from `afterNextRender`, torn down through `DestroyRef`. It must never run during SSR — the SSR Worker has no window, no visibility state, and no business holding a timer. This is the ordinary `ANGULAR_STYLE_GUIDE.md` SSR-safety rule; the failure mode if it is broken is not a crash but a Worker that never finishes the render.

### 4.3 No WAF exposure

The blanket `/api/*` rate-limit rule was **removed** when both Cloudflare Pro slots were spent on the two write endpoints (`docs/waf-rate-limits.md` §"2-slot trade-off"); both remaining rules are **POST-only**. A 20-second authenticated GET trips nothing, and this epic must not become the reason someone re-proposes a third slot that does not exist.

### 4.4 The intervals are tunables, and the metric is their evidence

The three intervals and the backoff cap are **compute constants in the web bundle**, in the same class as the attestation detector knobs — change the constant, ship through a normal deploy. They ship as four named exports from `vendor-live-sync.ts` — `VENDOR_SYNC_FOCUSED_INTERVAL_MS` (20 s), `VENDOR_SYNC_UNFOCUSED_INTERVAL_MS` (60 s), `VENDOR_SYNC_BACKOFF_BASE_MS` (20 s), `VENDOR_SYNC_BACKOFF_CAP_MS` (160 s) — exported specifically so the component specs assert against the constant rather than a copied literal. They are listed in `docs/POST_LAUNCH_MONITORING.md` §3 alongside `NOTIFICATION_HISTORY_DAYS` / `NOTIFICATION_PAGE_SIZE`, with the retune signal named: **the `aeci.api.vendor.updates{changed:none}` ratio**. A high `none` ratio means the cadence is faster than the portal changes — lengthen the interval before doing anything else. A high `some` ratio is the opposite finding and is ADR 0023's third re-open condition.

### 4.5 As built (AECI-629 — 2026-08-19)

`apps/web/src/app/vendor/vendor-live-sync.ts`, provided by `VendorPage` alongside the store (it injects the store, so a root-provided loop could not resolve it) and started from `afterNextRender` on the **success path only** — `vendor-page.ts:93-104` gates `start()` on the resolved payload, because the `me === null` branch has no session to poll with and would only 401 in a loop. Teardown is the service's own `DestroyRef` hook, so `stop()` runs on navigation away as well as on destroy, and it releases all four listeners.

§4.1's two corrections above (`online` visibility gate, `Math.max` backoff floor) are the divergences. Four further rules were decided at build and are subtle enough to be re-broken:

- **The first response seeds, it does not revalidate.** The page loads from the SSR-resolved `me` payload, but that payload carries no cursor and the endpoint keeps no per-client state to derive one from. So the first poll records the revision map and refetches nothing. Diffing against an empty baseline would read all six scopes as moved and fire three refetches of data already on screen, on **every** portal load.
- **A cursor is "seen" only once its refetch landed.** `revalidate()` never rejects (§3.1), so a baseline advanced on the strength of the cursor read alone would mean the loop never looks at that scope again: one transient 5xx on `GET /api/vendor/integrations` would strand the integrations tab behind a retry button until that cursor happened to move on its own, which can be hours. Instead the baseline is settled **per scope, after the refetch** — a moved scope whose resource came back `failed` keeps its *previous* revision, so the next poll re-detects it and retries. The existing cadence and backoff carry the retry rate; there is no second retry mechanism to keep in sync, and one failing endpoint never holds another back.
- **A dirty-deferred scope is NOT a failed one, and must not be held back.** This is the rule most likely to be "fixed" into a bug by the next reader. When a section holds unsaved edits the store *stashes* the fresh payload deliberately and reports the resource `loaded` — the write succeeded, it is simply not being applied yet, and the vendor has an explicit "reload this section" affordance. `settle()` therefore tests `hasFailed(resource)` and **not** "did the value I hold change": treating a deferral as a failure would let one half-typed form pin that cursor and refetch the same payload every 20 s for as long as the form stays dirty, forever if the vendor walks away mid-edit. Reading `failed` specifically is the whole of what keeps the two apart (`vendor-live-sync.ts:325-337`).
- **Revisions are compared with `!==` on the raw strings, never `Date.parse`.** SQLite's `MAX()` over a TEXT column is lexicographic and every `*_at` column is an ISO UTC string, so lexicographic and chronological order coincide; string equality also means a value the server can produce but `Date.parse` mangles can never be mistaken for "unchanged". Nothing in the loop does arithmetic between a server timestamp and `Date.now()` — `lastCheckedAt` reports the server's instant purely as an affordance, and scheduling uses relative `setTimeout` delays only.

**No WAF or cache surface materialised**, as §4.3 predicted: the poll is an authenticated GET against `private, no-store`, both Pro rate-limit slots remain POST-only, and no file under `apps/web/src/server/` was touched by this epic.

---

## 5. Optimistic writes — toggles yes, forms deliberately no (AECI-630)

Owns `vendor-attestation-control.ts`, `vendor-claim-lane.ts`, `vendor-add-claim-form.ts` (+ specs).

**Toggle-shaped writes are optimistic.** Assert / deny / retract apply **locally first**, then reconcile against the server echo, and **roll back with a visible error** on failure. These are single-bit commands with an unambiguous intended end state, they are already rendered as plain buttons that write on activation (`DESIGN.md` → Vendor portal), and the round trip is the only thing between the click and the answer. A silent rollback is not acceptable: a reverted toggle with no message reads as a UI glitch, and the vendor will click it again.

**Form-shaped writes stay pessimistic, on purpose.** Profile and product edits keep their existing echo-reconcile — submit, wait, then render what the server returned. **Showing "Saved" before it saved is a worse lie than a 300 ms wait**, and a form has a large surface of partially-valid intermediate states that an optimistic render would have to guess at. This is a decision, not an omission; it is written down here so a later reviewer does not "finish the job".

> **`VendorAttestationPosition` stays whole-position.** `vendor-api.ts:61-66` declares all four fields **required** specifically because the endpoint is a `PUT` that replaces the whole position, while every neighbouring `/api/vendor/*` write on this dashboard is a `PATCH` that takes only changed fields — the comment there says the required fields turn that mistake into a compile error instead of a data-loss report. An optimistic patch **must not** become the partial-update bug that type exists to prevent: build the optimistic value through `VendorAttestationControl`'s single `position()` helper, exactly as a real write does.

### 5.1 As built (AECI-630 — 2026-08-19)

Toggles optimistic, forms pessimistic, as specified. The whole-position rule held literally: `position(asserted)` is built **once** per write and the same object is both spread into the optimistic rows (`ownRows()`) and sent as the `PUT` body (`vendor-attestation-control.ts:385-403`). Two separately-built positions is precisely how an optimistic path drifts into a partial update, so the single-build is the mechanism, not a convention.

Four decisions §5 did not pre-specify:

- **The optimistic patch touches the caller's OWN rows and nothing else.** `patchOwnRows()` replaces `claim.mine` and leaves `agreement` and `counterparty` exactly as they were. The dashboard never re-derives `computeAgreement` (`STAGE_2_ATTESTATIONS_SPEC.md` §4), and it could not do so honestly anyway: `counterparty` is a *lossy* reduction of every other voter, so with a third vendor in play a local guess can render a genuine `conflict` as `single_source`. The `PUT` echo carries the recomputed agreement, which is why `reconcile()` takes the whole claim.
- **A retract is optimistic too, but settles with `commit()`, not `reconcile()`.** `DELETE` answers `204` with no body, so there is nothing to reconcile *from*; the interim (own rows removed) stands and the section issues one targeted re-read, spliced by claim id so a concurrent write on another lane is not clobbered. This is the only write on the surface whose optimistic state is deliberately allowed to outlive the response.
- **Rollback and the visible error ship together, always.** Both `catch` blocks call `mutation.rollback()` and set a lane-local `role="alert"` in the same statement pair. A reverted toggle with no message reads as a UI glitch and gets clicked again — §5 said so and the code enforces it by never having a rollback path without an error path.
- **The pessimistic forms are what wire Rule 1.** `vendor-profile-form.ts:473-474` and `vendor-product-form.ts:384-385` register/clear dirty state off their own change tracking, and `vendor-product-form.ts` passes the **product id** as the owner token so one dirty product form does not speak for its clean siblings. `isStale()` drives the "Updated elsewhere — reload this section" affordance. Without these two call sites the store's deferral machinery would be dead code, which is why they landed in the optimistic-writes issue rather than the store issue.

---

## 6. Surfacing and the a11y contract (AECI-631)

Owns `vendor-plan-panel.ts`, `vendor-dashboard-tabbed.ts`, `vendor-notifications-list.ts`, `vendor-integrations-section.ts` (+ specs). *(As built it also added two root services — `vendor-announcer.ts` (§6.3) and `vendor-notification-baseline.ts` (§6.2) — and, after the issue closed, the matching region in `vendor-dashboard-single.ts`.)*

### 6.1 The entitlement flip lands without a reload

The concierge toggle is the one event with a real deadline (§1). When `entitlement` moves, the plan panel and every editable section **re-derive from the refetched `me` payload** — never from a client-side re-derivation of the tier ladder. The registry is server-side data (`packages/shared/src/entitlements.ts`, `STAGE_2_PAID_TIERS_SPEC.md` §3.1) and an unknown tier fails closed to **zero** capabilities; a client that re-implements the ladder would fail *open* on exactly the tier it does not recognize.

**The rule is not "always read `capabilities`" — it is: the client gates on whatever field the API gates on.** The point of §6.1 is that the enabled state of a control and the answer a write would get can never disagree, and the only way to guarantee that is to read the same bit the server asserts on. Today that means two fields, because the API asserts on two:

| Section | API gate | Client reads |
|---|---|---|
| Profile edit | `requireCapability(c, 'profile.edit')` — `routes/vendor.ts:582` | `me.entitlement.capabilities` |
| Product edit / taxonomy | `requireCapability(c, 'product.edit' \| 'product.taxonomy.edit')` — `routes/vendor.ts:668,673` | `me.entitlement.capabilities` |
| Attestation authoring, product versions | `assertVerifiedVendor(vendor)` — reads **`vendors.verified`** (`routes/vendor-shared.ts:238-246`) | `me.vendor.verified` |

Switching the Integrations section to `capabilities.includes('attestation.author')` today would put the **UI gate ahead of the API gate**, which is the exact disagreement this section exists to prevent: `'attestation.author'` is still declared `// AECI-301 — declared, no consumer yet` (`packages/shared/src/entitlements.ts:58`), so a vendor whose tier grants it would see enabled controls and collect a 403 on click. **It flips live either way** — `vendors.verified` is a *mirror* of the entitlement row, written in the same `db.batch` as the entitlement (`STAGE_2_PAID_TIERS_SPEC.md` §2.1), so the same admin action moves both fields and the same `profile`/`entitlement` cursor movement delivers both.

**What would have to change for it to become a capability:** `assertVerifiedVendor` is a deliberate single-function, single-call-site-per-handler placeholder (its own doc comment says so) precisely so the swap is mechanical. Replace its body with `requireCapability(c, 'attestation.author')`, drop the `// no consumer yet` comment in `entitlements.ts`, and flip `[verified]="m.vendor.verified"` to a `canAuthorAttestations()` computed in **both** dashboard shells in the same change. Doing the client half first is the failure mode; doing the server half first is merely redundant.

### 6.2 New notifications are a count, never a banner

A **session-scoped "N new" count** on the notifications disclosure. Nothing more.

> **Still true after `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.5 (2026-08-27).** The disclosure moved out of the Integrations tab into a new vendor-level **Messages** section. That is a *findability* change — the archive had been buried inside a tab that has itself now moved under a product — and it changes none of this rule. No banner, no unread badge, no auto-expand, no "mark as read"; the count stays session-scoped and stays inside the summary line. What Rule 2 forbids is promoting historical rows to live assertions, not giving them an address.

> **Rule 2 — notifications are historical, not live state.** `vendor-notifications-list.ts` argues this at length and the argument is binding: the endpoint reads the §7.3 `audit_log` ledger of nudges that were **emailed**, over a 90-day window. Rendered prominently, a three-week-old *"Vendors disagree"* row would sit above a lane whose badge now reads `confirmed`, and **the surface would visibly contradict itself**. A count of items that arrived during *this session* is a fact about this session and is fine. A banner asserting current state is not.

**As built:** "new" is defined by `VendorNotificationBaseline` (`apps/web/src/app/vendor/vendor-notification-baseline.ts`), a second injects-nothing root service, and three of its properties are load-bearing rather than incidental:

- **It is a set of ids, not a timestamp.** That needs no assumption about ordering and no comparison between a server timestamp and the browser's clock. Same answer while the list is newest-first (which it is), still the right answer if a later change pages or re-sorts it.
- **It is root-scoped for the same reason it is a service at all.** The disclosure lived inside the Integrations section (it is in **Messages** since `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.5, which changes where the subtree is but not that it is destroyed on a section change), and Concept A destroys that subtree whenever the vendor looks at Products. A baseline captured in the component would be re-captured on every section change, from a list that by then already includes the rows that arrived while the section was closed — so the count would reset to zero exactly in the case it exists to report. The poll refreshes notifications regardless of which section is open, so that case is the normal one, not an edge. *(The sections were an in-page `@switch` when this was written and are child routes since `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2 — the router destroys the outlet's component exactly as the `@switch` destroyed its branch, so the reasoning and the conclusion are unchanged.)*
- **It is keyed by vendor and captured once per vendor.** Root state outlives the route, so signing out and back in as a different vendor without a reload would otherwise measure new rows against the old vendor's baseline — no id would match and *every* row would read as new. Capture is also idempotent per vendor, so a later refetch that brings new rows in cannot quietly re-baseline them away. **No `localStorage`, no cookie, no cross-session claim**: "3 unread" across reloads is a read-state assertion this system has nowhere to store and no way to keep true.

### 6.3 One live region — hoisted, never duplicated

**Before this issue there was exactly one polite live region on this surface, in the wrong place.** `vendor-integrations-section.ts` shipped `<p class="sr-only" role="status">{{ liveMessage() }}</p>`, and `vendor-integration-card.ts` carried a second `role="status"` of its own; `docs/TESTING_STRATEGY.md` §8.2 named the first as part of the `/vendor` axe contract.

**Hoist that one region to the dashboard shell. Do not add a second.** Two live regions on one page make announcements **race and duplicate** — the screen reader gets two competing queued utterances for one event and the vendor hears the wrong one, or both. Update `TESTING_STRATEGY.md` §8.2 to match wherever it ends up, in the same change.

> **As-built correction — the region is fed by a service, not by the store.** §6.3 originally said "feed it from the store". It is fed by **`VendorPortalAnnouncer`** (`apps/web/src/app/vendor/vendor-announcer.ts`), an `@Service()` root singleton holding one transient string, and the shells bind `<p class="sr-only" role="status">{{ liveMessage() }}</p>` to its `message` computed. Three reasons, in the order they mattered:
>
> 1. **Hoisting creates a reach problem the store cannot solve.** Once the region lives in the shell, a control five levels down has to say something into a region it does not render. A prop chain would thread an output through every component in between — several of which AECI-631 does not own — and every new announcing surface would have to re-thread it. A service is the channel; `announce(...)` is the only way to speak, which is what keeps "exactly one region" true as the portal grows.
> 2. **Announcement copy is presentation, not portal data.** The store owns what the server said. The wording ("RFIs · position saved") originates in the component that can name the subject, and its `$localize` ids stay with the components that already own the surrounding wording — putting them in the store would make it a second place to look for UI text.
> 3. **`root` is safe here and deliberately is not for the store.** `VendorPortalStore` is surface-scoped because it injects `VendorApi`, which the preview shadows in a component `providers` array; a root store would walk past the shadow and fire real network calls. The announcer **injects nothing and fetches nothing**, so it has no binding a DI shadow could resolve wrongly — and root is what lets *both* dashboard concepts read the same channel without a provider each.
>
> The service also solves a problem the spec did not anticipate: a live region announces when its **text changes**, so retracting two positions in a row produces the identical sentence twice, the text node does not change, and the second retract is **silent** — which reads as "the click did nothing". `message` carries a sequence number and alternates a trailing U+00A0, an established live-region technique: the DOM text differs every time and a no-break space is not spoken.

> **As-built correction — both concept shells host a region, and that is correct.** §6.3 said "the dashboard shell", singular, because Concept A (`vendor-dashboard-tabbed.ts`) is what the portal renders. Concept B (`vendor-dashboard-single.ts:144`) was given one too, after AECI-631 closed: it composes `VendorIntegrationsSection`, which announces through the channel and declares no region of its own, so without it **every attestation write on Concept B was silent to a screen reader**. The two cannot race — `VendorPage` renders only Concept A, and the preview's `@switch` renders exactly one concept at a time — so "exactly one live region on the page" holds on every surface that exists. It still holds after `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2 moved the sections onto child routes: the region is in the **shell**, which is the layout route's component and therefore outlives every outlet swap. `vendor-dashboard-tabbed.component.spec.ts` pins that by asserting the region is the *same node* before and after a section navigation. If a third surface ever composes a vendor section, it owes a region for the same reason; the tripwire is that the announcer has no DOM of its own.
>
> **Unchanged by `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.4** (the nav went horizontal and Products became a filterable dropdown): the region is still the last child of the shell's `<section>`, still the same node across an outlet swap, still the only one. The new tripwire that change introduces is the dropdown itself — **a nav panel that announced "20 products match" would be exactly the forbidden second region**, so `vendor/vendor-products-menu.ts` declares none and lets the combobox's own listbox carry the count. The same §6.3 no-reflow rule is why that menu freezes its option list while it is open: a 20 s poll that adds or drops a row under a pointer already travelling toward one is the failure this section exists to prevent.

> **As-built correction — "never a second `role='status'`" was the wrong rule, and the right one is narrower.** Taken literally, that sentence forbids the ordinary save confirmation beside a Save button, which is good practice and which this surface has always had. Four conditional `role="status"` elements survived the hoist, and auditing them is what produced the real invariant:
>
> **One _channel_ for anything the user did not just do — cross-section updates, background revalidation, the outcome of a write on another tab. A local `role="status"` is permitted _only_ for immediate feedback on an action the user just took, beside the control they took it with. The two must never fire for the same event.**
>
> That rule keeps the three legitimate cases and rejects the one that was actually broken:
>
> | Element | Fires when | Verdict |
> |---|---|---|
> | `vendor-profile-form.ts:247` | the vendor's own save succeeded | **keep** — action feedback, and the Profile tab never announces |
> | `vendor-product-form.ts:195` | the vendor's own save succeeded | **keep** — same |
> | `vendor-add-claim-form.ts:218` | the lane the vendor is composing already exists | **keep** — feedback on the vendor's own input, and the channel never announces this |
> | `vendor-attestation-control.ts` divergence notice | two owned slots record different details | **REMOVED (2026-08-19)** |
>
> The last one was a genuine defect and is fixed in code, not in prose. It is not feedback on an action: it describes a **standing condition** of the claim, it is `computed` off store data that a **background revalidation can move**, and it sits on the one tab that announces through the channel. So a poll could flip it at the same moment `announce(...)` fired, queueing two utterances for one event — precisely what the single channel exists to prevent. It is now plain text; `vendor-attestation-control.component.spec.ts` asserts it carries neither `role` nor `aria-live`, so the rule is enforced rather than remembered.
>
> **Why no automated gate catches this class.** Multiple live regions are valid ARIA, so **axe cannot flag it**, and the e2e count assertion has to be scoped to `.sr-only` precisely because the three legitimate regions exist. The remaining three are correct by the rule above but have **not** had a real screen-reader pass under a live revalidation — that is the manual lane in `docs/a11y-manual-testing-checklist.md`, and it is the open follow-up this epic hands over.

The region's constraints are unchanged and non-negotiable:

- **`role="status"` (polite), never `assertive`.** A background revalidation is not an interruption.
- **Never focus-stealing.** A poll landing mid-keystroke must not move focus.
- **Never a layout shift under the pointer.** A revalidation that reflows the control the vendor is about to click is a worse outcome than the staleness it fixed.
- Failures stay **lane-local and `role="alert"`**, beside the control that failed — the split `DESIGN.md` already documents for this surface.

### 6.4 Close-out coverage (AECI-632)

- **Extend `apps/web/e2e/vendor-dashboard.spec.ts` (AECI-606) — do not add a new spec.** It is the one place that mints a real `vendor_admin` session (`SUPABASE_VENDOR_TEST_USER_*`, per AECI-522); a new spec would have to duplicate that mint, and an unmintable spec silently degrades to testing the 404 render.
- **axe pass on `/vendor` with the live region present**, after the hoist — the region moving is exactly the kind of change that invalidates a prior pass.
- **Reconcile every `AECI-516` / "real-time" mention across the docs** against what shipped, and add the `§X.N As built` subsections here. Per `STAGE_2_ATTESTATIONS_SPEC.md` §10's "one generalizable lesson": **grep for the artifact across `**/*.md`, not for the topic** — the docs that go stale are the ones that merely *count* or *enumerate* something, not the ones a change is about.

### 6.5 As built (AECI-631 — 2026-08-19)

The entitlement flip, the session count and the hoist all shipped; the three as-built corrections are recorded inline above (§6.1's two-field gate, §6.3's announcer service, §6.3's two concept shells). Two further notes:

- **`me` must never be latched at construction.** The flip lands because `VendorPage` binds `[me]` to `VendorPortalStore.me`, so a refetched payload flows into the shells' `input.required` and every `computed` re-derives — the plan panel changes state, the forms unlock, the Integrations section gains its controls. *(Since `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2 the routed sections read `VendorPortalStore.me` directly and derive their capability gate through `vendor/vendor-capabilities.ts`, which is the same signal by a shorter path — the rule is identical and now applies to those files too.)* Copying `me()` into a `signal` in a constructor anywhere in this subtree silently reverts the whole of §6.1 with no test failing. Read it through a `computed`, always.
- **The section's loading and failure paragraphs are deliberately not live regions**, and neither is the integration card's pivot notice. The block carries `aria-busy` while it loads. The one moment where silence would be wrong — a vendor pressing "Try again" and getting no feedback — announces its outcome explicitly through the channel instead (`vendor-integrations-section.ts:251-259`, `vendor-notifications-list.ts:224-233`).

> **Finding, and its resolution — the audit of the surviving conditional `role="status"` elements.** AECI-632 found four *inserted* status elements besides the announcement channel, each a live region by definition, and reported §6.3's "never a second" as literally false. Auditing them produced the corrected rule now recorded in §6.3, and one code fix:
>
> | File | Rendered when | Tab | Outcome |
> |---|---|---|---|
> | `vendor-profile-form.ts:247` | a profile save succeeded | Profile | **keep** |
> | `vendor-product-form.ts:195` | a product save succeeded | Products | **keep** |
> | `vendor-add-claim-form.ts:218` | the lane being composed already exists | **Integrations** | **keep** |
> | `vendor-attestation-control.ts` divergence notice | two owned slots record different details | **Integrations** | **role removed 2026-08-19** |
>
> The three kept cases are all **immediate feedback on an action the user just took**, beside the control they took it with, and none of them fires for an event the channel also announces — which is the §6.3 rule as corrected. Forbidding them would forbid the ordinary save confirmation, which was never the intent.
>
> The fourth was a real defect, and it is fixed in code rather than documented as debt. It is not action feedback: it describes a **standing condition**, `divergentSlots()` is `computed` off store data a **background revalidation can move**, and it sits on the one tab that announces — so a poll could flip it at the same moment `announce(...)` fired. It is now plain text, and `vendor-attestation-control.component.spec.ts` asserts it carries neither `role` nor `aria-live`.
>
> **What remains open is verification, not correctness.** axe will never report this class (multiple live regions are valid ARIA), and the §6.6 e2e assertion scopes itself to the `sr-only` channel precisely because the three legitimate regions exist. The three have **not** had a real screen-reader pass under a live revalidation. That belongs in `docs/a11y-manual-testing-checklist.md`'s manual lane and is the follow-up this epic hands over.

### 6.6 As built (AECI-632 — 2026-08-19) — the close-out

`apps/web/e2e/vendor-dashboard.spec.ts` was extended rather than duplicated, as §6.4 requires. What landed:

- **Two pre-existing assertions had to be repaired, and they are the reason the hoist needed e2e at all.** `getByRole('status')` was used bare at two places in that spec (after a profile save, and after an affirm). The hoisted region is `role="status"` and is in the DOM from first paint, so both locators now match **two** elements and fail Playwright's strict mode — a real break that shipped green only because the spec skips without `SUPABASE_VENDOR_TEST_USER_*`. Both were narrowed to the element they actually meant.
- **A live-surface test** asserting the region exists, is polite (`role="status"`, no `aria-live="assertive"`), is `sr-only`, and is present on the Vendor Overview section before the Integrations read has happened.
- **The "exactly one" assertion is scoped to the announcement channel** (`[role="status"].sr-only`), not to every `[role="status"]` on the page — see the open finding in §6.5. The at-rest Vendor Overview section additionally asserts one region unscoped, which is the strongest claim the current tree can honestly support.
- **The axe pass runs with the Integrations section open**, after the hoist, per §6.4.

**The gated tests skip without a minted vendor session and that is by design** (§6.4). At close-out the credentials were not set locally, so the suite was verified to *collect* (`npx playwright test --list` → 5 tests) and the a11y half was additionally run against **`/preview/vendor-dashboard`**, which needs no session and renders the same components through `PreviewVendorApi`:

| Surface | `[role="status"]` | channel (`.sr-only`) | axe (WCAG 2.0/2.1 A+AA) |
|---|---|---|---|
| Concept A — Overview | 1 | 1 | 0 violations |
| Concept A — Integrations tab | 1 | 1 | 0 violations |
| Concept B — single page | 1 | 1 | 0 violations |

An affirm on each concept moved the channel to `Models · position saved.` (plus the alternating trailing U+00A0) and left the `[role="status"]` total at one, which is the §6.3 contract exercised end to end on both shells. **This is a partial substitute, not the gated run:** it covers the only surface where Concept B's region is reachable at all, but not the real authz path, the real `GET /api/vendor/integrations`, or the write round-trips. Treat the gated tests as unverified until `SUPABASE_VENDOR_TEST_USER_EMAIL` / `_PASSWORD` are set (`docs/environments.md`, AECI-522).

---

## 7. Observability (AECI-627)

**`aeci.api.vendor.updates`** — a count, tagged **`changed` ∈ `none | some`**. One catalog row in `docs/OBSERVABILITY.md`; no new dashboard widget and no monitor at launch.

This metric is not decorative — it is what makes ADR 0023 a **reviewable** decision instead of a permanent one:

- a high **`none`** ratio means the poll cadence is faster than the portal actually changes ⇒ **lengthen the interval** (§4.4), the cheapest possible response;
- a high **`some`** ratio means there genuinely is that much to deliver ⇒ that is ADR 0023's **third re-open condition**, and the argument for adopting a hibernating Durable Object.

Deliberately **not** emitted: a per-scope breakdown of *which* cursor moved. It would multiply the series by six to answer a question nobody has asked, and the two-value `changed` tag already separates the only two outcomes that lead to different actions.

The endpoint also rides the existing `aeci.api.query.duration_ms{endpoint:…}` timing every route emits; no new latency metric is warranted for a single batched read.

### 7.1 As built (AECI-627 — 2026-08-19)

Shipped as one `submitCount(..., 'aeci.api.vendor.updates', 1, ['changed:…'])` at the end of the handler, one catalog row in `docs/OBSERVABILITY.md`, no widget, no monitor.

**The `changed` tag needs a definition the spec did not give it, and the definition changes how the ratio must be read.** §7 says `some` vs `none` as though the endpoint knew whether anything changed *for this caller since their last poll* — it does not, and deliberately never will: it is **stateless** and keeps no per-client cursor (that is the same property that makes it cheap and makes `no-store` correct). So `changed:some` is defined as *"the newest of the six cursors falls inside `VENDOR_UPDATES_CHANGE_WINDOW_MS` of this response"* — i.e. **"would a poll at the shipped cadence have carried news?"**, which is the question the metric actually feeds.

The window is **60 s**, the *longest* shipped interval (visible-but-unfocused), not the shortest. That over-counts `some` for a 20 s focused client — one write can be tagged `some` on three consecutive polls — and the over-count is deliberate: the decision this series feeds is "is polling still the right transport, or is it time for the Durable Object?", and that decision must not be biased toward "nothing ever changes". **Read the `some` ratio as an upper bound**; read the `none` ratio as the reliable one, since a `none` is unambiguous. An unparseable cursor counts as `none` — a metric must never be the thing that 500s a request.

`docs/OBSERVABILITY.md`'s catalog row carries this definition verbatim, so an operator reading the dashboard does not have to come here for it.

---

## 8. Deliberately out of scope

Recorded so the boundary is explicit, and so a later reader can tell a decision from an omission.

- **Durable-Object WebSockets and SSE.** Declined in ADR 0023, with three named re-open conditions. **Not** "never" — but re-proposing one without evidence against a trigger is re-litigating a dated decision.
- **A `vendor_revisions` table or any other stored revision counter.** §1.2: it would have to be maintained by every writer across three epics, which is the fan-out coupling the transport decision declined.
- **Multi-seat conflict resolution / presence / "who else is editing".** `STAGE_2_SPEC.md` §8.1's concierge model caps launch concurrency at roughly one actively-editing seat per vendor. §3's Rule 1 (defer, don't clobber) is the whole of the coordination story; real coordination is ADR 0023's **second** re-open trigger and arrives with the socket, not before it.
- **Live updates on any public surface.** The public directory, product, vendor, and pair pages are **edge-cached** and stay that way (ADR 0020). Nothing in this epic may be imported by a cacheable SSR component, and no `Cache-Tag` or purge is emitted anywhere in it.
- **Push notifications / Web Push / a service worker.** A different channel with a different consent model; email remains the out-of-app channel (`STAGE_2_ATTESTATIONS_SPEC.md` §7.2).
- **Real-time on the `/admin` operator console.** `ADMIN_PANEL_SPEC.md` ships an explicit **Recompute** button (`DESIGN.md` → Operator console); an admin surface with an intentional manual refresh is a different design decision and is not disturbed here.
- **Moving the detectors off the daily cron to write-triggered evaluation.** Attractive, and it would materially improve nudge latency — but it is a change to `STAGE_2_ATTESTATIONS_SPEC.md` §7's pipeline, and it is ADR 0023's **first** re-open trigger. Doing it inside this epic would silently invalidate the decision this epic is built on.

---

## 9. Cross-references

| Topic | Where |
|---|---|
| The transport decision, the cost analysis, the re-open trigger | **ADR 0023** (`docs/adr/0023-vendor-portal-live-updates-via-revalidation.md`) |
| The Stage 2 scope outline this supersedes | `STAGE_2_SPEC.md` §2.3, §8.6 (and §8.2's now-struck third bullet) |
| The `/api/vendor/*` authz seam and dashboard this makes live | `STAGE_2_VENDOR_PORTAL_SPEC.md` §4, §6 |
| The detector/notification pipeline whose in-portal delivery this completes | `STAGE_2_ATTESTATIONS_SPEC.md` §7 |
| The entitlement whose concierge flip is the one real deadline | `STAGE_2_PAID_TIERS_SPEC.md` §2, §5 |
| Per-endpoint auth + scoping rows | `AUTH_AND_RLS.md` |
| Endpoint shape + error rows | `API_CONTRACTS.md` §6.14, §4 |
| The metric catalog row | `OBSERVABILITY.md` |
| The poll-interval tunables | `POST_LAUNCH_MONITORING.md` §3 |
| The `/vendor` axe contract and the live region | `TESTING_STRATEGY.md` |
| The `/vendor` surface's visual + a11y rules | `DESIGN.md` → Vendor portal (Stage 2) |
