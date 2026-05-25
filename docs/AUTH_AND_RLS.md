# AEC Integrations — Authorization Model, GRANTs & RLS Policies

**Referenced by:** `STAGE_1_SPEC.md` §8 (Authentication), §15 (Security), §22 (Content Moderation), §26 (Audit Trail), `DATABASE_SCHEMA.md` §12
**Version:** 3.0
**Date:** May 2026

---

## 1. Authorization model at a glance

There are **three layers** of authorization in front of the database. Layer 1 handles ~all real traffic; Layers 2 and 3 are defense in depth against PostgREST exposure.

```
                                                                ┌─────────────┐
  Browser ── HTTPS ──► SSR Worker ──► API Worker ── Prisma ─────► Postgres   │
                          (JWT)        (JWT verify,  Accelerate    (bypasses │
                                        role check,                GRANTs +  │
                                        audit log)                 RLS)      │
                                                                └─────────────┘
                                                                       ▲
                                                                       │
  Browser ── HTTPS ──► PostgREST (/rest/v1/*) ── anon/auth ─────────────┘
                                                  │
                                                  ├─► GRANT check (binary, table-level)
                                                  └─► RLS check   (row-level filter)
```

**Layer 1 — Worker authorization (primary).** All real traffic flows through the API Worker. The Worker verifies the user's Supabase JWT, looks up their role and ban status, runs Zod validation, calls Prisma, and writes an audit log entry in the same transaction. This is where authorization actually happens.

**Layer 2 — PostgREST GRANTs.** Supabase's PostgREST endpoint at `/rest/v1/*` is enabled by default. The anon key is publicly embeddable and can hit it. The GRANT layer is binary: if `anon` or `authenticated` has no `GRANT SELECT` on a table, PostgREST returns `42501 insufficient_privilege` immediately, before RLS is even consulted. Tables with no grant are invisible — full stop.

**Layer 3 — RLS row-filtering.** For tables that *are* granted (the public-read tables: vendors, products, reviews, etc.), RLS filters which rows are returned. Promoted-only on directory tables, approved-only on reviews, own-row-only on profiles.

The Worker's Prisma Accelerate connection uses a privileged Postgres role that bypasses both GRANTs and RLS. That is correct and expected — the Worker is trusted and enforces its own authorization.

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
| `reviewer` | Any authenticated user | Auto via `handle_new_user()` trigger on `auth.users` insert |
| `admin` | Chris and Bill | Manual SQL update in Supabase dashboard |
| `vendor_admin` | Stage 2+ vendor contacts | Reserved — schema ready, not yet used |

Banned users retain their role but have `profiles.banned_at` set. The `auth.is_active_user()` helper checks both identity and ban status.

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

### 4.2 Role and ban check before Prisma

After JWT verification, the Worker loads the profile and checks role and ban status. Banned users are rejected; non-admins on admin routes are rejected. This check must happen **before** any Prisma write.

```ts
export async function requireRole(
  ctx: AuthContext,
  prisma: PrismaClient,
  required: 'reviewer' | 'admin',
): Promise<Profile> {
  const profile = await prisma.profile.findUnique({ where: { id: ctx.userId } });
  if (!profile) throw new HttpError(401, 'profile_missing', 'Profile not found');
  if (profile.bannedAt) {
    throw new HttpError(403, 'account_banned', profile.banReason ?? 'Account suspended');
  }
  if (required === 'admin' && profile.role !== 'admin') {
    logSecurityEvent(env, 'unauthorized_admin_attempt', { userId: ctx.userId });
    throw new HttpError(403, 'forbidden', 'Admin role required');
  }
  return profile;
}
```

### 4.3 Audit log inside the transaction

Every state-changing write happens inside a Prisma transaction together with its audit log entry. If either fails, both roll back.

```ts
const [updated] = await prisma.$transaction([
  prisma.product.update({ where: { id }, data: input }),
  prisma.auditLog.create({
    data: {
      actorId: ctx.userId,
      actorType: profile.role === 'admin' ? 'admin' : 'user',
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      beforeState: prevState,
      afterState: input,
      metadata: { cfCountry: request.cf?.country },
    },
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

### 4.5 Things the Worker never does

- Pass user-supplied SQL to Prisma raw queries
- Trust client-side claims about role (the Worker re-fetches profile every request)
- Skip the audit log for "small" updates
- Use the postgres role for SELECT-only queries — Prisma Accelerate's connection is the only path
- Return 200 on auth failures (always 401 or 403 with a stable error code)

---

## 5. PostgREST GRANTs (Layer 2)

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

`ALTER DEFAULT PRIVILEGES` is set so any table Prisma creates from now on starts with no grants to `anon` or `authenticated`. To expose a new table via PostgREST, a future migration must explicitly issue the grant. This matches the post-Oct-30 Supabase default behavior.

---

## 6. RLS policies (Layer 3)

### 6.1 Helper functions

```sql
create or replace function auth.is_admin()
  returns boolean
  language sql security definer stable
  set search_path = public, auth
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function auth.is_active_user()
  returns boolean
  language sql security definer stable
  set search_path = public, auth
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and banned_at is null
  );
$$;
```

Both are `security definer` with an explicit `search_path` to prevent search-path attacks. EXECUTE is granted to `anon` and `authenticated` only — not `public`.

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

Enforced at both Layer 1 and Layer 3.

**Worker (primary):** `requireRole()` checks `bannedAt` before any protected action. Banned users get `403 account_banned` with their `banReason` if set. Banned users cannot submit reviews, claim vendors, file corrections, or modify their account. They can still read public data — the read endpoints don't call `requireRole()`.

**RLS (defense in depth):** `auth.is_active_user()` returns false for banned users. The `reviews: owner read own` policy uses it, so a banned user cannot read their own pending reviews via PostgREST. Approved reviews remain readable through the `reviews: public read approved` policy — banning does not retroactively hide past content.

Bans are applied manually by an admin via SQL in the dashboard until a Stage 2 admin UI exists.

---

## 8. GDPR right-to-erasure

The schema does most of the work via cascading FKs:

- `profiles.id REFERENCES auth.users(id) ON DELETE CASCADE`
- `reviews.reviewer_id REFERENCES profiles(id) ON DELETE SET NULL`
- `page_views.user_id` and `audit_log.actor_id` reference `profiles(id)` without ON DELETE — they retain a dangling UUID until a background sweep nulls them

**Flow:**

1. User clicks Delete in `/account`
2. Worker calls Supabase Auth Admin API to delete the user
3. Postgres cascades: `auth.users` removed → `profiles` cascade-deleted → `reviews.reviewer_id` set null
4. Worker writes audit entry `account.deleted` with the now-gone user's ID as metadata
5. Loops sends confirmation email
6. Background sweep (or same Worker call) nulls `page_views.user_id` and `audit_log.actor_id`

No client-side path exists to read or modify deleted users' data — GRANTs block the sensitive tables entirely, and the rows that remain on public tables have NULL where the user ID used to be.

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

### 10.1 What to test at each layer

**Worker authorization tests** (primary): integration tests against actual HTTP endpoints with various JWT scenarios:

- Missing JWT on protected route → 401
- Expired JWT → 401
- Valid JWT, non-banned user → success
- Valid JWT, banned user → 403
- Valid JWT, non-admin on admin route → 403
- Valid JWT, admin on admin route → success
- Banned user attempts review submission → 403 before Prisma is called
- Audit log entry created on every state change (assert the row exists)
- Audit log rollback verified: force an audit insert error and assert the mutation rolled back

**GRANT layer tests** (Layer 2): SQL-level tests verifying that tables with no grant return `42501`:

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

**RLS tests** (Layer 3): tests against granted tables verifying that row filtering works:

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

## 11. Applying the migration

Schema migrations live in `supabase/migrations/`; RLS policy + GRANT
definitions live in `docs/rls_policies.sql`. Apply schema first, then
policies on top:

```bash
# Local development
pnpm db:start            # boot Postgres + auth + PostgREST + Storage + Studio
pnpm db:reset            # apply every migration in supabase/migrations/ + seed.sql
pnpm --filter @aeci/api db:apply-rls   # apply GRANTs + RLS policies
pnpm --filter @aeci/api test:integration
```

`db:apply-rls` execs into the local Supabase Postgres container as
`supabase_admin` (the only superuser locally — `postgres` lacks
permission on the `auth` schema). For staging/production, the apply
sequence runs through `supabase db push --linked` (schema) followed by
the RLS application step from CI (wiring deferred to AECI-71; see
`CICD_PLAN.md` §5). The equivalent manual recipe is
`psql "$DIRECT_URL" -f docs/rls_policies.sql` with `$DIRECT_URL`
pointing at a connection with rights on the `auth` schema.

Defence-in-depth: every public-schema `CREATE TABLE` triggers the
`ensure_rls` event trigger (added by
`supabase/migrations/20260525064254_capture_rls_auto_enable.sql`),
which auto-enables row level security on the new table. The policy
bodies in `rls_policies.sql` then attach the actual rules. Both must
agree — RLS-enabled with no matching policy means the table is read-
locked to PostgREST clients.

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