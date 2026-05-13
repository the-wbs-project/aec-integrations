# AEC Integrations — Authorization Model & RLS Policies

**Referenced by:** `STAGE_1_SPEC.md` §8 (Authentication), §15 (Security), §22 (Content Moderation), §26 (Audit Trail), `DATABASE_SCHEMA.md` §12
**Version:** 2.0
**Date:** May 2026

---

## 1. Authorization model at a glance

There are **two layers** of authorization in front of the database. Both must hold for the system to be considered safe.

```
                                                                ┌─────────────┐
  Browser ── HTTPS ──► SSR Worker ──► API Worker ── Prisma ─────► Postgres   │
                          (JWT)        (JWT verify,  Accelerate    (RLS      │
                                        role check,                bypassed) │
                                        audit log)                           │
                                                                └─────────────┘
                                                                       ▲
                                                                       │
  Browser ── HTTPS ──► PostgREST (/rest/v1/*) ──────── anon/auth ──────┘
                          (Supabase default)            (RLS enforced)
```

**Layer 1 — Worker authorization (primary).** All real traffic flows through the API Worker. The Worker verifies the user's Supabase JWT, looks up their role and ban status, runs Zod validation, calls Prisma, and writes an audit log entry in the same transaction. This is where authorization actually happens.

**Layer 2 — RLS on PostgREST (defense in depth).** Supabase enables PostgREST on every project. The anon key is by design public and can hit `/rest/v1/<table>` directly. If RLS were off, an anon key leak would expose the entire database. With these policies in place, the PostgREST surface returns only public directory data, and only for promoted records.

The Worker's Prisma Accelerate connection uses a privileged Postgres role that bypasses RLS. That is correct and expected — the Worker is trusted and enforces its own authorization.

---

## 2. Roles

Three roles exist in `profiles.role` (a text enum with a CHECK constraint). All are set server-side — no client can self-assign a role.

| Role | Who | How assigned |
|---|---|---|
| `reviewer` | Any authenticated user | Auto-assigned on first login via the `handle_new_user()` trigger on `auth.users` insert |
| `admin` | Chris and Bill | Manual SQL update in Supabase dashboard |
| `vendor_admin` | Stage 2+ vendor contacts | Reserved — schema ready, not yet used |

Anonymous (unauthenticated) users have no role.

Banned users retain their role but have `profiles.banned_at` set. The `auth.is_active_user()` helper checks both identity and ban status.

---

## 3. Worker authorization (Layer 1)

This is where authorization is actually enforced. The patterns here are not optional — every protected endpoint follows them.

### 3.1 JWT verification — hard fail

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

    return {
      userId: payload.sub as string,
      email: payload.email as string | undefined,
    };
  } catch (err) {
    // Any verification failure is suspicious — log and refuse
    logSecurityEvent(env, 'jwt_verify_failed', { error: String(err) });
    throw new HttpError(401, 'auth_invalid', 'Invalid or expired token');
  }
}
```

**Why hard-fail rather than soft-fail:** an unauthenticated request to an authenticated endpoint is either a bug in our own code, a misconfigured client, or someone probing. None of these benefit from being silently downgraded to anonymous.

### 3.2 Role and ban check before Prisma

After JWT verification, the Worker loads the profile and checks role and ban status. Banned users are rejected; non-admins on admin routes are rejected. This check must happen **before** any Prisma write.

```ts
// apps/api/src/middleware/authorize.ts
export async function requireRole(
  ctx: AuthContext,
  prisma: PrismaClient,
  required: 'reviewer' | 'admin',
): Promise<Profile> {
  const profile = await prisma.profile.findUnique({
    where: { id: ctx.userId },
  });

  if (!profile) {
    throw new HttpError(401, 'profile_missing', 'Profile not found');
  }

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

### 3.3 Audit log inside the transaction

Every state-changing write happens inside a Prisma transaction together with its audit log entry (`DATABASE_SCHEMA.md` §18). If either fails, both roll back.

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
      metadata: { cfCountry: request.cf?.country, userAgent: request.headers.get('user-agent') },
    },
  }),
]);
```

### 3.4 Endpoint-by-endpoint expectations

| Endpoint | Auth | Role check | Audit |
|---|---|---|---|
| `GET /api/products`, `/api/vendors`, `/api/integrations`, `/api/taxonomy/*`, `/api/stats/home` | None | None | None |
| `GET /api/products/:slug/reviews` | None | None | None |
| `POST /api/reviews` | Hard-required | `reviewer`, not banned | Yes (`review.submitted`) |
| `DELETE /api/account` | Hard-required | Active user | Yes (`account.deleted`) |
| `POST /api/requests/claim`, `/api/requests/correction` | None (anonymous form) | None | Yes (`claim.submitted` / `correction.submitted`) |
| `POST /api/track/pageview` | Optional | None | No (logged to `page_views`, not `audit_log`) |
| `GET /api/admin/*` | Hard-required | `admin` | Read endpoints: no. Mutations: yes. |
| `PATCH /api/admin/reviews/:id` | Hard-required | `admin` | Yes (`review.approved` / `review.rejected`) |
| `POST /api/webhooks/linear` | HMAC-verified, not user JWT | N/A | Yes (`workflow.transitioned`) |

### 3.5 Things the Worker never does

- Pass user-supplied SQL to Prisma raw queries
- Trust client-side claims about role (the Worker re-fetches profile every request)
- Skip the audit log for "small" updates
- Use the postgres role for SELECT-only queries — Prisma Accelerate's connection is the only path
- Return 200 on auth failures (always 401 or 403 with a stable error code)

---

## 4. PostgREST and RLS (Layer 2)

### 4.1 Why this layer exists

Supabase enables PostgREST on every project at `https://<project>.supabase.co/rest/v1/*`. The project's anon key — designed to be publicly embeddable in frontends — can query any table exposed there. Even though Stage 1 does not use the Supabase JS client and routes all traffic through the API Worker, the PostgREST surface still exists and is reachable from the public internet.

The threat model is:

- Anon key leaks via `.env` commit, browser inspector, Stack Overflow paste, etc.
- Future code paths that someone adds without thinking about authorization
- Misconfiguration that accidentally exposes the API key to a less-trusted context

RLS contains the blast radius in all three cases. The cost of the policies is one-time SQL; the cost of an anon key leak without RLS is total database compromise.

### 4.2 Permission matrix (PostgREST surface only)

The Worker (Prisma Accelerate) bypasses all of this. These rules govern only what `anon` and `authenticated` roles can do via `/rest/v1/*`.

#### 4.2.1 Legend

| Symbol | Meaning |
|---|---|
| ✅ | Allowed |
| ❌ | Blocked |
| (promoted) | Restricted to rows where `promotion_status = 'promoted'` |
| (approved) | Restricted to reviews where `status = 'approved'` |
| (own) | Restricted to rows where the JWT subject matches the row owner |

#### 4.2.2 Core entities, taxonomy, and joins

| Table | Anon SEL | Auth SEL | Admin SEL | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|---|
| `vendors` | ✅ (promoted) | ✅ (promoted) | ✅ (promoted) | ❌ | ❌ | ❌ |
| `products` | ✅ (promoted) | ✅ (promoted) | ✅ (promoted) | ❌ | ❌ | ❌ |
| `integrations` | ✅ (both promoted) | ✅ (both promoted) | ✅ (both promoted) | ❌ | ❌ | ❌ |
| `taxonomy_*` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `product_*` joins | ✅ (product promoted) | ✅ (product promoted) | ✅ (product promoted) | ❌ | ❌ | ❌ |
| `translations` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

#### 4.2.3 User and content

| Table | Anon SEL | Auth SEL | Admin SEL | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|---|
| `profiles` | ❌ | ✅ (own) | ✅ (all) | ❌ | ❌ | ❌ |
| `reviews` | ✅ (approved) | ✅ (approved + own) | ✅ (all) | ❌ | ❌ | ❌ |

#### 4.2.4 Operations, workflow, and analytics

| Table | Anon SEL | Auth SEL | Admin SEL | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|---|
| `vendor_requests` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `workflow_instances` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `workflow_transitions` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `audit_log` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `page_views` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `stats_cache` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

### 4.3 Helper functions

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

### 4.4 Notable policy decisions

**Promoted-only filter on directory tables.** PostgREST should never leak draft, retracted, or rejected records. The promotion filter is in the `using` clause of every directory table's SELECT policy. Curator-stage data stays invisible to PostgREST callers regardless of how the query is constructed.

**Join tables also filter on promotion.** A naive policy that allowed `product_categories` to be read freely would let a caller enumerate which categories a non-promoted product belongs to. Every join table requires its product (and host product, where applicable) to be promoted.

**No write policies anywhere.** When RLS is enabled and no INSERT/UPDATE/DELETE policy exists, writes from `anon` and `authenticated` are denied by default. This is intentional. All writes are Worker-only.

**`integrations` requires both endpoints promoted.** A row with one promoted and one draft product would leak the existence of the draft product through the `target_product_id` column.

### 4.5 What is intentionally NOT in RLS

- **Owner-update policies on reviews.** Stage 1 reviews are immutable after submission. The Worker rejects edits; there's nothing for PostgREST RLS to allow.
- **Owner-update policies on profiles.** Profile changes go through the Worker so they can be audited.
- **Vendor scoping (`vendor_admin`).** Reserved for Stage 2.
- **Insert policies on `reviews`.** No Supabase JS client exists in Stage 1; if one is added later, the policy can be added then.

---

## 5. Banned user behavior

Banning is enforced at **both** layers.

**Worker (primary):** `requireRole()` checks `bannedAt` before any protected action. Banned users get `403 account_banned` with their `banReason` if set. Banned users cannot submit reviews, claim vendors, file corrections, or modify their account. They can still read public data (the read endpoints don't call `requireRole()`).

**RLS (defense in depth):** `auth.is_active_user()` returns false for banned users. The `reviews: owner read own` policy uses it, so a banned user cannot read their own pending reviews via PostgREST. Approved reviews remain readable through the `reviews: public read approved` policy — banning does not retroactively hide past content.

Bans are applied manually by an admin via SQL in the dashboard (`UPDATE profiles SET banned_at = now(), ban_reason = '...' WHERE id = '...'`) until a Stage 2 admin UI exists.

---

## 6. GDPR right-to-erasure

The schema does most of the work:

- `profiles.id REFERENCES auth.users(id) ON DELETE CASCADE`
- `reviews.reviewer_id REFERENCES profiles(id) ON DELETE SET NULL`
- `page_views.user_id` and `audit_log.actor_id` reference `profiles(id)` without ON DELETE — they retain a now-dangling UUID

**Flow:**

1. User clicks Delete in `/account`
2. Worker calls Supabase Auth Admin API to delete the user
3. Postgres cascades:
   - `auth.users` row removed
   - `profiles` row removed (FK cascade)
   - `reviews.reviewer_id` set to NULL on all that user's reviews (FK set null)
4. Worker writes an audit entry `account.deleted` with the now-gone user's ID as metadata
5. Loops sends a confirmation email
6. Background sweep nulls `page_views.user_id` and `audit_log.actor_id` where the referenced profile no longer exists (or this is done immediately in the same Worker call, before the cascade)

Either way, no client-side path exists to read or modify deleted users' data through RLS — the rows that remain have NULL where the user ID used to be.

---

## 7. Stage 2 forward compatibility

When Stage 2 introduces the vendor portal:

- **`vendor_admin` role** — already in the `profiles.role` CHECK constraint. New policies will grant vendor admins scoped read/write on `vendors` and `products` rows linked to `profiles.vendor_id`.
- **`profiles.vendor_id`** — foreign key already exists.
- **Vendor scope rule** — Stage 2 policy sketch:

  ```sql
  -- Stage 2 placeholder — not active in Stage 1
  create policy "vendors: vendor_admin update own"
    on vendors
    for update to authenticated
    using (
      exists (
        select 1 from profiles
        where id = auth.uid()
          and role = 'vendor_admin'
          and vendor_id = vendors.id
      )
    );
  ```

  Note: this layer is added only if a Stage 2 design actually exposes a Supabase JS client to vendors. If vendor writes also go through the API Worker (likely), this RLS policy is purely defense in depth, same as Stage 1.

- **`profiles.banned_at`** — already enforced by `auth.is_active_user()`.

No schema migrations required for Stage 2 RLS. New policies layer on.

---

## 8. Testing

### 8.1 What to test at each layer

**Worker authorization tests** (primary): integration tests in `apps/api/test/` that exercise the actual HTTP endpoints with various JWT scenarios:

- Missing JWT on protected route → 401
- Expired JWT → 401
- Valid JWT, non-banned user → success
- Valid JWT, banned user → 403
- Valid JWT, non-admin on admin route → 403
- Valid JWT, admin on admin route → success
- Banned user attempts review submission → 403 before Prisma is called
- Audit log entry created on every state change (assert the row exists post-call)
- Audit log rollback verified: force an audit insert error and assert the mutation rolled back

**RLS tests** (defense in depth): SQL-level tests against a local Supabase instance, using the Supabase JS client with anon and authenticated keys:

- Anon SELECT on `vendors` where `promotion_status = 'promoted'` → returns rows
- Anon SELECT on `vendors` where `promotion_status = 'pending'` → empty
- Anon SELECT on `profiles` → empty
- Anon SELECT on `audit_log` → empty
- Anon SELECT on `page_views` → empty
- Anon INSERT on any table → RLS violation
- Authenticated SELECT on own profile → returns row
- Authenticated SELECT on another user's profile → empty
- Admin (authenticated with role='admin') SELECT on `audit_log` → returns rows

### 8.2 Worker test fixture pattern

```ts
// apps/api/test/helpers/fixtures.ts
export async function makeUser(role: 'reviewer' | 'admin', opts: { banned?: boolean } = {}) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user } } = await supabaseAdmin.auth.admin.createUser({
    email: `test+${randomUUID()}@example.com`,
    email_confirm: true,
  });
  await prisma.profile.update({
    where: { id: user.id },
    data: { role, bannedAt: opts.banned ? new Date() : null },
  });
  const { data: { session } } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: user.email!,
  });
  return { user, jwt: session.access_token };
}
```

### 8.3 RLS test pattern

```ts
// apps/api/test/rls/anonymous.test.ts
import { createClient } from '@supabase/supabase-js';

const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

test('anon cannot see pending products', async () => {
  await prisma.product.create({
    data: { slug: 'rls-test-pending', name: 'RLS Test', promotionStatus: 'pending' },
  });
  const { data } = await anon.from('products').select('*').eq('slug', 'rls-test-pending');
  expect(data).toEqual([]);
});

test('anon cannot read profiles', async () => {
  const { data, error } = await anon.from('profiles').select('*');
  expect(data).toEqual([]);
});

test('anon cannot insert into reviews', async () => {
  const { error } = await anon.from('reviews').insert({ /* ... */ });
  expect(error?.code).toBe('42501'); // insufficient_privilege
});
```

---

## 9. Applying the migration

The SQL file `rls_policies.sql` lives in `supabase/migrations/` (per the discussion in this chat) with a timestamp prefix that ensures it runs after the initial schema migration.

```bash
# CI / production deploy
pnpm prisma migrate deploy

# Manual application
psql "$DIRECT_URL" -f supabase/migrations/<timestamp>_rls_policies.sql

# Local development
supabase start
psql "postgresql://postgres:postgres@localhost:54322/postgres" \
  -f supabase/migrations/<timestamp>_rls_policies.sql
pnpm test:rls
```

After applying, verify in the Supabase dashboard:

- All tables show "RLS enabled" with no warnings
- Public read tables return promoted records only when queried with the anon key
- Admin-only tables return empty results when queried with the anon key