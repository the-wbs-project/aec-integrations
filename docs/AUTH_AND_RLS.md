# AEC Integrations — Authorization Model, GRANTs & RLS Policies

**Referenced by:** `STAGE_1_SPEC.md` §8 (Authentication), §15 (Security), §22 (Content Moderation), §26 (Audit Trail), `DATABASE_SCHEMA.md` §12
**Version:** 3.0
**Date:** May 2026

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
| `admin` | Chris and Bill | Manual `UPDATE profiles SET role='admin'` against the per-environment **D1** database |
| `vendor_admin` | Stage 2+ vendor contacts | Reserved — schema ready, not yet used |

Banned users retain their role but have `profiles.banned_at` set; the Worker (`apps/api/src/lib/authz.ts`) checks both identity and ban status against D1. (The Postgres `public.is_active_user()` helper is part of the historical RLS surface and no longer governs app-table access.)

---

## 4. Worker authorization (Layer 1)

This is where authorization is actually enforced. The patterns here are not optional — every protected endpoint follows them.

### 4.1 JWT verification — hard fail

Every authenticated endpoint verifies the JWT and rejects anything malformed, expired, or unverifiable with `401 Unauthorized`. A missing JWT on an authenticated route is `401`, not anonymous treatment.

```ts
// apps/api/src/middleware/auth.ts
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
| `POST /api/reviews` | Hard-required | `reviewer`, not banned | `review.submitted` |
| `DELETE /api/account` | Hard-required | Active user | `account.deleted` |
| `POST /api/requests/claim`, `/correction` | None (anon form) | None | `claim/correction.submitted` |
| `POST /api/track/pageview` | Optional | None | Logged to `page_views` |
| `GET /api/admin/*` | Hard-required | `admin` | No (reads only) |
| `PATCH /api/admin/reviews/:id` | Hard-required | `admin` | `review.approved` / `.rejected` |
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

### 4.5 Things the Worker never does

- Pass user-supplied SQL into raw Drizzle/D1 queries (use parameterized queries / the query builder)
- Trust client-side claims about role (the Worker re-fetches the D1 profile every request)
- Skip the audit log for "small" updates
- Reach the DB by any path other than the request-scoped Drizzle client over the `DB` binding (`getDb(env)`)
- Return 200 on auth failures (always 401 or 403 with a stable error code)

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

Bans are applied manually by an admin via SQL against the per-environment **D1** database until a Stage 2 admin UI exists.

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

**The FK trap (AECI-202).** There are **six** inbound FKs to `profiles(id)` in D1.
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

There used to be a seventh — `page_views.user_id`, nulled in the same batch.
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
   in order, null all six inbound references above, write the `account.deleted`
   audit row, then delete the `profiles` row. All commit or roll back as a unit.
3. The `account.deleted` audit row has **`actorId = null`** — the profile is deleted
   in the same batch and `audit_log.actor_id` is `NO ACTION`, so a non-null actor
   would either block the profile delete (written before) or FK-reject (written
   after). The user id is recorded in `entity_id` + PII-free `metadata` (no email /
   display name).
4. **The `auth.users` row is deleted via the Supabase Admin API** —
   `deleteAuthUser(env, userId)` (`apps/api/src/lib/supabase-admin.ts`) issues a
   `DELETE /auth/v1/admin/users/:id` with the service-role key. It runs **after** the
   D1 batch commits; it never throws (a 404 / absent-creds path counts as success),
   so a transient Admin-API failure does not undo the already-completed D1 erasure
   (it is logged for retry). gotrue's own child tables
   (`sessions`/`refresh_tokens`/`identities`) cascade off `auth.users` on its side.
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

---

## 9. Stage 2 forward compatibility

When Stage 2 introduces the vendor portal:

- **`vendor_admin` role** — already in the `profiles.role` CHECK constraint. New policies will grant vendor admins scoped read/write on `vendors` and `products` rows linked to `profiles.vendor_id`.
- **`profiles.vendor_id`** — foreign key already exists.
- **New tables created in Stage 2** — will inherit the no-default-grants policy from `ALTER DEFAULT PRIVILEGES`. Each new table will need explicit GRANT statements in its migration to be exposed via PostgREST. This is intentional.
- **If vendor writes also go through the API Worker** (likely), the Stage 2 RLS layer is purely defense in depth, same as Stage 1.

No schema migrations required for Stage 2 authorization. New policies layer on.

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