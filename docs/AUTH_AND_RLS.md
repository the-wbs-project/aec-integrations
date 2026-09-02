# AEC Integrations — Authorization Model, GRANTs & RLS Policies

**Referenced by:** `STAGE_1_SPEC.md` §8 (Authentication), §15 (Security), §22 (Content Moderation), §26 (Audit Trail), `DATABASE_SCHEMA.md` §12, `STAGE_2_VENDOR_PORTAL_SPEC.md` §2–§4/§7/§10
**Version:** 3.1
**Date:** July 2026

> **v3.1 (AECI-525, 2026-07) — vendor-authz completion pass.** Documents the Stage 2
> `vendor_admin` surface end-to-end: the role-exclusivity & grant/revoke/ban rules (§3.2), the
> split-identity claimant **seam #4** (§3.1), the `/api/vendor/*` `vendor_id`-scoping seam +
> endpoint rows (§4.4), and the GDPR **last-seat edge** (§8.2). All of it is the **Worker
> (Layer-1) model — there is no RLS on app tables** (ADR 0016); the sibling `DATABASE_SCHEMA.md`
> §12 was reconciled to the same reality.

---

> **⚠️ ADR-0016 status banner (added AECI-234, 2026-06-25).** This document (v3.0)
> describes the **pre-ADR-0016** authorization model: Prisma Accelerate over Supabase
> Postgres with a 3-layer stack (Worker guard → PostgREST GRANTs → RLS). **ADR 0016**
> (accepted 2026-06-22) moved the **application database to Cloudflare D1 (SQLite)**,
> which has **no row-level security and no PostgREST**. Consequently:
>
> - **Layer 1 (the Worker guard) is now the *only* authorization layer for app tables.**
>   `requireAuth()` / `requireAdmin()` (`apps/api/src/lib/authz.ts`) verify the JWT,
>   re-fetch role + ban state from D1, and **every read carries its own
>   ownership/visibility filter** — there is **no DB backstop** if a query forgets one
>   (ADR 0016 §4 + "Consequences").
> - **Layers 2–3 below (PostgREST GRANTs + RLS) no longer apply to `reviews` / `profiles`
>   / the other app tables.** The GRANT/RLS migration that defined them was archived under
>   `supabase/archive/migrations/` when the Postgres app schema was decommissioned
>   (AECI-278); `supabase/migrations/` is now a single **auth-only baseline**
>   (`20260626000000_auth_only_baseline.sql`). The scripts that applied/verified that
>   surface (`scripts/apply-authorization.sql`, `scripts/verify-rls.sql`) were deleted.
>   Treat the GRANT/RLS sections here as **historical / Supabase-Postgres-only**, dead for
>   the D1 app tables. Supabase is retained for **Auth only**.
> - **The acceptance gate is the app-layer "no-leakage test matrix"** (ADR 0016 §4), not
>   a PostgREST RLS deny-matrix. For `reviews` / `profiles` it lives in the unit lane:
>   `apps/api/src/routes/reviews.authz-matrix.spec.ts` +
>   `profiles.authz-matrix.spec.ts` (AECI-234) — they compose the real guards with the
>   real read **and write** handlers over the in-memory D1 harness and assert the full
>   deny-matrix (anon / non-owner / banned-owner / admin × approved·pending·rejected, plus
>   the write paths rejecting anon/banned/non-admin before the handler) end-to-end.

## 1. Authorization model at a glance

> **Post-ADR-0016 reality (read the status banner above).** The application tables now live in **Cloudflare D1**, reached via **Drizzle** over the native `DB` binding — there is no PostgREST and no RLS for them. **Layer 1 is the only authorization layer for app tables.** The three-layer model and the diagram below describe the **historical Supabase-Postgres** stack and are kept for context.

There were **three layers** of authorization in front of the (then-Postgres) database. Layer 1 handles ~all real traffic; Layers 2 and 3 were defense in depth against PostgREST exposure.

```
                                                                ┌─────────────┐
  Browser ── HTTPS ──► SSR Worker ──► API Worker ── Drizzle ────► D1 (SQLite) │
                          (JWT)        (JWT verify,  (DB binding)             │
                                        role check,                          │
                                        audit log)                           │
                                                                └─────────────┘

  (historical Supabase-Postgres path, now dead for app tables)
  Browser ── HTTPS ──► PostgREST (/rest/v1/*) ── anon/auth ──► Postgres
                                                  │
                                                  ├─► GRANT check (binary, table-level)
                                                  └─► RLS check   (row-level filter)
```

**Layer 1 — Worker authorization (primary, and now the only layer for app tables).** All real traffic flows through the API Worker. The Worker verifies the user's Supabase JWT, looks up their role and ban status, runs Zod validation, calls Drizzle (D1), and writes an audit log entry into the same atomic `db.batch([...])`. This is where authorization actually happens.

**Layer 2 — PostgREST GRANTs (historical, Supabase-Postgres-only).** Supabase's PostgREST endpoint at `/rest/v1/*` is enabled by default. The anon key is publicly embeddable and can hit it. The GRANT layer was binary: if `anon` or `authenticated` had no `GRANT SELECT` on a table, PostgREST returned `42501 insufficient_privilege` immediately, before RLS was even consulted. Tables with no grant were invisible — full stop. **This applied only to the Postgres app tables, which are now in D1; it is dead for app tables.**

**Layer 3 — RLS row-filtering (historical, Supabase-Postgres-only).** For tables that *were* granted (the public-read tables: vendors, products, reviews, etc.), RLS filtered which rows were returned. Promoted-only on directory tables, approved-only on reviews, own-row-only on profiles. **Dead for app tables under D1 — see Layer 1.**

The Worker's former Prisma Accelerate connection used a privileged Postgres role that bypassed both GRANTs and RLS — the Worker is trusted and enforces its own authorization. Under D1 there is no GRANT/RLS to bypass; Layer 1 in the Worker is the whole story.

---

## 2. The Supabase GRANT change (May 30 / Oct 30, 2026)

Supabase is changing the default behavior of PostgREST table exposure:

- **Before:** every new table in the `public` schema was automatically granted to `anon`, `authenticated`, and `service_role`. RLS was the only thing standing between an anon key holder and full read access.
- **After (May 30, new projects; Oct 30, existing projects):** tables get no default grants. Explicit `GRANT` is required for PostgREST to expose them.

We are applying the new model preemptively — wiping default grants from existing tables and re-granting only what we want — so the database behaves the same way before and after Oct 30, and so new tables follow the same pattern by default.

This is implemented via `REVOKE` of existing grants plus `ALTER DEFAULT PRIVILEGES` for future objects (see §6).

---

## 3. Roles

Three roles exist in `profiles.role`. All are set server-side — no client can self-assign.

| Role | Who | How assigned |
|---|---|---|
| `reviewer` | Any authenticated user | Default role of the **D1** profile created by `POST /api/auth/profile/ensure` on first sign-in (the authoritative path under ADR 0016). The Postgres `handle_new_user()` trigger on `auth.users` still exists in the auth-only baseline but is **vestigial** — the app reads `profiles.role` from D1, not Postgres. See §8.1. |
| `admin` | Chris and Bill | Manual grant against the per-environment **D1** `profiles` row whose `id` equals the user's Supabase `auth.users.id` (the verified JWT `sub`). There is no self-serve path and no `auth.users`↔`profiles` FK. Since ADR 0017 one shared auth project backs every tier, so a human has **one** id everywhere and the grant is per-environment-D1 against that same id. **Procedure: see §3.3.** |
| `vendor_admin` | Stage 2 vendor contacts | Granted app-side on **vendor-claim approval** — the same app-layer seam as `admin` (no `auth.users`↔`profiles` FK, AECI-254). The claim form is anonymous, so the *identity* the grant links is resolved from `vendor_requests.submitter_email` by **seam #4** (§3.1) — either linking an existing `auth.users` row or provisioning one. See `STAGE_2_VENDOR_PORTAL_SPEC.md` §2–§3. Enforcement **shipped in AECI-520**: `requireVendor()` (`apps/api/src/lib/authz.ts`) requires `role = 'vendor_admin'` **and** a non-null `profiles.vendor_id`, and every `/api/vendor/*` query is scoped by that `vendor_id` (§4.4). Many `profiles` → one `vendor_id`. Multi-seat is **flat in data capability** — every seat edits the same things — but since **AECI-664** not flat in seat management: `profiles.seat_owner` gates invite/remove alone. A seat arrives either from an AECi claim grant (owner) or by redeeming an owner's invite (not an owner), which is the bound that stops one reviewed human seeding an unbounded chain of unreviewed ones. See `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a. |

Banned users retain their role but have `profiles.banned_at` set; the Worker (`apps/api/src/lib/authz.ts`) checks both identity and ban status against D1. (The Postgres `public.is_active_user()` helper is part of the historical RLS surface and no longer governs app-table access.)

### 3.1 The split-identity seams (service-role operations)

Under [ADR 0016](./adr/0016-d1-over-supabase-postgres.md) the application store (D1) and
Supabase Auth are **separate systems**, so every `auth.users` coupling that used to be a
privileged Postgres query is now app code crossing a system boundary. The original
rationale and the numbering are ADR 0016 §3; **this table is the live register**, and it
is the canonical list of **operations that legitimately require the service-role key** —
the register [`CODE_REVIEW_CHECKLIST.md`](./CODE_REVIEW_CHECKLIST.md) refers to. Anything
outside it must use a JWT-scoped path.

| Seam | Operation | Code | GoTrue endpoint | Degrade when creds absent |
|---|---|---|---|---|
| **#1** provisioning | Idempotent D1 `profiles` create on the first authenticated request. The **primary** creator under D1 (no `handle_new_user` trigger). | `routes/auth-profile.ts` | *none — D1 only, no service role* | n/a |
| **#2** `auth.users` account reads | Emails for the admin moderation queue, the claim queue, the vendor seat roster and `/admin/vendors`; **plus `last_sign_in_at` / `created_at` / `email_confirmed_at`** for `/admin/users` (AECI-692). | `lib/supabase-admin.ts` → `fetchAuthUserEmails` (bare map), `fetchAuthUserEmailsResult` (+availability), `fetchAuthUserRecords` (+the three timestamps) | `GET /auth/v1/admin/users/:id` | Every auth-derived field `null` **and the surface says so** — the `Result`/record forms carry `available` + `reason`, so a page renders "unavailable" rather than asserting "no email on file". The queue stays usable |
| **#3** GDPR erasure | Delete the `auth.users` row **after** the D1 erasure batch commits (§8). | `lib/supabase-admin.ts` → `deleteAuthUser` | `DELETE /auth/v1/admin/users/:id` | **Skipped** — the D1 erasure already completed, but the `auth.users` row **survives** and needs manual cleanup (§8 step 4) |
| **#4a** claimant lookup | Resolve a vendor claim's `submitter_email` → an `auth.users` id so the grant can link a `profiles` row. Also batched for the admin claim queue's `has_auth_account` reviewer signal. | `lib/supabase-admin.ts` → `findAuthUserByEmail`, `fetchAuthAccountsByEmail` | `GET /auth/v1/admin/users?filter=` | Resolution reports `unavailable` and the grant refuses rather than half-granting; the reviewer signal reports `null` (unknown) |
| **#4b** claimant provisioning | Create an `auth.users` row when the claimant has no account yet. | `lib/supabase-admin.ts` → `createAuthUser` | `POST /auth/v1/admin/users` | as #4a |

Seam **#2 has one fan-out, three projections.** All three exported forms call one private
`fanOutAuthUsers` (`lib/supabase-admin.ts`), so the rules that make it correct — bounded
concurrency at `WORKER_CONNECTION_LIMIT` (AECI-666), `discardResponseBody` on every unread
body, a 404 is **not** a seam failure, and `reason: 'error'` if **any** id failed — are
written once. GoTrue has no by-id batch endpoint, so the request count scales with the
admin page size; that is why `/admin/users` caps `perPage` well below the shared maximum.
The bare-map `fetchAuthUserEmails` keeps a **byte-identical signature** because four
structural type aliases inject it as their default.

Seams **#4a/#4b** are composed with a single D1 `profiles` read in
`lib/claimant-identity.ts` (`resolveClaimantIdentity`), which returns the
`linked | invited | conflict | unavailable | error` contract AECI-519's grant switches on —
including the role/vendor exclusivity check (§3.2, `STAGE_2_SPEC.md` §8.3(3)). Seam #1
carries no service-role call at all; it is listed so the register is complete and nobody
"adds" one to profile-ensure later. Full contract:
[`STAGE_2_VENDOR_PORTAL_SPEC.md`](./STAGE_2_VENDOR_PORTAL_SPEC.md) §2.

Seam **#4b provisions rather than invites.** It creates the account already-confirmed via
`POST /auth/v1/admin/users` (`email_confirm: true`), **not** a GoTrue invite email — the
invite lands on a URL fragment the web app's PKCE `/auth/callback` rejects, and sending it
would require editing the shared prod Supabase project (ADR 0017). Claimant onboarding is
instead the `claim-approved` Resend email (AECI-528). The lookup (#4a,
`findAuthUserByEmail`) also can't trust GoTrue's `?filter=` — it is a case-sensitive
substring match over email **and** display name, so the resolver re-checks for an **exact**
lowercased email match client-side before linking a seat (else `jane@acme.com` would match
`jane@acme.com.evil.io`).

**Where the key lives.** `SUPABASE_SERVICE_ROLE_KEY` is read by the **API Worker only** —
never the web Worker (which verifies tokens with public JWKS material, §4.1). It is
declared optional in `apps/api/src/env.ts`, so every seam above **degrades gracefully**
rather than failing closed. See [`environments.md`](./environments.md) §Secrets for which
environments actually carry it.

**Which environments carry it (AECI-530).** CI pushes the **single shared, un-suffixed**
`SUPABASE_SERVICE_ROLE_KEY` GH secret to the API Worker on **staging**
(`deploy.yml`), **demo** (`promote-to-demo.yml`), and **production**
(`promote-to-prod.yml`) — each a graceful warn-and-skip step, never in
`REQUIRED_WORKER_SECRETS`. **Local `wrangler dev` and per-PR previews carry no key**,
so the seams degrade exactly as tabled above there; for previews that is a deliberate
choice recorded inline in `pr-preview.yml`, not an oversight. (This reconciled CI with
ADR 0016 §6, which had already decided the key belongs on the API Worker; the former
`environments.md` / `CICD_PLAN.md` "never on a Worker" rows were doc lag from the
Prisma/Postgres era, when the Worker reached `auth.*` over SQL.) Because one Supabase
project backs every environment, the key rotates for all tiers at once —
[`CICD_PLAN.md`](./CICD_PLAN.md) §7.4.

**The single-module invariant.** `env.SUPABASE_SERVICE_ROLE_KEY` is read in exactly one
place — `apps/api/src/lib/supabase-admin.ts`, via its private `adminConfig()` /
`adminHeaders()` helpers. Keep it that way: the register above is only auditable if there
is one door. That module is also deliberately DB-free, so any composition with D1 lives in
a caller (e.g. `lib/claimant-identity.ts`).

**Accepted risk.** The GoTrue service-role key is the **project-wide auth key**, and under
[ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md) one project
backs *every* environment including production. Holding it lets code enumerate every user,
mint a session for any address, and delete identities — and GoTrue offers **no scoped
admin credential** (no read-only or per-endpoint admin key), so narrowing is not
available. ADR 0016 accepted this exposure as the cost of Option A (auth stays Supabase,
app data moves to D1); Option B (self-hosted auth) was explicitly deferred. The
mitigations are the ones above — one module, API Worker only, optional-and-degrading —
plus keeping the key off ephemeral per-PR preview Workers, which since AECI-530 is
**CI-enforced**: `deploy.yml` / `promote-to-{demo,prod}.yml` push it, `pr-preview.yml`
deliberately does not. Note the asymmetry: #2/#4a are reads, but **#3 destroys**
identities and **#4b creates** them. One live consequence of the shared project: a
`DELETE /api/account` on **staging or demo** now really deletes the `auth.users` row
that also backs production. That is the accepted ADR-0017 cost, and it is precisely why
previews are excluded.

### 3.2 Role exclusivity & the vendor grant

`vendor_admin` is granted **app-side on vendor-claim approval** — the same app-layer seam as
`admin` (no `auth.users`↔`profiles` FK, AECI-254). The grant is a single atomic
`db.batch([...])` (driven by `PATCH /api/admin/claims/:id`, AECI-519): `grantSeatStatements`
(`lib/vendor-grant.ts`) upserts the `profiles` seat, resolves the request, advances the
`vendor_claim` workflow and writes its `audit_log` row, and — since AECI-612 —
`activateEntitlementStatements` (`lib/vendor-entitlement.ts`) contributes the entitlement row
and the `vendors.verified` flip into the **same** batch (§4.3).

**`vendors.verified` is no longer the entitlement model; it is a mirror of one.** The AECI-515
epic (`docs/STAGE_2_PAID_TIERS_SPEC.md` §2) introduced a `vendor_entitlements` table carrying
tier, status, term and the offline PO/invoice arrangement, and demoted `verified` to a
**denormalized boolean mirror**: `vendors.verified = true` **iff** the vendor has a
`vendor_entitlements` row with `status = 'active'`. This supersedes the former claim here that
`verified` *is* the launch entitlement bit and that no entitlements table exists
(`STAGE_2_SPEC.md` §8.3(1) said so; §8.5 replaced it). Three consequences matter for
authorization:

- **One writer, not one caller.** `apps/api/src/lib/vendor-entitlement.ts` is the **sole
  writer of either side** of that *iff*, and never emits one side without the other. The claim
  grant is now a *caller* of it, not the writer — an ESLint `no-restricted-syntax` rule rejects
  a `.set({ verified })` / `.values({ verified })` on `vendors` anywhere else, and the daily
  `entitlement_mirror_drift` data-quality check is the run-time backstop.
- **The arrangement is a row now, not just audit metadata.** It is still written to the grant
  audit row's metadata as well — `audit_log` is the renewal ledger (§2.1 of the paid-tiers
  spec), keyed `entity_type='vendor_entitlement', entity_id=<vendor_id>`.
- **Authorization reads the tier, not the mirror.** The Layer-1 guard loads the caller's
  entitlement onto the session and `/api/vendor/*` writes assert a capability against it
  (§4.2/§4.4). The mirror stays what every **public read** consults; no public or read path may
  query `vendor_entitlements` at all.

**Exclusivity rules (`STAGE_2_SPEC.md` §8.3(3)).** `role` and `vendor_id` are
**single-valued** — single columns on `profiles`, with no multi-role or multi-vendor
structure. The grant therefore refuses, with an **explicit error rather than a silent
overwrite**, when:

- the resolved account is already an **`admin`** — no `vendor_admin` grant to admin accounts
  (conflict reason `already_admin`); or
- the account is already `vendor_admin` for a **different** vendor — **one vendor per account
  at launch** (conflict reason `other_vendor`).

A **second seat on the *same* vendor is the allowed case** — multi-seat is flat (many
`profiles` → one `vendor_id`), so this resolves as `linked`, not a conflict. Exclusivity is
enforced in `classifyClaimantConflict()` (`lib/claimant-identity.ts`), **not** by RLS.
Conflicts surface as **`409 GRANT_CONFLICT`** (with `details.reason`); when the GoTrue
service-role creds are absent, identity resolution reports `unavailable`/`error` and the grant
returns **`503 DEPENDENCY_FAILURE`** — it refuses to half-grant. The seat upsert is
**no-clobber**: on conflict it sets only `role` / `vendor_id` / `updated_at`, never touching
`display_name`, `theme_preference`, trust tier, or the ban columns.

**Revoke & ban are per-seat and never un-verify.** Revoke (`revokeSeatStatements`,
`lib/vendor-grant.ts`) drops the seat back to `role = 'reviewer'` and nulls `vendor_id`,
scoped to one active seat. The batch builder shipped with **AECI-519**; it now has **two**
HTTP surfaces — `DELETE /api/vendor/seats/:userId` (owner-only, the vendor's own roster,
AECI-664) and `DELETE /api/admin/vendors/:id/seats/:userId` (admin, AECI-652). Un-granting is
the separate, explicit revoke action, deliberately kept **out** of AECI-524's scope (the
2026-07-24 epic re-scope: AECI-524 is the ban/unban action only). A **ban** sets
`profiles.banned_at` / `ban_reason` on the seat
and is checked **before** the role check in the Layer-1 guard (§4.2 / §4.4). Both are
per-seat — they touch one `profiles` row and **never** touch `vendors.verified`, which is a
vendor-level paid state. **Un-verifying is a separate entitlement action** (`STAGE_2_SPEC.md`
§8.3(2)), and since **AECI-532** it is built: `PATCH /api/admin/vendors/:id/entitlement`
(`docs/STAGE_2_PAID_TIERS_SPEC.md` §5), which clears the bit **through the entitlement row**
rather than by writing the mirror. Clearing an entitlement does **not** revoke seats: the
vendor keeps portal access, read-only — reads still return 200 and writes 403
`ENTITLEMENT_REQUIRED`. There are therefore **three orthogonal "take it away" actions**, and
confusing them is a foreseeable incident: **ban a seat** (one `profiles` row, that seat 403s,
mirror untouched), **revoke a seat** (one `profiles` row, drops to `reviewer`, mirror
untouched), and **clear an entitlement** (vendor-level, badge goes away,
seats and logins survive). Banning or revoking one abusive seat leaves the vendor
verified and its other seats working. Grant and revoke each emit their `audit_log` row in the
same batch (§4.3) and are fully reversible. Full contract:
[`STAGE_2_VENDOR_PORTAL_SPEC.md`](./STAGE_2_VENDOR_PORTAL_SPEC.md) §2, §3.1, §7.

---

### 3.3 Granting `admin` (the actual procedure)

`requireAdmin()` (`apps/api/src/lib/authz.ts`) re-reads `profiles.role` from D1 on
**every** request and never trusts a JWT claim, so granting admin is exactly one
upsert into the target environment's D1 — no Supabase-side change, no deploy.

Two facts to get right before running anything:

- **The `id` is the Supabase `auth.users.id`**, not an email and not a generated
  key. Read it from the user's JWT `sub`, from their existing `profiles` row, or
  via the GoTrue Admin API.
- **`created_at` / `updated_at` are `text NOT NULL` with no SQL default** — Drizzle
  fills them via `$defaultFn` at insert time, so a raw `INSERT` that omits them
  fails `NOT NULL constraint failed: profiles.created_at`.

**Locally** — set `LOCAL_ADMIN_USER_ID` in `apps/api/.dev.vars` and run:

```bash
pnpm --filter @aeci/api db:grant-admin:local
```

`scripts/grant-local-admin.mjs` (AECI-765) is also the last step of
`db:seed:local`, so the grant is re-applied on every `pnpm dev` / `dev:agent` and
survives a fresh workspace. The end-to-end walkthrough — signing in, finding your
id, and the `/admin` 404-until-granted behaviour — is `docs/environments.md`
§"Local dev: Supabase auth (Phase 5)" step 2.

**In a deployed environment** — the same statement, against that tier's D1:

```bash
wrangler d1 execute aeci-app-<env> --env <env> --remote --command "INSERT INTO profiles (id, display_name, role, created_at, updated_at) VALUES ('<supabase-user-id>', '<name>', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO UPDATE SET role='admin', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
```

Revoking is the same statement with `role='reviewer'`. Note this is a raw D1 write
outside the app, so it emits **no `audit_log` row** — the §26.1 in-batch invariant
governs the Worker's write paths, not operator SQL. Record the grant in the issue
or runbook you are working from.

## 4. Worker authorization (Layer 1)

This is where authorization is actually enforced. The patterns here are not optional — every protected endpoint follows them.

### 4.1 JWT verification — hard fail

Every authenticated endpoint verifies the JWT and rejects anything malformed, expired, or unverifiable with `401 Unauthorized`. A missing JWT on an authenticated route is `401`, not anonymous treatment.

```ts
// Illustrative shape — the real entry points are verifySupabaseJwt() in
// apps/api/src/lib/user-auth.ts (jose + Supabase JWKS), invoked by the Hono guard
// createAuthzMiddleware in apps/api/src/lib/authz.ts (which also accepts the
// sb-<ref>-auth-token session cookie, not just a Bearer header).
import { jwtVerify, createRemoteJWKSet } from 'jose';

const jwks = createRemoteJWKSet(
  new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
);

export async function requireAuth(request: Request, env: Env): Promise<AuthContext> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'auth_required', 'Authorization header missing');
  }
  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });
    return { userId: payload.sub as string, email: payload.email as string | undefined };
  } catch (err) {
    logSecurityEvent(env, 'jwt_verify_failed', { error: String(err) });
    throw new HttpError(401, 'auth_invalid', 'Invalid or expired token');
  }
}
```

**Why hard-fail rather than soft-fail:** an unauthenticated request to an authenticated endpoint is either a bug in our own code, a misconfigured client, or someone probing. None of these benefit from being silently downgraded to anonymous.

### 4.2 Role and ban check before the write

After JWT verification, the Worker loads the profile **from D1** and checks role and ban status. Banned users are rejected; non-admins on admin routes are rejected. This check runs in the Hono guard middleware (`requireAuth()` / `requireAdmin()`, `apps/api/src/lib/authz.ts`), **before** the handler runs — so before any write.

```ts
// apps/api/src/lib/authz.ts (shape)
const { db } = getDb(c.env);
const profile = await db.query.profiles.findFirst({
  columns: { role: true, bannedAt: true, banReason: true },
  where: eq(profiles.id, user.userId),
});
if (!profile) throw unauthenticated();          // 401: verified token, no profile row
if (profile.bannedAt) {
  throw new ApiError(403, ApiErrorCode.FORBIDDEN, profile.banReason ?? 'Account suspended');
}
if (requiredRole === 'admin' && profile.role !== 'admin') {
  throw new ApiError(403, ApiErrorCode.FORBIDDEN, 'Admin role required');
}
```

The D1 binding is privileged (no RLS), so this re-fetch of `profiles.role` + `bannedAt` is the authorization source of truth — never trust client claims (§4.5).

**Ordering note:** the ban check runs **before** the role check and before any entitlement question. A banned seat is rejected outright; it is never told whether its vendor is paying.

#### 4.2a Attestation authority — the two-slot extension of `vendor_id` scoping (AECI-603)

`requireVendor()` proves *which* vendor the caller is; it scopes nothing. Every `/api/vendor/*` handler must still filter by `c.get('auth').vendorId` — that filter is what stands in for the RLS row policy this stack does not have.

Integration attestations are the one place that filter is not a single equality, because an integration has **two** vendor-writable slots. `attestations.source` reserves `vendor_a` / `vendor_b` for the integration's endpoint-A / endpoint-B vendors, where **A = `integrations.source_product_id`** and **B = `target_product_id`**, and ownership lives in `product_vendors`:

| `product_vendors` row exists for… | May attest |
|---|---|
| the integration's `source_product_id` | `vendor_a` |
| the integration's `target_product_id` | `vendor_b` |
| **both** endpoints | **both** slots |
| neither | **404**, not 403 |

**Ownership is necessary, not sufficient (AECI-705).** A second, edge-scoped check runs immediately after: a **connector-powered** integration — `powered_by_product_id` set, or `mechanism_kind = 'iPaaS'` — is not attestable by anyone, because neither endpoint vendor built the plumbing and the connector holds no seat. The full gate order on a write is therefore **authority → `404`, attestable edge → `403`, `vendors.verified` → `403`**, and that order is load-bearing: reversed, an unverified vendor on a powered edge is told to get verified in order to author, which verification will never deliver. It is a `403` rather than a `404` because the caller has *already* proven it owns an endpoint and powered-ness is public on the pair page, so the non-disclosure rule has nothing left to protect. **`DELETE` is exempt** — an edge can become powered after a vendor attests, and a vendor must always be able to withdraw. Contract: `docs/STAGE_2_ATTESTATIONS_SPEC.md` §14.

Three rules bind here:

- **Authority derives from ownership, never from the request.** Nothing in the `/api/vendor/*` contract carries a slot or a vendor id, exactly as nothing in it carries a `vendor_id` today.
- **404, not 403** — the non-disclosure rule (`apps/api/src/routes/vendor.ts` header). A vendor must not be able to probe for the existence of another vendor's integration, so "you own neither endpoint" and "no such integration" answer identically. The check runs **before** any other read or write, in its own wave: folding it into a `Promise.all` lets a validation error win the race and answer a request that should have been a flat 404.
- **One implementation.** `resolveAttestationSlots()` / `resolveAttestationSlotsForVendor()` / `resolveClaimAuthority()` in `apps/api/src/lib/attestation-authority.ts` own the rule; no handler and no detector re-derives it inline. Full contract: `docs/STAGE_2_ATTESTATIONS_SPEC.md` §2.
- **The 404 must also be uniform across grains** (AECI-301). `resolveClaimAuthority()` exists because the obvious composition — load the claim, then resolve its integration — answers `details.resource: 'claim'` for a claim that does not exist and `'integration'` for one belonging to another vendor. Distinguishable 404s are an existence oracle a vendor can walk. One join collapses both into the same empty result, so the property is structural rather than a branch that must be written identically twice.

Two schema facts the rule has to survive: `product_vendors` is many-to-many, so one vendor can own both endpoints (it may write both slots, but §4 of that spec still renders the result one-sided, since `confirmed` needs two **distinct** `attested_by_vendor_id` values); and `profiles.vendor_id` is many-to-one, so two accounts can target the same slot — the `attestations_slot_key` partial unique index makes that explicitly last-write-wins rather than silently accumulating duplicate votes.

#### 4.2b The entitlement tier on the session (AECI-611)

`AuthenticatedSession` carries the caller's entitlement, loaded by the guard, so a handler's capability check is a **DB-free in-memory assertion** rather than a second round-trip:

- **`entitlementTier: EntitlementTier`** — always present, never optional (an optional field invites `session.entitlementTier ?? 'verified'`), `'unclaimed'` for non-vendor sessions and for any vendor without an `active` entitlement. Named `entitlementTier` and **not `tier`**, because `profiles.trust_tier` is a neighbouring **reviewer** concept whose CHECK vocabulary literally contains `'verified'` (`DATABASE_SCHEMA.md` §7.1). They are unrelated and must never be confused.
- **`entitlement: { status, periodEnd } | null`** — term detail for the dashboard readout only; **deliberately not an authorization input.**

**Loaded on the `vendor_admin` branch only.** That branch's existing per-request profile re-fetch gains a `leftJoin` onto `vendor_entitlements` — one extra table on a single-row lookup over a unique index, in the **same** round-trip. `requireAuth()` and `requireAdmin()` keep the exact query they ran before, so `/api/admin/*`, `POST /api/reviews` and `DELETE /api/account` are byte-identical to pre-AECI-611: an admin session has `vendor_id = null`, so an unconditional join would be a `LEFT JOIN … ON NULL` on every admin request. A separate `requireCapability()` *middleware* was rejected for three reasons: it would need `vendorId` first and therefore **serialize** a second read; being opt-in, an omission would be a silent authorization hole rather than a visible one; and the gate is **field**-granular, which route-level middleware cannot express.

**Fail-closed.** No row, a non-`active` status, or a tier this build does not know all resolve to `'unclaimed'` → zero capabilities → 403. Never default to `'verified'`. `vendor_entitlements.tier` is deliberately unconstrained at the DB layer, so the unknown-tier case is real and not theoretical.

**Where it is enforced.** `requireCapability(c, cap)` throws **403 `ENTITLEMENT_REQUIRED`** with `details: { capability, tier, fields? }` — 403 and not 402, because 402 Payment Required would leak a billing model into a wire contract that must stay payer-model-agnostic, and `API_CONTRACTS.md` §4.1 has no 402 row. Two axes enforce it and they must agree: the **route-level** call in each write handler, and the **field-level** allow-list (`splitPatch`, which maps every vendor-editable column to a capability and **throws with `details.fields` rather than silently dropping** — a dirty-diff form re-seeds its baseline from the echo and would settle *clean* on a value that never landed). At launch `verified` holds every capability, so behaviour is unchanged; adding a rung later is a data edit in two tables.

**Where the call site sits is not uniform, and that is deliberate.** On `PATCH /api/vendor/profile` the gate runs immediately after `sessionVendorId(c)`. On `PATCH /api/vendor/products/:id` it runs **after `requireOwnedProduct`**, because a 403 raised before ownership settles would confirm to a non-owner that the product exists — and **404-never-403 is the harder invariant** of this surface (§4.2a). The rule is "after ownership settles, wherever there is an ownership question", not "immediately after `sessionVendorId`".

**Reads are never gated** — `GET /api/vendor/me` and `GET /api/vendor/seats` must not call `requireCapability`, and that is an acceptance criterion with its own test rather than a convention. `/vendor` is gated by `vendorMeResolver`, which maps 401/403/404 onto a **404 render**, so gating `me` would 404 the entire dashboard for a vendor whose entitlement lapsed — hiding the renewal notice from exactly the cohort being billed.

Full contract: `docs/STAGE_2_PAID_TIERS_SPEC.md` §3.3, §4.

### 4.3 Audit log inside the same batch

Every state-changing write goes into the **same** atomic `db.batch([...])` as its audit log entry. D1 has no interactive transactions, so the mutation and the `auditInsert(...)` statement commit or roll back as one unit (`apps/api/src/lib/audit.ts`; see `DATABASE_SCHEMA.md` §18).

```ts
const { db } = getDb(env);
await db.batch([
  db.update(products).set(input).where(eq(products.id, id)),
  auditInsert(db, {
    actorId: ctx.userId,
    actorType: ctx.role === 'admin' ? 'admin' : 'user',
    action: 'product.updated',
    entityType: 'product',
    entityId: id,
    beforeState: prevState,
    afterState: input,
    metadata: { cfCountry: request.cf?.country },
  }),
]);
```

### 4.4 Endpoint-by-endpoint expectations

| Endpoint | Auth | Role check | Audit |
|---|---|---|---|
| `GET /api/products`, `/vendors`, `/integrations`, `/taxonomy/*`, `/stats/home` | None | None | None |
| `GET /api/products/:slug/reviews` | None | None | None |
| `GET /api/products/:slug/integrations/:otherSlug` (AECI-294) | None | None | None — the product-PAIR read. Its `?context_version=` / `?other_version=` selectors (AECI-303 / §9) are **not** an authz surface: a bad label degrades to latest rather than erroring, and the reader's diff depth is decided by the `canViewVersionDiff` seam, which clamps the response rather than rejecting it. |
| `GET /api/products/:slug/integrations/:otherSlug/timeline` (AECI-303) | None | None | None — the pair's per-claim attestation **history**. Public like the pair read itself: a reader who can see a pair can see how its claims got there. The only content control is the same seam, which answers `{ claims: [], diff_access: 'latest_only' }` when gated — never a 403, because the free latest view must survive a shared historical link (`STAGE_2_SPEC.md` §8.1(4)). |
| `POST /api/reviews` | Hard-required | `reviewer`, not banned | `review.submitted` |
| `DELETE /api/account` | Hard-required | Active user | `account.deleted` |
| `POST /api/requests/claim`, `/correction` | None (anon form) | None | `claim/correction.submitted` |
| `POST /api/track/pageview` | Optional | None | Logged to `page_views` |
| `GET /api/admin/*` | Hard-required | `admin` | No (reads only) |
| `PATCH /api/admin/reviews/:id` | Hard-required | `admin` | `review.approved` / `.rejected` |
| `PATCH /api/admin/claims/:id` (AECI-519 / AECI-612) | Hard-required | `admin` | **Two** rows on a first grant: `vendor_claim.granted` (the seat) **and** `vendor_entitlement.granted` (the entitlement + the `vendors.verified` mirror flip), both in the one batch and sharing `metadata.source: 'admin-moderation'`; `.rejected` on the reject path. A **second seat** on an already-active entitlement writes only the claim row — the entitlement builder emits nothing, so the mirror does not churn. (The seat-revoke mechanic `vendor_claim.seat_revoked` got its endpoint in **AECI-664** — `DELETE /api/vendor/seats/:userId`, owner-only, vendor-side; AECI-524 had wired the ban gate only. Ban and revoke stay two different actions.) A grant now also sets `profiles.seat_owner = true`: an AECi-reviewed claim IS the owner event (§11a). |
| `PATCH /api/admin/vendors/:id/entitlement` (AECI-532) | Hard-required | `admin` | `vendor_entitlement.set` / `.renewed` / `.cleared` (`entity_type: 'vendor_entitlement'`, `entity_id` = the **vendor** id, `metadata.source: 'admin-entitlement'`) — set/renew/clear the offline arrangement. **The only writer that takes `vendors.verified` back down**, and it does so through the entitlement row, never by writing the mirror. `verified` is never in the request body; it appears on the response as a read-only readout. **No `workflow_instances` row** (that CHECK is closed; `audit_log` is the ledger). Clearing does **not** revoke seats. |
| `GET /api/admin/vendors`, `/:id`, `/:id/audit` (AECI-652) | Hard-required | `admin` | No (reads only). The audit read is the FIRST reader `audit_log` has ever had — reading the ledger is not a domain-state write, so it emits nothing of its own. Its `entity` scope is three OR'd disjuncts because `entity_id = <vendor>` misses a rejected claim (no `vendor_id` in its metadata) and a revoked seat (whose `profiles.vendor_id` is already null); `STAGE_2_PAID_TIERS_SPEC.md` §5.6.2 has the query. `/:id` reports `seat_emails_available` so an unreachable GoTrue seam renders as "unavailable" rather than as an empty roster |
| `DELETE /api/admin/vendors/:id/seats/:userId` (AECI-652) | Hard-required | `admin`; the target must be a `vendor_admin` seat **on that vendor** — a cross-vendor id is a flat **404** | `vendor_claim.seat_revoked` with `metadata.source: 'admin-moderation'` (vs `vendor-portal` for the owner-side revoke). The admin-side sibling of `DELETE /api/vendor/seats/:userId`; composes the same `revokeSeatStatements`, so **no statement names `vendors`** and the mirror is untouched. No self-removal guard (an admin holds no seat) and **no last-owner guard** — that guard exists because only an AECi grant can rescue an unadministrable account, and this IS that grant's operator. Banning stays `PATCH /api/admin/reviewers/:id` |
| `PATCH /api/admin/reviewers/:id` (AECI-218 / AECI-524) | Hard-required | `admin` | `reviewer.banned` / `vendor_admin.banned` / `.unbanned` — bans/unbans any non-admin `profiles` row (reviewer **or** `vendor_admin` seat); role-agnostic UPDATE, role-aware audit, per-seat, never touches `vendors.verified`. **The sole writer of `profiles.banned_at` anywhere** — AECI-692 gave it a second caller (`/admin/users/:id`) and no second writer; `routes/banned-at-writers.spec.ts` asserts that at the source level |
| `GET /api/admin/users` + `/:id` (AECI-692) | Hard-required | `admin` | — reads only, no `audit_log` row (ADR 0022). Profiles-first because one auth project backs every env (ADR 0017). Every GoTrue-derived field is tri-state: `auth_available: false` = seam down, an absent account = orphaned profile, a `null` field = genuinely empty. `ADMIN_PANEL_SPEC.md` §5.8 |
| `PATCH /api/admin/connector-catalogs/:id` (AECI-720) | Hard-required | `admin`; **never vendor-self-serve** — a `vendor_admin` gets a flat 403, asserted at `admin-connector-catalogs.spec.ts` | `connector_catalog.managed_by_vendor` / `.managed_by_review` (`entity_type: 'connector_catalog'`, `metadata.source: 'admin-connector-catalog'`), in the same `db.batch` as a guarded `UPDATE … AND managed_by = :from`. A **governance** write: it decides which system may author a catalogue and writes no catalogue content. `vendorId` records who it was handed to and **grants nothing** — the row says `seat_not_granted: true` out loud, because §8.9(2) fences the connector seat off from `vendor_entitlements` entirely. **No `workflow_instances` row** (that CHECK is closed) and **no cache purge** (nothing cacheable reads these tables) |
| `GET /api/admin/connector-catalogs` + `/:id`, `/:id/stubs`, `/:id/pairs`, `/:id/audit` (AECI-722) | Hard-required | `admin` | — reads only, no `audit_log` row (ADR 0022). The first readers of the connector lane. `handover` is derived from `audit_log` rather than from a column, and is `null` once a lane is reclaimed. Mapping decisions are **not** writable here: the sync would overwrite them, so authoring waits for AECI-724 and is gated on `managed_by = 'vendor'`. `ADMIN_PANEL_SPEC.md` §5.9 |
| `GET /api/vendor/me`, `/seats` | Hard-required | `vendor_admin` + non-null `vendor_id`, not banned. **Never capability-gated** (§4.2b) | No (reads only). `/seats` also ships `pending_invites` + the caller's `can_manage_seats`; the invite **token is never on this payload** — every seat can read it, and a token there would let any seat redeem another person's invite |
| `POST /api/vendor/seats/invites` (AECI-664) | Hard-required | same **+ `profiles.seat_owner`**, re-read from D1 this request. **Not** capability-gated — seats are not a paid feature, and gating removal on a live entitlement would stop a lapsed vendor revoking a departed employee (§11a). **Not domain-gated either** (§11a.3): the owner may invite any address, and what bounds the endpoint is owner-only + a non-owner invited seat + the redeem's mailbox binding + the 10/24h cap | `vendor_seat.invited` (`metadata.source: 'vendor-portal'`). **The token never reaches the audit row** — audit is admin-readable and forwarded to PostHog Logs (§26.5) |
| `DELETE /api/vendor/seats/invites/:id` (AECI-664) | Hard-required | same **+ `seat_owner`**; a spent or cross-vendor id is a flat **404** | `vendor_seat.invite_revoked` — SOFT delete (`revoked_at`), never a row delete |
| `DELETE /api/vendor/seats/:userId` (AECI-664) | Hard-required | same **+ `seat_owner`**; refuses self-removal (422); a seat on another vendor is a **404** | `vendor_claim.seat_revoked` with `metadata.source: 'vendor-portal'` (vs `admin-moderation` for an AECi un-grant — `actor_type` is `'user'` for both, so the tag is what separates them). Clears `seat_owner`; **never touches `vendors.verified`** |
| `GET /api/seat-invites/:token` (AECI-664) | Hard-required | **`requireAuth()` only** — the caller is by definition not a `vendor_admin` yet, which is why this is not under `/api/vendor/*` | No (reads only). A READ on purpose: mail scanners and URL rewriters fetch what they are sent, and a GET that redeemed would be spent before the human clicked |
| `POST /api/seat-invites/:token/accept` (AECI-664) | Hard-required | `requireAuth()` **+ the session's verified email must equal the invited address** — the actual security control; an absent session email fails closed. Plus the §2 exclusivity rules (no site admin, no second vendor) | `vendor_seat.invite_accepted`. Writes `seat_owner: false` (the bound on the invite chain), and `work_email_verified` only when the redeemed address is on the vendor's own domain — `computeDomainMatch` runs HERE, not at invite time, because the invite-time domain gate was removed (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.3). Neither bit is ever cleared by a redeem |
| `GET /api/vendor/notifications` (AECI-302) | Hard-required | same — **no** `vendors.verified` gate (reading is not the gated capability) | No (reads only). Reads the §7.3 `audit_log` `notification.sent` ledger filtered on `json_extract(metadata,'$.vendorId') = <session vendor>`; AECi-ops rows store a null vendor and so can never match a caller |
| `PATCH /api/vendor/profile` | Hard-required | same **+ `profile.edit`** (§4.2b; field-level too, via `splitPatch`) | `vendor.updated` (`metadata.source: 'vendor-portal'`) |
| `PATCH /api/vendor/products/:id` | Hard-required | same **+ ownership + `product.edit`**, and **+ `product.taxonomy.edit`** when the body carries any facet array. Both gates run **after** ownership settles, so a non-owner still gets the flat 404 | `product.updated` (`metadata.source: 'vendor-portal'`) |
| `GET /api/vendor/products/:id/versions` (AECI-607) | Hard-required | same **+ ownership** | No (reads only) |
| `POST /api/vendor/products/:id/versions` (AECI-607) | Hard-required | same **+ ownership + `vendors.verified`** | `product_version.created` (`metadata.source: 'vendor-portal'`) |
| `PATCH /api/vendor/products/:id/versions/:versionId` (AECI-607) | Hard-required | same **+ ownership + `vendors.verified`** (+ the version must belong to `:id`) | `product_version.updated` |
| `DELETE /api/vendor/products/:id/versions/:versionId` (AECI-607) | Hard-required | same **+ ownership + `vendors.verified`** (+ the version must belong to `:id`) | `product_version.deleted` |
| `GET /api/vendor/integrations` (AECI-301) | Hard-required | same **+ §4.2a endpoint authority** (the surface is filtered to it; never a 404) | No (reads only) |
| `GET /api/vendor/data-objects` (AECI-606) | Hard-required | same, and **nothing else** — no ownership/authority check and no `vendors.verified` gate. The response is identical for every caller: a closed, AECi-curated vocabulary holds no vendor-owned rows. See the obligation-1 carve-out below | No (reads only) |
| `GET /api/vendor/updates` (AECI-627) | Hard-required | same — **no** `vendors.verified` gate and no `requireCapability` (polling is not an authoring capability). Scoping is the unusual part: the response carries **no rows**, only six `updated_at` high-water marks, so what the `WHERE` clauses protect is the *timestamp*. Each cursor therefore reuses the **exact scoping predicate of the endpoint it is a cursor for** — `ownedProductIds` / `vendorRequestsWhere` (`routes/vendor-shared.ts`), `ownedEndpointJoin` (`lib/attestation-authority.ts`), `vendorNotificationLedgerWhere` (`routes/vendor-notifications.ts`) — imported, never restated. A cursor scoped more widely than its payload leaks the existence of another vendor's write; one scoped more narrowly goes silently stale. Ops-routed ledger rows (`metadata.vendorId = null`) can never match, as on the list | No (reads only) — and deliberately so: at one poll per 20 s per open tab, auditing it would grow the `audit_log` table `GET /api/vendor/notifications` scans |
| `POST /api/vendor/claims` (AECI-301) | Hard-required | same **+ §4.2a endpoint authority + attestable edge (AECI-705) + `vendors.verified`**, in that order | `claim.created` **and** `attestation.created` (one per owned slot), `metadata.source: 'vendor-portal'` |
| `PUT /api/vendor/claims/:claimId/attestation` (AECI-301) | Hard-required | same **+ §4.2a endpoint authority + attestable edge (AECI-705) + `vendors.verified`**, in that order | `attestation.retracted` (per superseded row) + `attestation.created` (per owned slot) |
| `DELETE /api/vendor/claims/:claimId/attestation` (AECI-301) | Hard-required | same **+ §4.2a endpoint authority + `vendors.verified`** — **no edge gate**, so a position on an edge that later became connector-powered can still be withdrawn | `attestation.retracted` (per retracted row) |
| `POST /api/webhooks/linear` | HMAC-verified | N/A | `workflow.transitioned` |

**Admin panel reads (AECI-574 / Phase 8.3, extended by AECI-577, AECI-579,
AECI-580, and AECI-586).** Eight endpoints join the `GET /api/admin/*` row above —
`/api/admin/overview`, `/api/admin/metrics/timeseries`,
`/api/admin/traffic/breakdown`, `/api/admin/page-views` (the §5.2 Activity feed),
`/api/admin/catalog/coverage` (the §5.5 catalog readout), `/api/admin/system`
(the §5.6 System bundle), `/api/admin/audience` (the §5.4 subscriber, churn, UTM
and geography bundle), and `/api/admin/feedback` (the feedback inbox) — registered
on the same `authAdmin` sub-router behind
the same `requireAdmin()`. **No new gate and no new role**: `requireAdmin()` stays
the single enforcement point (`ADMIN_PANEL_SPEC.md` §9.1). They are reads and
therefore write no `audit_log` row, **including under `?recompute=1`**, which
re-runs two jobs that are already pure reads (§13 D8) — it writes nothing, sends no
email, and calls no external write API. `admin-panel.authz-matrix.spec.ts` asserts
the matrix end-to-end against the real guard for **every** panel route: anon → 401,
authenticated non-admin → 403, banned admin → 403 (the ban precedes the role
grant), admin → 200. Each new read endpoint the epic adds belongs in that spec's
`ROUTES` table.

`/api/admin/system` is worth one extra line because it reads more widely than the
others: it enumerates the live table list from `sqlite_master` and counts every
row. It returns **counts and table names only** — never a row's contents — so it
exposes no user data, and it remains a read: the `sqlite_master` walk and the
`COUNT(*)` union write nothing.

The three analytics endpoints read `page_views`, which by design holds **no user linkage** — a
UA *hash* and a referrer *host*, never a full URL or query. `ADMIN_PANEL_SPEC.md`
§13 **D7** settled that no session identifier is introduced, and AECI-585 dropped
the dead `page_views.user_id` column rather than filling it, so the panel cannot
de-anonymize a visitor even for an admin. That is now structural rather than a
matter of which columns the handler selects: the column does not exist. Its
"visitor" is a distinct `(user_agent_hash, cf_asn)` pair, and the response says so.

`/api/admin/page-views` is the one endpoint that returns visit rows rather than
aggregates, so it tightens that further: it selects **eight characters** of
`user_agent_hash`, truncated in SQL (`substr(user_agent_hash, 1, 8)`), so the full
hash never leaves the API even on an admin-authenticated response. It cannot
select `user_id`, `session_id`, or `profile_role` — AECI-585 dropped all three.
Both properties are asserted in `admin-page-views.spec.ts` rather than left to
review.

`/api/admin/feedback` (AECI-586) goes the **other** way on identity, and the
contrast is deliberate rather than an inconsistency. It returns the submitter's
`email` in full. A `page_views` row observes someone who never identified
themself, which is why §9.7 requires a truncated pseudonymous hash there; a
feedback submission is contact information a person volunteered *in order to be
replied to*, and redacting it would defeat the field's only purpose.
`GET /api/admin/requests` already returns `submitter_email` whole on the same
reasoning. Both stay admin-only and both stay `private, no-store` — a cached
response on this route would put a volunteered address in a shared cache, which is
one more reason `/admin/*` must remain absent from `ROUTE_CACHE_PATTERNS`.
`/api/admin/audience` returns **aggregates only**: counts, rates and grouped
breakdowns, never a subscriber's address or a row that identifies one.

**The `/api/vendor/*` rows carry two extra obligations** (AECI-520,
`STAGE_2_VENDOR_PORTAL_SPEC.md` §4). They are the D1/Drizzle replacement for the
row filter RLS would have provided, and they are not optional:

1. **`vendor_id` scoping.** Passing `requireVendor()` only proves *which* vendor
   is calling. Every read and write must additionally filter on
   `c.get('auth').vendorId`. No `/api/vendor/*` contract carries a vendor id, so
   the Worker never has a client-supplied one to be tempted by.

   **One documented exception, and only one:** `GET /api/vendor/data-objects`
   (AECI-606) serves the frozen, closed `taxonomy_data_objects` curation
   vocabulary, which has no `vendor_id` column and no vendor-owned rows — the
   filter would be **vacuous, not omitted**, and every caller gets a
   byte-identical body by construction. `vendor.authz-matrix.spec.ts` asserts
   that sameness across two seats, so a later "restore the missing scope filter"
   edit fails loudly rather than reading as a fix. Any new route that reads a
   vendor-partitioned table still needs its filter; this exception does not
   generalise, and the reason it is safe is the *table*, not the route.
2. **Ownership before writing a client-supplied id.** `PATCH
   /api/vendor/products/:id` and every `/products/:id/versions` route prove the
   product belongs to the session's vendor (a `product_vendors` read) *before*
   anything is written, and a miss returns **`404`, not `403`** — a non-owner
   must not learn the product exists. One implementation, `requireOwnedProduct()`
   in `apps/api/src/routes/vendor-shared.ts`; it is the **product-grain**
   counterpart to the integration-grain `resolveAttestationSlots()`
   (`lib/attestation-authority.ts`), which enforces the same 404 posture for the
   two-slot attestation rule. Same "don't reveal the surface" posture as the
   `/admin` gate.

   **`/api/vendor/claims*` (AECI-301) carries one adaptation of that rule.** The
   version routes take their product id from the **path**, so they can prove
   ownership before the body is even parsed. `POST /api/vendor/claims` takes its
   `integration_id` from the **body**, so a shape-only Zod parse necessarily runs
   first. That is safe — it touches no database, so a 400 from it is
   existence-independent — but nothing else may join it: vocabulary resolution,
   the duplicate-identity check and version-stamp validation all run *after* the
   authority wave, or a `400` naming a bad `data_object` would answer a request
   that should have been a flat `404`.

**A third obligation applies to the version WRITES only** (AECI-607,
`STAGE_2_ATTESTATIONS_SPEC.md` §1/§8.3): authoring is a **Verified-vendor
capability**, so `POST` / `PATCH` / `DELETE` additionally require
`vendors.verified` and answer **`403`** without it. Two details that are easy to
get backwards:

- **Ownership (404) is evaluated before verification (403).** Reversed, the
  ordering would start leaking on the day a *verified* non-owner probes a
  product. `requireOwnedProduct()` loads the ownership row, the product and the
  caller's `vendors` row in one wave and then checks them in that fixed order.
- **`GET` is not gated.** Reading your own product's versions is not the
  capability; authoring is. Gating the read would 403 a vendor out of its own
  data instead of letting the dashboard render a read-only tab that explains what
  verification unlocks. The 403 copy points at the claim/verification flow and
  **never at ranking, placement, or search** — no pay-for-placement.
- The check lives in `assertVerifiedVendor()` (`routes/vendor-shared.ts`), a
  deliberate **one-function stand-in** for the capability registry. It **reads**
  `vendors.verified` and never writes it. **The registry has since landed**
  (AECI-610/611): `@aeci/shared/entitlements` declares `attestation.author` and
  `requireCapability()` is the general gate — but these routes are still gated on
  the **mirror**, not the capability, and are now the last place in the portal not
  driven by `capabilities`. That is a behavioural no-op today (the ladder is
  binary, so `verified = 1` and `hasCapability(tier, 'attestation.author')` agree
  on every row the mirror invariant permits) and a real divergence the moment a
  rung is added between them. The one-function stand-in is what keeps the swap
  mechanical. Tracked as **AECI-623**.

Two rejection cells are deliberate and easy to get wrong:

- A site **`admin` is rejected with 403** on `/api/vendor/*`. There is no
  impersonation at launch; admins act on vendor data through `/api/admin/*` so
  the audit trail names the real actor.
- A **`vendor_admin` with a null `vendor_id`** is rejected — a half-granted seat
  has nothing to scope by, so it is authorized for nothing.

The ban check runs **before** the role check, which is the moderation gate: a
banned seat fails every `/api/vendor/*` call while the vendor stays verified and
its other seats keep working. Ban and revoke are per-seat and never touch
`vendors.verified`.

Vendor writes use `actor_type: 'user'` (a `vendor_admin` is not an `admin`, and
the `audit_log_actor_type_check` CHECK has no `vendor` value). That started as a
consequence of AECI-513 shipping no migration, but it **outlived that reason and
is now the rule**: AECI-514 shipped three migrations and still did not add a
`vendor` actor type, because the distinction that matters is
`metadata.source`, not a fourth enum value. Widening the CHECK would split every
existing actor-type query for no gain. `metadata.source = 'vendor-portal'` is what distinguishes a
vendor's self-service edit from the AECi-side `vendor.updated` / `product.updated`
that `POST /api/promote` emits.

### 4.5 Things the Worker never does

- Pass user-supplied SQL into raw Drizzle/D1 queries (use parameterized queries / the query builder)
- Trust client-side claims about role (the Worker re-fetches the D1 profile every request)
- Skip the audit log for "small" updates
- Reach the DB by any path other than the request-scoped Drizzle client over the `DB` binding (`getDb(env)`)
- Return 200 on auth failures (always 401 or 403 with a stable error code)
- **Cache `profiles.role` / `banned_at` anywhere on the server** — not in KV, not in a Worker global, not in a signed cookie claim (AECI-617)

**Why the role re-fetch is not cacheable.** The per-request `profiles` read in `requireAuth()`/`requireAdmin()` looks like an obvious KV candidate — it is the same row on every call for a given user. It is not. The privileged D1 binding has **no RLS**, so this Worker is the only place authorization is actually decided (§4 preamble): a cached role means a **demoted admin keeps admin authority**, and a cached `banned_at` means a **banned user keeps writing**, both for the length of the TTL. KV is eventually consistent (propagation up to ~60s), so the staleness window can't even be bounded tightly. The read is a single indexed primary-key lookup on the Worker's own D1 binding — it is not the latency that matters.

Where role *is* cached is the browser, for UI only: `AdminStatus` (`apps/web/src/app/admin/admin-status.ts`) keeps the last probed role in `sessionStorage` so the header's admin affordances paint without a round trip. That is a hint, not a grant — every destination behind it re-enters this layer (the `/admin` SSR redirect + resolver, `requireAdmin()` on `/api/admin/*`), so a forged or stale client-side role buys nothing.

---

## 5. PostgREST GRANTs (Layer 2)

> **Historical — Supabase-Postgres-only; dead for app tables.** PostgREST GRANTs only ever applied to the Postgres **public app tables**, which now live in **Cloudflare D1** (ADR 0016). D1 has no PostgREST and no GRANTs. The GRANT migration was archived under `supabase/archive/migrations/` and the scripts that applied/verified it (`scripts/apply-authorization.sql`, `scripts/verify-rls.sql`) were deleted (AECI-278). This section is retained as a record of the former authorization design and as reference for the retained Supabase **Auth** project's own schema.

### 5.1 Why this layer exists

Even with RLS, the previous model relied on Supabase auto-granting `SELECT` to `anon`/`authenticated` on every new table. That meant a misconfigured policy or a missed `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` would silently expose data. The GRANT layer makes the default "no access" instead of "full access filtered by RLS."

### 5.2 GRANT vs RLS in one sentence

- **GRANT** answers *"is this role allowed to touch this table at all?"* If no, PostgREST returns `42501` before any policy runs.
- **RLS** answers *"which rows can this role see and modify?"* Only consulted when GRANT permits the operation.

### 5.3 Strategy

| Strategy | Tables |
|---|---|
| Grant SELECT to anon + authenticated, filter rows via RLS | `vendors`, `products`, `integrations`, all `taxonomy_*`, all `product_*` join tables, `reviews`, `stats_cache`, `translations` |
| Grant SELECT to authenticated only, filter via RLS (anon blocked at GRANT) | `profiles` |
| Grant nothing; RLS exists as belt-and-braces | `vendor_requests`, `workflow_instances`, `workflow_transitions`, `audit_log`, `page_views` |

No INSERT/UPDATE/DELETE grants anywhere. All writes are Worker-only.

### 5.4 Existing grants are revoked first

The migration runs `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;` before any new grants are issued. This wipes the legacy Supabase defaults so the explicit grants below are the *only* grants in effect.

### 5.5 Default privileges for future tables

`ALTER DEFAULT PRIVILEGES` was set so any newly created Postgres table started with no grants to `anon` or `authenticated`. To expose a new table via PostgREST, a migration had to explicitly issue the grant. This matched the post-Oct-30 Supabase default behavior. (Moot for app tables now — they are in D1.)

---

## 6. RLS policies (Layer 3)

> **Historical — Supabase-Postgres-only; dead for app tables.** RLS row-filtering only ever applied to the Postgres **public app tables**, now migrated to **Cloudflare D1** (SQLite), which has no row-level security. Row visibility (promoted-only directory rows, approved-only reviews, own-row-only profiles) is now enforced **in the Worker handlers** (Layer 1), each read carrying its own filter, with the app-layer no-leakage test matrix as the acceptance gate (see the status banner + §9). The RLS migration was archived under `supabase/archive/migrations/` (AECI-278). This section is retained for design history.

### 6.1 Helper functions

```sql
create or replace function public.is_admin()
  returns boolean
  language sql security definer stable
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_active_user()
  returns boolean
  language sql security definer stable
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and banned_at is null
  );
$$;
```

Both are `security definer` with a pinned `search_path` (the AECI-44 hardening rule) to prevent search-path attacks; every reference inside is schema-qualified (`public.profiles`, `auth.uid()`), so `auth` is not needed on the path. EXECUTE is granted to `anon` and `authenticated` only — not `public`.

**Why `public`, not `auth` (AECI-87).** These helpers used to live in the `auth` schema. Migrations apply as the `postgres` role, which has no CREATE on `auth` (owned by `supabase_admin`), so `create function auth.is_admin()` fails `42501 permission denied for schema auth` under `supabase db push` — which is why the policies were once applied out of band as `supabase_admin` and never reached staging/prod. Moving the helpers to `public` lets the standard migration path install the whole surface everywhere; RLS policies reference them as `public.is_admin()` / `public.is_active_user()`.

### 6.2 Permission matrix

The Worker bypasses everything here. These rules govern only what `anon` and `authenticated` roles can do via `/rest/v1/*`. Each row shows GRANT and RLS together since both must allow the action.

**Legend:** ✅ allowed · ❌ blocked · (promoted) only `promotion_status = 'promoted'` · (approved) only `status = 'approved'` · (own) only the JWT subject's row · `no GRANT` = blocked at Layer 2, RLS never consulted

#### Core entities, taxonomy, joins

| Table | Anon SELECT | Auth SELECT | Admin SELECT | Writes |
|---|---|---|---|---|
| `vendors` | ✅ (promoted) | ✅ (promoted) | ✅ (promoted) | ❌ no GRANT |
| `products` | ✅ (promoted) | ✅ (promoted) | ✅ (promoted) | ❌ no GRANT |
| `integrations` | ✅ (both promoted) | ✅ (both promoted) | ✅ (both promoted) | ❌ no GRANT |
| `taxonomy_*` | ✅ | ✅ | ✅ | ❌ no GRANT |
| `product_*` joins | ✅ (product promoted) | ✅ (product promoted) | ✅ (product promoted) | ❌ no GRANT |
| `translations` | ✅ | ✅ | ✅ | ❌ no GRANT |

#### User and content

| Table | Anon SELECT | Auth SELECT | Admin SELECT | Writes |
|---|---|---|---|---|
| `profiles` | ❌ no GRANT | ✅ (own) | ✅ (all) | ❌ no GRANT |
| `reviews` | ✅ (approved) | ✅ (approved + own) | ✅ (all) | ❌ no GRANT |

#### Operations, workflow, analytics

| Table | Anon SELECT | Auth SELECT | Admin SELECT | Writes |
|---|---|---|---|---|
| `vendor_requests` | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT |
| `workflow_instances` | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT |
| `workflow_transitions` | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT |
| `audit_log` | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT |
| `page_views` | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT | ❌ no GRANT |
| `stats_cache` | ✅ | ✅ | ✅ | ❌ no GRANT |

The operations tables show "no GRANT" for admins too — even an admin's JWT can't read them via PostgREST. Admins use the API Worker (`/api/admin/*`) for these, which bypasses the GRANT layer entirely. RLS policies granting admin read remain as belt-and-braces in case grants are ever added.

### 6.3 Notable policy decisions

**Promoted-only filter on directory tables.** PostgREST should never leak draft, retracted, or rejected records. The promotion filter is in the `using` clause of every directory table's SELECT policy.

**Join tables filter on promotion too.** A naive policy that allowed `product_categories` to be read freely would let a caller enumerate which categories a non-promoted product belongs to. Every join table requires its product (and host product, where applicable) to be promoted.

**No write policies anywhere.** When RLS is enabled and no INSERT/UPDATE/DELETE policy exists, writes from `anon` and `authenticated` are denied. Combined with no INSERT/UPDATE/DELETE grants, this is double-locked.

**`integrations` requires both endpoints promoted.** A row with one promoted and one draft product would leak the existence of the draft product through the `target_product_id` column.

### 6.4 What is intentionally NOT in RLS

- Owner-update policies on reviews — Stage 1 reviews are immutable after submission
- Owner-update policies on profiles — profile changes go through the Worker to be audited
- Vendor scoping (`vendor_admin`) — reserved for Stage 2
- Insert policies on reviews — no Supabase JS client exists in Stage 1

---

## 7. Banned user behavior

Enforced at the **Worker layer** (Layer 1) — the only authorization layer for app tables under D1. (The Layer-3 RLS path described below is historical, dead for app tables.)

**Worker (primary):** the `requireAuth()` / `requireAdmin()` guards (`apps/api/src/lib/authz.ts`) check `bannedAt` against D1 before any protected action. Banned users get `403` (with `banReason` if set; review writes pass `ApiErrorCode.REVIEW_BANNED`). Banned users cannot submit reviews, claim vendors, file corrections, or modify their account. They can still read public data — the public read endpoints don't run the auth guard.

**RLS (historical defense in depth, dead for app tables):** the former `public.is_active_user()` helper returned false for banned users, and the `reviews: owner read own` policy used it so a banned user couldn't read their own pending reviews via PostgREST. That policy lived on Postgres; under D1 the equivalent visibility is enforced in the Worker's review-read handler. Approved reviews stay readable — banning does not retroactively hide past content.

Bans are applied by an admin through `PATCH /api/admin/reviewers/:id` — since **AECI-692** from **`/admin/users/:id`**, which is now the ban/reinstate home (`/admin/users?banned=true` is the banned list, and `/admin/reviewers` redirects there; the endpoint itself is unchanged and remains this column's only writer anywhere) — which since AECI-524 covers `vendor_admin` seats as well as reviewers: the `UPDATE` is role-agnostic (only admins and self are exempt) and the audit action is role-aware (`reviewer.banned` / `vendor_admin.banned` / `.unbanned`). A banned `vendor_admin` seat then fails every `/api/vendor/*` call via the §4.2 per-request ban check; the ban is per-seat and never touches `vendors.verified`. Direct SQL against the per-environment **D1** database remains a fallback.

---

## 8. GDPR right-to-erasure

Under ADR 0016 the authoritative `profiles` row lives in **D1**, so erasure is
driven by the Worker (§ flow below), not by the Postgres triggers — those are now
**vestigial** (§8.1). The D1 schema still carries the FK anonymization seam:

- `reviews.reviewer_id REFERENCES profiles(id) ON DELETE SET NULL` — the **only**
  inbound FK to `profiles` that auto-nulls. This is the anonymization seam:
  deleting the profile leaves the review content intact with no author.
- The remaining inbound references are nulled explicitly in the erasure batch (the
  FK trap, below).

**Third-party processors.** Erasure covers our own stores; the one external
egress of review content is toxicity scoring, which sends the review body to
Anthropic (`apps/api/src/lib/toxicity.ts`, AECI-258). The Messages API has no
per-request no-store control (Perspective's `doNotStore` had no equivalent), so
the Anthropic org behind `ANTHROPIC_API_KEY` **must** have zero data retention
(ZDR) enabled — otherwise a scored body is retained for the provider's default
window (~30 days) outside this boundary. Confirm ZDR before provisioning a real
key; the absent-key path (a silent no-op) sends nothing.

**The FK trap (AECI-202).** There are **eight** inbound FKs to `profiles(id)` in D1.
Five are `ON DELETE NO ACTION`, so any `DELETE FROM profiles` **FK-fails**
unless every one of them is nulled first. A real reviewer always trips at least
`audit_log.actor_id` (every `review.submitted` writes an `audit_log` row). The
full list:

| FK | ON DELETE | Erasure action |
| --- | --- | --- |
| `reviews.reviewer_id` | SET NULL | nulled (anonymize; explicit too, for the test) — the same statement also nulls the free-text `reviewer_firm` (AECI-284) |
| `reviews.moderated_by` | NO ACTION | nulled |
| `vendor_requests.resolved_by` | NO ACTION | nulled |
| `workflow_instances.initiated_by` | NO ACTION | nulled |
| `workflow_transitions.actor_id` | NO ACTION | nulled |
| `audit_log.actor_id` | NO ACTION | nulled (severs the actor link; rows survive) |
| `vendor_entitlements.granted_by` | SET NULL | nulled (explicit too, matching `reviews.reviewer_id`; the entitlement row survives — only the granting admin's link is severed) — AECI-609 |
| `vendor_seat_invites.invited_by_id` | SET NULL | nulled (explicit too; the **invite survives its sender's erasure** — a pending invite is the invitee's to redeem, so only the sender's link is severed) — AECI-664 |

There used to be one more — `page_views.user_id`, nulled in the same batch.
AECI-585 **dropped that column** (`ADMIN_PANEL_SPEC.md` §13 D7): it was never
written by any code path, so the statement was a permanent no-op, and filling it
would have meant inventing a durable first-party identifier. This **strengthens**
erasure rather than weakening it — `page_views` can no longer hold user linkage at
all, so there is nothing left in that table to erase, for this user or any other.

**Flow (`DELETE /api/account`, `requireAuth`, AECI-202; D1 re-platform AECI-254/278).**
Because the app store (D1) and Supabase Auth are now **separate systems** (ADR 0016),
erasure is a **two-system** operation — there is no single cross-system transaction
and no `apps/api/src/prisma.ts`:

1. User confirms Delete in `/account` → `DELETE /api/account`.
2. **D1 erasure — one atomic `db.batch([...])`** (`apps/api/src/routes/account.ts`):
   in order, null all eight inbound references above, write the `account.deleted`
   audit row, then delete the `profiles` row. All commit or roll back as a unit.
3. The `account.deleted` audit row has **`actorId = null`** — the profile is deleted
   in the same batch and `audit_log.actor_id` is `NO ACTION`, so a non-null actor
   would either block the profile delete (written before) or FK-reject (written
   after). The user id is recorded in `entity_id` + PII-free `metadata` (no email /
   display name).
4. **The `auth.users` row is deleted via the Supabase Admin API** — split-identity
   **seam #3** (§3.1): `deleteAuthUser(env, userId)`
   (`apps/api/src/lib/supabase-admin.ts`) issues a `DELETE /auth/v1/admin/users/:id`
   with the service-role key. It runs **after** the D1 batch commits and never
   throws, so a transient Admin-API failure does not undo the already-completed D1
   erasure (a `!ok` result is logged for retry). A 404 counts as success — the row
   is already gone. gotrue's own child tables
   (`sessions`/`refresh_tokens`/`identities`) cascade off `auth.users` on its side.

   ⚠️ **Absent creds are NOT equivalent to success.** With no
   `SUPABASE_SERVICE_ROLE_KEY` the call is skipped (`{ ok: true, skipped: true }`)
   and **the `auth.users` row survives** — the D1 erasure is complete, but the auth
   identity is not. Because the skip is reported as `ok`, the current call site logs
   nothing, so orphaned rows are today **undetectable**. The key is presently pushed
   to no Worker (§3.1), which means this is the live behaviour in every deployed
   environment. Tracked as **AECI-531** (warn on the skip + a cleanup runbook + a
   one-time reconciliation of the historical orphans).
5. **Confirmation email is sent via Resend** (AECI-240 / Phase 7.5, `docs/email.md`)
   — fire-and-forget and fail-open, captured from the session before erasure;
   deletion never blocks on email.

The "background sweep" once imagined for `page_views`/`audit_log` is performed
**synchronously, inside the D1 erasure batch, before the profile delete** — there is
no separate async sweep, and since AECI-585 the `page_views` half has nothing to
sweep. No client-side path exists to read or modify deleted users'
data: the sensitive D1 tables have no public read surface (Worker-only), and the rows
that remain have NULL where the user ID used to be.

### 8.1 Auth → public sync triggers (vestigial under ADR 0016)

> **Vestigial.** These triggers operate on the **Supabase Postgres** `public.profiles`
> table. Under ADR 0016 the authoritative `profiles` row lives in **D1**, not Postgres —
> the Worker creates it via `POST /api/auth/profile/ensure` on first sign-in, and erasure
> deletes the D1 profile in the Worker (§ flow) + the `auth.users` row via the Admin API.
> The two triggers below still exist in the auth-only baseline
> (`supabase/migrations/20260626000000_auth_only_baseline.sql`) but the app does not depend
> on the Postgres `public.profiles` they maintain. Kept for the historical pattern and in
> case the retained Auth project's own `public.profiles` mirror is ever reused.
>
> **Seam #4b creates `auth.users` rows from the app side** (§3.1), so
> `on_auth_user_created` *will* fire and insert a row into the Postgres
> `public.profiles` mirror the app never reads. That mirror row is inert: the
> authoritative profile — and the `vendor_admin` / `vendor_id` the grant writes — lives
> in D1. Don't chase it, and don't design the claim flow assuming a trigger provisions
> the D1 profile.

`public.profiles.id` carries the same UUID as the corresponding
`auth.users.id`, but there is **no cross-schema FK between them**.
The Postgres lifecycle is kept in sync by two triggers on `auth.users`:

| Event                                | Trigger                  | Function                              | Effect                                       |
| ------------------------------------ | ------------------------ | ------------------------------------- | -------------------------------------------- |
| `AFTER INSERT ON auth.users`         | `on_auth_user_created`   | `public.handle_new_user()`            | `INSERT INTO public.profiles (id) VALUES (NEW.id)` |
| `AFTER DELETE ON auth.users`         | `on_auth_user_deleted`   | `public.handle_auth_user_delete()`    | `DELETE FROM public.profiles WHERE id = OLD.id`    |

**Why triggers instead of an FK.** Until AECI-69 (2026-05-26), this was
`profiles.id REFERENCES auth.users(id) ON DELETE CASCADE`. That worked
fine at runtime, but it forced the then-`apps/api/prisma/schema.prisma` to enable
multi-schema and mirror the entire `auth.*` gotrue surface (~500 lines
of models that churned on every Supabase upgrade). Replacing the FK
with a trigger gave the same delete-cascade behaviour with none of the
Prisma overhead (and Prisma itself is now gone — AECI-278). The reasoning
chain — including the three failed attempts to keep the FK and live with
multi-schema — is in `docs/adr/0007-prisma-migrate-dev-unsupported.md` §5.3.

**Insert-time integrity (historical, Postgres).** Without the FK, in principle a
Postgres `profiles` row could be inserted referencing a non-existent `auth.users.id`.
In practice every Postgres `profiles` row was created by `on_auth_user_created`
firing from a real `auth.users` INSERT, and the `authenticated` role had no INSERT
privilege on it. Under D1 this is moot: the authoritative profile is the **D1** row
created by `POST /api/auth/profile/ensure`.

**Canonical pattern for future `auth.users` triggers.** If we add more
sync triggers in the future, use this shape (mirrors AECI-44's
hardening rule for every `SECURITY DEFINER` function):

```sql
CREATE OR REPLACE FUNCTION public.<name>()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- mutate public.* using NEW / OLD as appropriate
  RETURN <NEW | OLD>;
END;
$$;

DROP TRIGGER IF EXISTS <trigger_name> ON auth.users;
CREATE TRIGGER <trigger_name>
  AFTER <INSERT | UPDATE | DELETE> ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.<name>();
```

Coverage: the original `auth_user_delete_trigger.spec.ts` integration spec was
removed in the D1 migration (PR #359) — under ADR 0016 the app tables it
cascaded into live on Cloudflare D1, not Postgres. Any **new** `auth.users`
sync trigger should land with its own dual-path test (Supabase admin-API delete
+ a direct `DELETE FROM auth.users`). (Reconciling this section's trigger model
with the D1 app DB is part of the AECI-256/257 Supabase-Postgres decommission.)

### 8.2 Vendor seats & the last-seat edge

A `vendor_admin` **seat *is* a `profiles` row** — it carries `role = 'vendor_admin'` plus a
non-null `vendor_id`. `DELETE /api/account` (`routes/account.ts`, the §8 flow) deletes that
`profiles` row and **never touches the `vendors` table**: there is no `vendors.verified = false`
flip anywhere in the handler, and there is **no inbound FK from `vendors` to `profiles`**, so
the erasure batch's seven-FK trap (§8, above) is unaffected and nothing cascades to the vendor.
(AECI-609 added the seventh ref, `vendor_entitlements.granted_by`. It points at the *granting
admin*, not the vendor, so deleting a seat still cannot disturb the vendor's entitlement — the
row survives with `granted_by` nulled.)

**The last-seat edge (2026-07-24 epic review, AECI-513).** Deleting a vendor's **only**
`vendor_admin` seat removes the last seat but leaves **`vendors.verified = true`**. This is a
**legitimate state, not a bug**: `verified` is vendor-level paid state, **decoupled** from
seats — the same §8.3(2) decoupling under which revoke and ban never un-verify
(`STAGE_2_SPEC.md` §8.3(2); §3.2 above). An un-verify writer now exists (**AECI-532**,
`docs/STAGE_2_PAID_TIERS_SPEC.md` §5), and it changes nothing here: it is a **deliberate admin
act on the vendor**, not a consequence of a seat disappearing, and account-deletion still does
not reach for it. **The entitlement is vendor-level and the seat is not, so losing the last
seat leaves the entitlement row — and therefore the mirror — intact, by design.** The vendor is
therefore **verified-but-unclaimed**, and that is the correct reading: somebody paid for a term
that has not ended. It diverges from the
"claimed = ≥1 *active* `vendor_admin` seat" predicate (`loadClaimedVendorIds`,
`lib/claimed-vendors.ts`) — the same divergence a fully-banned vendor exhibits. AECi re-grants
a seat through the normal claim→grant flow (§3.2) when a new contact is verified. (Erasure's
own `auth.users` orphan — seam #3 skipping when creds are absent — is the separate AECI-531
thread, §8 step 4.)

---

## 9. Stage 2 forward compatibility

Stage 2 introduces the **vendor portal** (`vendor_admin`). Its authorization is the **3-layer Worker model above — not Postgres RLS/GRANTs** (there are none on app tables under ADR 0016). The full plan is `docs/STAGE_2_VENDOR_PORTAL_SPEC.md`; the shape:

- **`vendor_admin` role** — already in the `profiles.role` CHECK constraint. Granted **app-side on vendor-claim approval** — the same app-layer seam as `admin` (no `auth.users`↔`profiles` FK, AECI-254), audited and reversible. There are no "vendor policies" to write.
- **Who the grant is granted to** — the claim form is anonymous, so the subject comes from **seam #4** (§3.1): `resolveClaimantIdentity` turns `vendor_requests.submitter_email` into an auth-user id, reporting `linked` (an account already existed) or `invited` (one was provisioned). Role/vendor exclusivity is enforced there — an account that is already `admin`, or already `vendor_admin` for a *different* vendor, yields an explicit `conflict` rather than a silent overwrite; a second seat on the *same* vendor is the allowed case. Contract: `STAGE_2_VENDOR_PORTAL_SPEC.md` §2.
- **`vendorId` on the session** — the Layer-1 guard (`createAuthzMiddleware`, §4.2) gains a `requireVendor()` branch and adds `profiles.vendor_id` to the profile re-fetch, so it rides on `AuthenticatedSession`.
- **`vendor_id`-scoped queries** — every `/api/vendor/*` read and write filters by the session's `vendor_id` in the **Drizzle query** (`WHERE vendor_id = :sessionVendorId`). This is the D1/Drizzle replacement for the row filter the retired RLS design would have applied; the Worker never trusts a client-supplied vendor/target id. Every write emits its `audit_log` row in the same `db.batch()` (§4.3).
- **Ban gate** — `profiles.banned_at` already gates vendor seats through the existing §4.2 / §7 check; portal abuse is a ban path (per-seat — it never touches `vendors.verified`).
- **The entitlement tier on the session** — **shipped** (AECI-611, `docs/STAGE_2_PAID_TIERS_SPEC.md` §4). `AuthenticatedSession` carries `entitlementTier` + `entitlement`, loaded by the `vendor_admin` guard branch, and `/api/vendor/*` **writes** assert a capability against it (§4.2b). This is the one part of Stage 2 authorization that **did** need a migration — see below.

**Stage 2 authorization needed no migration; Stage 2 *entitlements* needed exactly one.** The authorization hooks (`profiles.role` `vendor_admin`, `profiles.vendor_id`, `vendors.verified`, `profiles.banned_at`) already existed, which is why the vendor portal (AECI-513) shipped without DDL. The Paid Tiers epic (AECI-515) could not: there was no reserved entitlement table, so it added **`vendor_entitlements`** (`DATABASE_SCHEMA.md` §8.5) and demoted `vendors.verified` to a mirror of it (§3.2 above). That is the only schema change either epic made, and it is additive — no reader changed.

The `vendor_admin` surface is **fully documented above** (AECI-525, extended by AECI-615): role-exclusivity, the grant/revoke/ban mechanics and the mirror invariant in **§3.2**, the split-identity claimant seam #4 in **§3.1**, the entitlement tier on the session in **§4.2b**, the endpoint-by-endpoint rows + `vendor_id`-scoping obligations in **§4.4**, the seventh inbound FK in **§8**, and the GDPR last-seat edge in **§8.2**. The bullets above are the summary; those sections are the contract.

---

## 10. Testing

> **Layer 2/3 tests are historical (Supabase-Postgres-only).** Under ADR 0016 the only
> live authorization tests for app tables are the Worker (Layer 1) tests plus the app-layer
> **no-leakage test matrix** (`reviews.authz-matrix.spec.ts` / `profiles.authz-matrix.spec.ts`,
> AECI-234) over the in-memory D1 harness — see the status banner. The GRANT / RLS test
> blocks below describe the retired PostgREST layers and are kept for design history.

### 10.1 What to test at each layer

**Worker authorization tests** (primary, the live gate): integration tests against actual HTTP endpoints with various JWT scenarios:

- Missing JWT on protected route → 401
- Expired JWT → 401
- Valid JWT, non-banned user → success
- Valid JWT, banned user → 403
- Valid JWT, non-admin on admin route → 403
- Valid JWT, admin on admin route → success
- Banned user attempts review submission → 403 before the handler (and any write) runs
- Audit log entry created on every state change (assert the row exists)
- Audit log atomicity verified: a failing `db.batch([...])` leaves neither the mutation nor the audit row (both roll back)

**GRANT layer tests** (Layer 2, historical): SQL-level tests verifying that tables with no grant returned `42501`:

```ts
test('anon cannot SELECT audit_log (blocked at GRANT layer)', async () => {
  const { error } = await anon.from('audit_log').select('*');
  expect(error?.code).toBe('42501');
  expect(error?.message).toContain('permission denied');
});

test('anon cannot SELECT profiles (blocked at GRANT layer)', async () => {
  const { error } = await anon.from('profiles').select('*');
  expect(error?.code).toBe('42501');
});

test('authenticated cannot SELECT vendor_requests', async () => {
  const userClient = createClient(url, anon, { /* with user JWT */ });
  const { error } = await userClient.from('vendor_requests').select('*');
  expect(error?.code).toBe('42501');
});
```

**RLS tests** (Layer 3, historical): tests against granted Postgres tables verifying that row filtering worked (the `prisma.*` seed calls below are from the retired Prisma path):

```ts
test('anon cannot see pending products (blocked at RLS layer)', async () => {
  await prisma.product.create({
    data: { slug: 'rls-test', name: 'X', promotionStatus: 'pending' },
  });
  const { data, error } = await anon.from('products').select('*').eq('slug', 'rls-test');
  // GRANT allows SELECT, but RLS filters the row out
  expect(error).toBeNull();
  expect(data).toEqual([]);
});

test('anon can see promoted products', async () => {
  await prisma.product.create({
    data: { slug: 'rls-promoted', name: 'Y', promotionStatus: 'promoted' },
  });
  const { data } = await anon.from('products').select('*').eq('slug', 'rls-promoted');
  expect(data).toHaveLength(1);
});

test('authenticated user can SELECT own profile only', async () => {
  const { jwt, user } = await makeUser('reviewer');
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data } = await userClient.from('profiles').select('*');
  expect(data).toHaveLength(1);
  expect(data![0].id).toBe(user.id);
});
```

### 10.2 Distinguishing layer failures

When a test fails, the error code tells you which layer rejected the request:

| Error code | Meaning | Layer |
|---|---|---|
| `42501` | permission denied | Layer 2 (GRANT) |
| (No error, empty result) | RLS filtered all rows | Layer 3 (RLS) |
| `401 auth_required` / `403 forbidden` | Worker rejected | Layer 1 |

---

## 11. Applying the migration (historical)

> **Decommissioned (AECI-278).** The authorization surface described here applied to the
> **Supabase Postgres** public app tables, which now live in **Cloudflare D1**. The GRANT/RLS
> migration (`20260602051513_rls_grants_and_policies.sql`) and the `ensure_rls` capture
> trigger migration were **archived** under `supabase/archive/migrations/`;
> `supabase/migrations/` is now a single **auth-only baseline**. The verification scripts
> `scripts/apply-authorization.sql` and `scripts/verify-rls.sql` were **deleted**, and
> `refresh-staging.yml` / `promote-to-prod.yml` no longer run a Postgres `supabase db push`
> or the RLS verify gate. The live PR gate is the drizzle-kit schema-drift check
> (`drift-check.yml`, AECI-264) plus the app-layer no-leakage matrix (§10). The text below is
> kept as a record of the former Postgres apply path.

The entire authorization surface — the `public.is_admin()` /
`public.is_active_user()` helpers, the PostgREST GRANTs, and the RLS policies —
was a numbered migration
(`supabase/migrations/20260602051513_rls_grants_and_policies.sql`, now archived), so it applied
to every environment through the normal migration path. There was no separate
apply step and no `supabase_admin`-only out-of-band script — that was AECI-87's
fix (the helpers moved out of the `auth` schema precisely so the `postgres`
migration role could create them; see §6.1).

Staging and production once got it via `supabase db push --linked`, after which both workflows
ran `psql "$DIRECT_URL" -f scripts/verify-rls.sql` as a hard-stop gate proving the
GRANT/RLS matrix was in effect (and that the `feedback`/`mailing_list` landing
carve-out survived the blanket REVOKE). That whole Postgres apply+verify path was removed with
the decommission — the landing tables themselves moved to D1 (AECI-257).

Defence-in-depth (historical): every public-schema `CREATE TABLE` triggered the `ensure_rls`
event trigger (added by the now-archived
`20260525064254_capture_rls_auto_enable.sql`), which
auto-enabled row level security on the new table, and the
`20260602051513_rls_grants_and_policies.sql` migration then attached the actual
GRANTs + policy bodies.

### 11.1 Verification queries

After applying, run these in the Supabase SQL editor to confirm the grants landed correctly:

```sql
-- Tables anon can SELECT from (should match the "✅" rows in §6.2)
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public'
order by table_name;

-- Tables with no grant for anon (should include audit_log, page_views,
-- profiles, vendor_requests, workflow_instances, workflow_transitions)
select t.table_name
from information_schema.tables t
where t.table_schema = 'public'
  and t.table_type = 'BASE TABLE'
  and not exists (
    select 1 from information_schema.role_table_grants g
    where g.grantee = 'anon'
      and g.table_schema = 'public'
      and g.table_name = t.table_name
  )
order by t.table_name;

-- Default privileges (should show nothing for anon/authenticated)
select * from pg_default_acl
where pg_get_userbyid(defaclrole) in ('postgres', 'supabase_admin');
```

### 11.2 Dashboard checks

- All tables show "RLS enabled" with no warnings
- Security Advisor shows no "Public table without RLS" findings
- Anon-key queries against `audit_log`, `page_views`, `profiles`, `vendor_requests`, `workflow_*` return `42501`
- Anon-key queries against `vendors`, `products` return only promoted rows