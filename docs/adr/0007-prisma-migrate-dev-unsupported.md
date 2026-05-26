# ADR 0007: `prisma migrate dev` is unsupported on this repo

**Status:** **Superseded by AECI-72 (2026-05-25); root cause resolved by AECI-69 (2026-05-26)** — both pillars of the original constraint are gone. Prisma migrations were retired entirely in favour of Supabase CLI migrations (`supabase/migrations/`) under AECI-72, and AECI-69 then implemented §5.3 below (drop the cross-schema FK; replace its `ON DELETE CASCADE` semantics with a sibling AFTER DELETE trigger on `auth.users`) so the `auth.*` mirror no longer needs to live in `schema.prisma`. See `docs/migrations.md` for the canonical workflow and the **Resolution** section below for the cleanup that landed.

The rest of this ADR is retained for historical context — it documents the Catch-22 between Prisma's drift detector and Supabase's `auth.users` schema that motivated both the move away from Prisma migrations and the §5.3 FK removal.

**Date:** 2026-05-24 (original) · **Superseded:** 2026-05-25 · **Root cause resolved:** 2026-05-26

**Context owner:** N/A — historical document.

---

## Resolution (AECI-69, 2026-05-26)

The cross-schema FK that drove this ADR was dropped in migration
`supabase/migrations/20260526083101_drop_profiles_auth_fk_add_delete_trigger.sql`.
In its place, the `ON DELETE CASCADE` semantics are provided by a sibling
AFTER DELETE trigger on `auth.users`:

- `public.handle_auth_user_delete()` — `SECURITY DEFINER` with pinned
  `search_path` per the AECI-44 hardening rule. Deletes
  `public.profiles WHERE id = OLD.id`.
- `on_auth_user_deleted` — AFTER DELETE FOR EACH ROW trigger that fires
  the function. Mirrors the existing `on_auth_user_created` INSERT trigger
  in shape and lifecycle.

Because the FK is gone, `apps/api/prisma/schema.prisma` no longer needs
`schemas = ["public", "auth"]`, the `multiSchema` preview feature, or the
~500-line `auth.*` model mirror that `prisma db pull` was forced to
maintain. The schema is now single-schema (`public` only) and the
gotrue-side churn that used to land in every `db:pull` no longer touches
this repo.

Coverage: `apps/api/src/integration/auth_user_delete_trigger.spec.ts`
asserts the trigger fires for both the Supabase admin API delete path
and a direct `DELETE FROM auth.users` via Prisma `$executeRaw` — the
second case protects against a future admin-API cleanup path that would
silently bypass the trigger.

Canonical doc: `docs/AUTH_AND_RLS.md` → "Auth → public sync triggers".

---

## 1. The problem in one paragraph

`prisma migrate dev` is the canonical Prisma workflow for iterating on a schema: edit `schema.prisma`, run the command, Prisma generates the migration SQL, applies it to a shadow DB for drift detection, then applies it to the dev DB and regenerates the client. **This workflow does not work on this repo.** It fails because migration `20260515052617_auth_integration` adds a cross-schema FK from `public.profiles.id` to `auth.users(id)`, and there is no Prisma configuration that simultaneously satisfies (a) Prisma's drift detector (which demands that every table in a declared schema be modeled) and (b) the reality that Supabase's gotrue service owns the `auth` schema and ships ~30 columns on `auth.users` that we have no business modeling.

The current workaround: **hand-write migration SQL and apply with `pnpm prisma:migrate:deploy`**. This works, but it gives up the convenience of `migrate dev` (auto-diff, drift detection, dev-DB sync). Every new schema change requires manually authoring the SQL.

This ADR exists so the next person who tries to "just fix migrate dev" can read the prior art, understand the constraints, and pick an approach without reinventing the failed attempts below.

---

## 2. What `migrate dev` does (and why we want it back)

Prisma's `migrate dev` workflow:

1. **Detect drift between schema.prisma and the dev DB.** It computes the SQL diff (target = schema.prisma, source = current dev DB state).
2. **Spin up a shadow DB** (a separate Postgres database). Reset it, replay every migration in `prisma/migrations/` in order. The shadow's resulting state is what Prisma considers the "expected" schema given the migration history.
3. **Compare shadow to dev DB.** If they differ, drift exists — either a manual change to dev that's not in any migration, or a migration that doesn't match `schema.prisma`. Bail out and tell the user.
4. **Generate a new migration** for the schema.prisma → dev diff if requested.
5. **Apply the new migration to the dev DB** and regenerate the Prisma client.

The value: schema changes become a 30-second loop instead of hand-authoring SQL each time. For a project with frequent schema iteration (Stage 1 Phase 2/3/4 will add multiple tables and columns), this matters.

The shadow DB is the critical mechanism. Without it, Prisma can't detect manual drift in the dev DB, and it can't replay-and-compare to validate the migration history.

---

## 3. The blocker: cross-schema FK to a Supabase-owned table

### 3.1 The FK in question

`apps/api/prisma/migrations/20260515052617_auth_integration/migration.sql`:

```sql
ALTER TABLE "profiles"
  ADD CONSTRAINT "profiles_id_fkey"
  FOREIGN KEY ("id") REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

`auth.users` is created by Supabase's gotrue service. It has roughly 30 columns (`id`, `email`, `encrypted_password`, `raw_user_meta_data`, `phone`, `confirmation_token`, …). The full surface is reproducible by inspecting any running Supabase instance:

```bash
docker exec supabase_db_aec-integrations psql -U postgres -d postgres -c "\d+ auth.users"
```

### 3.2 Prisma's drift detector is strict about cross-schema FKs

When Prisma's drift detector compares the shadow DB's schema to schema.prisma, it walks every FK. A FK whose target lives in a schema not declared in `datasource.schemas` triggers:

```
P4002: Cross schema references are only allowed when the target schema is
listed in the schemas property of your datasource. `public.profiles` points
to `auth.users` in constraint `profiles_id_fkey`. Please add `auth` to your
`schemas` property and run this command again.
```

This is non-negotiable. Adding `schemas = ["public", "auth"]` to the datasource block silences this error. But it triggers a worse problem.

### 3.3 Declaring `auth` in `schemas` is destructive

Once `auth` is in `schemas`:

- **Drift detection now compares the shadow's `auth.users` to the schema.prisma model of `auth.users`.** If the model has fewer columns than the live shadow auth.users, drift. If it has more, drift. There is no "this table is partly mine" mode.
- **The shadow reset wipes the `auth` schema.** Prisma considers `auth` to be one of "its" schemas and resets it on every `migrate dev` run, including any pre-bootstrapped `auth.users` stub.
- **`@@ignore` does NOT suppress drift detection.** Per Prisma docs, `@@ignore` only hides the model from the generated Prisma client. Drift detection still runs against the underlying table.

So the dilemma:

| Approach | Cross-schema FK error | Drift on auth.users |
|---|---|---|
| Don't declare auth in `schemas` | ❌ blocks at P4002 | n/a |
| Declare auth, don't model auth.users | ✅ FK OK | ❌ "table for model auth.users does not exist" (Prisma demands a model) |
| Declare auth, model auth.users with just `id` | ✅ FK OK | ❌ drift: live auth.users has ~30 columns, Prisma model has 1 |
| Declare auth, model auth.users with `id` + `@@ignore` | ✅ FK OK | ❌ drift: `@@ignore` doesn't suppress this |
| Declare auth, fully model gotrue's auth.users schema | ✅ FK OK | ⚠️ works but invasive (see §5.2) |

---

## 4. Approaches that have been tried (and failed)

All three approaches below were attempted in the AECI-48 work session. Each is documented so the next investigator doesn't waste time on dead ends.

### 4.1 Approach A: External shadow bootstrap (docker-exec)

**Idea:** Pre-create the shadow DB with an `auth.users` stub via a setup script. Schema.prisma stays single-schema; the FK error is avoided by some Prisma-side trick.

**Implementation:**
- `apps/api/prisma/shadow-bootstrap.sql` — `CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key);`
- `apps/api/scripts/setup-shadow-db.sh` — docker-execs into `supabase_db_aec-integrations`, creates a `postgres_shadow` database, applies the bootstrap.
- `package.json`: `prisma:migrate:dev` chains `db:shadow:setup` then `prisma migrate dev`.
- `schema.prisma`: add `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`.

**Why it failed:** P4002 fires before the shadow is even consulted, because Prisma's *introspection* of the live dev DB sees the cross-schema FK and rejects it. Adding `shadowDatabaseUrl` doesn't help — the FK validation runs against schema.prisma vs the *live dev DB*, not against the shadow.

**Lesson:** The error happens at the schema-validation stage, before any DB reset. The bootstrap approach can never escape it without also declaring `auth` in `schemas`.

### 4.2 Approach B: Pre-baseline migration that creates `auth.users` stub

**Idea:** Use `schemas = ["public", "auth"]` (so cross-schema FK validates) and add a Prisma-managed migration that creates `auth.users` from scratch. Then the shadow reset is fine — the migration recreates auth.users on every replay. `@@ignore` on the `AuthUser` model hides it from the client.

**Implementation:**
- New migration: `apps/api/prisma/migrations/20260515000000_init_auth_schema_stub/migration.sql` with `CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid primary key);` (timestamp deliberately sorts before the baseline so it runs first).
- `schema.prisma`: `schemas = ["public", "auth"]`, `@@schema("public")` on all 21 existing models, new `AuthUser` model with `@@map("users") @@ignore @@schema("auth")`.
- Mark the new migration as already applied on the local dev DB: `prisma migrate resolve --applied 20260515000000_init_auth_schema_stub`.

**What worked:** Shadow DB replay completes the new init migration and then the auth_integration migration successfully.

**Why it failed:** After replay, Prisma's drift check runs. It compares the shadow's `auth.users` (1 column: `id`) to the live dev DB's `auth.users` (~30 columns from gotrue). Drift detected. Prisma offers to "reset" — which would mean dropping the gotrue auth.users and replacing with the stub. Destroying gotrue's auth state isn't a viable price.

**The output that confirmed the failure:**

```
[*] Changed the `users` table
  [+] Added column `email`
  [+] Added column `encrypted_password`
  [+] Added column `raw_user_meta_data`
  ... ~25 more columns ...

We need to reset the following schemas: "auth, public" at "127.0.0.1:54322"
You may use prisma migrate reset to drop the development database.
```

**Lesson:** `@@ignore` does not suppress drift detection. The ignored model's table is still drift-checked. This is the central Prisma limitation blocking this approach.

### 4.3 Approach C: AuthUser stub with `@@ignore` only (no init migration)

**Idea:** Same as B but skip the init migration; rely on the shadow being pre-bootstrapped by the docker-exec script.

**Why it failed:** Combines the weaknesses of A and B. Prisma resets the `auth` schema on shadow because `auth` is in `schemas`, so the bootstrap-created `auth.users` gets dropped. The auth_integration replay then fails with "table for model auth.users does not exist." Same Catch-22.

---

## 5. Possible future approaches (untested)

Ranked from lowest-risk to most-invasive.

### 5.1 Use `prisma migrate diff` instead of `migrate dev`

`migrate diff` computes the SQL difference between two schema states without a shadow DB. The workflow becomes:

```bash
# Compare schema.prisma to live dev DB; output SQL diff
prisma migrate diff \
  --from-url "$DIRECT_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > new-migration.sql

# Inspect, edit, place into prisma/migrations/<timestamp>_<name>/migration.sql
# Then apply via migrate deploy
```

**Pros:** No shadow DB, no `schemas` config, no AuthUser model. Sidesteps the entire blocker.
**Cons:** Two-step (diff → review → place → deploy) instead of one. Still requires hand-placement of the SQL file. No automatic Prisma client regen between steps. But significantly less manual than today's "write SQL from scratch."

**Recommendation:** This is the most pragmatic improvement. Worth wiring up as `pnpm prisma:migrate:diff` even if it doesn't restore full `migrate dev` behavior.

### 5.2 Fully model gotrue's `auth.users` schema in Prisma

Approach B but with a complete `AuthUser` model matching every gotrue column.

**Pros:** Resolves drift cleanly. `migrate dev` would actually work end-to-end.
**Cons:**
- Requires reverse-engineering gotrue's `auth.users` schema (~30 columns plus indexes, triggers, RLS policies, etc.) into `schema.prisma`.
- Gotrue evolves: every Supabase release that touches `auth.users` (column additions, index changes) would break drift detection until we update the Prisma model. Maintenance burden.
- Misleading: the Prisma client would expose `prisma.authUser.*` accessors that we should *never* call. Engineering convention has to enforce "don't touch this" — easy to forget.
- Some gotrue columns (`raw_user_meta_data jsonb`, `confirmation_token`, etc.) require Prisma's `Unsupported(...)` type or have constraints Prisma can't model.

**Recommendation:** Only consider if `migrate dev` is so important that the maintenance burden is justified. For Stage 1 it probably isn't.

### 5.3 Drop the cross-schema FK; replace with trigger-based cleanup

Today, the FK `profiles.id → auth.users(id) ON DELETE CASCADE` exists to keep `profiles` clean when a Supabase Auth user is deleted. Replace it with a trigger on `auth.users` DELETE that deletes the corresponding `profiles` row.

**Pros:** No cross-schema FK → no P4002, no need to declare `auth` in `schemas`, no AuthUser model needed. `migrate dev` works trivially.
**Cons:**
- Architectural change. Need to vet that DELETE trigger semantics match the FK CASCADE semantics across all gotrue user-deletion paths (admin API, self-service, etc.).
- Loses the FK's referential integrity *insert-time* guarantee: with a FK, you can't insert a profile row referencing a non-existent auth user. With a trigger, you can. (Mitigation: the existing `handle_new_user()` trigger on auth.users INSERT means profiles are always created server-side from a real auth user, so insert-time-orphan profiles shouldn't occur.)
- Schema audit harder: no static FK to grep for in docs/diagrams.

**Recommendation:** Worth a focused investigation. The FK is doing a single job (cascading delete) that a trigger can do equally well, and the architectural cost of giving up the FK is small. **This is probably the cleanest long-term path.**

### 5.4 Custom shadow DB pre-populated with full gotrue schema

Run a separate Postgres container (or a logical DB) that has gotrue's schema dump pre-applied. Point `shadowDatabaseUrl` at it. Each `migrate dev` reset wipes only `public`, leaving the full gotrue auth schema intact.

**Pros:** No changes to schema.prisma; `migrate dev` would work.
**Cons:**
- Requires maintaining a `gotrue-schema-dump.sql` file in the repo, refreshed whenever Supabase ships a gotrue update.
- Bootstrap script complexity: ensure the shadow DB has the exact gotrue schema, not just a stub.
- Prisma might still try to "reset" auth schema if it's declared in `schemas`. Need to leave `auth` *out* of `schemas`, which brings back the P4002 cross-schema FK error.

**Recommendation:** Not promising. Hits the same Catch-22 from §3.3 unless paired with §5.3.

### 5.5 Wait for official Prisma + Supabase integration

Prisma and Supabase are both aware of this friction. There are open issues on both sides discussing better support for externally-managed schemas.

**Recommendation:** Track but don't depend on. Prisma's `@@ignore` semantics would need to extend to drift detection for this to "just work," which is a non-trivial change.

---

## 6. Reproducing the current state

1. **Confirm `migrate dev` fails:**
   ```bash
   cd apps/api
   pnpm prisma:migrate:dev
   ```
   Expected: P3006 / P4002 / P1014 error chain depending on what schemas config you have. As of this commit, the schema is back to the "no multiSchema" state and the error is the original `P3006: shadow database` failure.

2. **Confirm `migrate deploy` works:**
   ```bash
   pnpm prisma:migrate:deploy
   ```
   Expected: clean success against the live local DB.

3. **Confirm `db:apply-rls` works without psql install:**
   ```bash
   pnpm db:apply-rls
   ```
   Expected: long stream of `DROP POLICY / CREATE POLICY / GRANT` lines, all successful.

4. **Confirm the AECI-48 integration test works (proves the deploy path produces a correct DB):**
   ```bash
   SUPABASE_URL='http://127.0.0.1:54321' \
   SUPABASE_ANON_KEY='<see kong config>' \
   SUPABASE_TEST_USER_JWT='<same>' \
     pnpm exec vitest run --config vitest.integration.config.ts
   ```
   Expected: 8/8 pass.

---

## 7. Recommended next steps for whoever picks this up

In priority order:

1. **Investigate §5.3 (drop FK, use DELETE trigger).** This is likely the cleanest fix and the one with the smallest blast radius on the rest of the codebase. Confirm:
   - All gotrue user-delete paths fire the BEFORE/AFTER DELETE trigger we'd add.
   - No other migrations or code paths assume the FK's existence.
   - The audit-log story still works (we want to capture user deletion as an event).
2. **If §5.3 is rejected, wire up §5.1 (`migrate diff`).** Even without full `migrate dev`, a `migrate diff` script materially improves the migration-authoring loop.
3. **Don't pursue §5.2 (full gotrue modeling) unless the team explicitly decides the maintenance cost is worth it.** It's an attractive nuisance: looks like a clean fix, but the long tail of gotrue version drift is painful.
4. **Update `docs/AUTH_AND_RLS.md` §11** with the final decision when made. Remove the "Why prisma migrate dev is unsupported" section if the problem is resolved; tighten it if the workaround changes.

---

## 8. References

- The current workaround documentation: `docs/AUTH_AND_RLS.md` §11 ("Why `prisma migrate dev` is unsupported on this repo").
- The blocking migration: `apps/api/prisma/migrations/20260515052617_auth_integration/migration.sql`.
- The schema.prisma `NOTE:` comment in the `datasource db { ... }` block.
- Prisma docs:
  - [`@@ignore`](https://www.prisma.io/docs/orm/prisma-schema/data-model/models#ignore) — semantics around client vs migration behavior.
  - [`multiSchema`](https://www.prisma.io/docs/orm/prisma-schema/data-model/multi-schema) — schemas config, now GA.
  - [Shadow database](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database) — what `migrate dev` does with it.
- Supabase + Prisma known issues: search GitHub for "supabase prisma auth.users migrate dev" — both communities have multi-year discussions, no clean resolution.
