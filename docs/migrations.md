# Database migrations

How to write, test, and ship a schema change in this repo.

> **✅ The application database is now Cloudflare D1 + Drizzle (ADR 0016 / AECI-248).**
> The Prisma→Drizzle query rewrite (AECI-253) is complete — the Worker reads and
> writes **D1** through `getDb(env)` (`apps/api/src/db/client.ts`), the schema is
> authored in **Drizzle** (`apps/api/src/db/schema.ts`), and migrations are applied
> with `wrangler d1 migrations apply`. **[§0](#0-d1--drizzle-the-target-workflow) is
> the only workflow for the app database — start there.**
>
> **Everything below §0 (§§1–10) is the legacy Supabase-CLI workflow, retained as
> Supabase-Auth-project history.** It no longer governs the app tables (vendors,
> products, reviews, …), nor — since the AECI-257 landing cut-over — the lead-capture
> tables (`feedback`, `mailing_list`); all of those are now D1 tables written via the
> API Worker. **Prisma is fully gone (AECI-278):** no `@prisma/client`, no `prisma`
> CLI, no `apps/api/prisma/schema.prisma`, no `prisma generate` in CI, no Postgres
> `schema.prisma` drift gate. **`supabase/migrations/` is now a single auth-only
> baseline** (`20260626000000_auth_only_baseline.sql` — a minimal `public.profiles`
> plus the `handle_new_user` / `handle_auth_user_delete` triggers on `auth.users`);
> the original 15 migrations (the full pre-D1 app schema, GRANT/RLS surface, landing
> baseline, auth integration) are **archived for history under
> `supabase/archive/migrations/`**. Reconciling the live shared Auth project's
> migration history with this baseline (`supabase migration repair`) is a manual
> decommission step the operator runs.

The legacy migration system below is **Supabase CLI**, now scoped to the Supabase Auth project. Migration files live in `supabase/migrations/` as numbered SQL files; the live one is the auth-only baseline. The app database's drift gate is the D1/Drizzle check (`drift-check.yml`, AECI-264) described in [§0](#0-d1--drizzle-the-target-workflow); there is no longer a Postgres `schema.prisma` drift gate.

This document is the source of truth for the workflow. The constraints in [`CLAUDE.md`](../CLAUDE.md) ("Constraints that aren't negotiable") incorporate the rules below by reference.

---

## 0. D1 + Drizzle: the target workflow

The schema source of truth is `apps/api/src/db/schema.ts` (Drizzle SQLite). The
flow is **generate → apply → seed**, all from `apps/api/`:

```bash
# 1. Edit apps/api/src/db/schema.ts, then generate migration SQL into apps/api/migrations/
pnpm --filter @aeci/api db:generate          # drizzle-kit generate

# 2. Apply to the LOCAL D1 (per-workspace SQLite in .wrangler/state — no shared DB)
pnpm --filter @aeci/api db:migrate:local     # wrangler d1 migrations apply aeci-app-preview --local

# 3. Seed local data (idempotent): taxonomy reference data + a sample catalog
pnpm --filter @aeci/api db:seed:local

# Convenience: migrate + seed in one step
pnpm --filter @aeci/api db:setup:local
```

Rules:

- **Drizzle generates, `wrangler d1 migrations apply` applies.** Never
  `drizzle-kit migrate`/`push` — that mirrors the old "CLI owns apply" split.
  Generated SQL is committed under `apps/api/migrations/` (flat layout = wrangler's
  default `migrations_dir`, so no `migrations_pattern` is needed).
- **Reference data** (taxonomy, ADR 0008) lives in `apps/api/seed/taxonomy.sql`
  as idempotent `INSERT … ON CONFLICT(slug) DO UPDATE` with deterministic
  UUIDv5 ids. The Stage 1.5 `data_object` vocabulary follows the same pattern in
  `apps/api/seed/data-objects.sql` (AECI-293; source of truth
  `docs/DATA_OBJECT_VOCABULARY.md`), as does the `trade` vocabulary in
  `apps/api/seed/trades.sql` (AECI-540; source of truth
  `docs/TRADES_VOCABULARY.md`, whose §8 states the UUIDv5 namespace verbatim).
  The local catalog fixture is
  `apps/api/seed/catalog.sql` (local-dev only; staging/prod re-promote from
  Airtable via `POST /api/promote`).
- **Per-env apply** (staging/demo/production) is wired into CI in Phase 5
  (AECI-256): the deploy lanes (`deploy.yml`, `promote-to-demo.yml`,
  `promote-to-prod.yml`) run `scripts/d1-apply-migrations.sh <db> <env>`, which
  applies `wrangler d1 migrations apply aeci-app-<env> --env <env> --remote` and
  reconciles the three reference-data seeds. The helper **retries each remote D1
  command** on a transient Cloudflare D1 API internal error (`[code: 7500]`) —
  a single such blip otherwise aborts the whole deploy (seen on promote-to-demo
  run 28671935011); retrying is safe because every command is idempotent
  (`migrations apply` is a tracked no-op once applied; all three seeds are UPSERTs on
  deterministic UUIDv5 ids).
- **No RLS / GRANTs / triggers.** D1/SQLite has none; authorization is app-layer
  (ADR 0016 §4, `docs/AUTH_AND_RLS.md`), and `updated_at` is refreshed app-side
  (Drizzle `$onUpdate`), not by a DB trigger.
- **Drift is CI-gated.** `.github/workflows/drift-check.yml` (AECI-264) fires on any PR
  touching `apps/api/src/db/schema.ts`, `apps/api/drizzle.config.ts`, or
  `apps/api/migrations/**`. It runs `pnpm --filter @aeci/api db:generate` and fails if that
  leaves the tree dirty under `apps/api/migrations/` — i.e. you edited `schema.ts` but forgot
  to generate + commit the migration. Fix by running `db:generate` and committing the new
  `apps/api/migrations/*` (including `meta/`).
- **Remote `aeci-app-preview` is NOT migrated by CI.** The per-env apply above covers staging,
  demo and production only, but PR previews bind the shared `env.preview` D1 — so it drifts
  until someone applies by hand:
  `cd apps/api && pnpm exec wrangler d1 migrations apply aeci-app-preview --env preview --remote`.
  Do it as part of any PR that adds a migration. (`db:migrate:local` also names
  `aeci-app-preview`, but that is the *local* SQLite copy — a different database.)

#### ⚠️ When drizzle-kit wants to recreate a table, hand-author the ALTERs instead

SQLite cannot `ALTER` a CHECK constraint, so drizzle-kit answers **any check-constraint change**
(and PK/notnull/type changes, and FKs added to existing columns) with a full **table recreate**:

```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_claims` ( … );
INSERT INTO `__new_claims`(…) SELECT … FROM `claims`;
DROP TABLE `claims`;
ALTER TABLE `__new_claims` RENAME TO `claims`;
PRAGMA foreign_keys=ON;
```

**Never ship that on D1.** Three independent reasons, seen for real on AECI-603:

1. When the recreate accompanies new columns, the generated `INSERT … SELECT` lists the **new**
   column names but reads from the **old** table — the statement errors out immediately.
2. **D1 does not support `PRAGMA foreign_keys = on|off`** (only `defer_foreign_keys`), so the
   guard around the drop does nothing there.
3. With foreign keys enforced, `DROP TABLE` performs an implicit `DELETE FROM` and **fires
   `ON DELETE CASCADE` on every child row**. Dropping `claims` would have deleted every
   `attestations` row in the database.

Also note: `ALTER TABLE … ADD COLUMN` with a Drizzle `.references()` emits a bare
`REFERENCES <table>(id)` and **silently drops the `ON DELETE` clause**. This one has now bitten
twice (AECI-603, AECI-607) and it is the quieter of the two failures: the migration *applies
cleanly*, and the wrong behaviour only shows up the first time someone deletes a parent row. Treat
any generated `ADD COLUMN … REFERENCES` as wrong by default, and **pin the intended behaviour with
a test** — `apps/api/src/test/d1.spec.ts` runs the real migration files, so a case asserting the
child column goes NULL (or cascades, or is rejected) is what stops a future regeneration from
quietly reverting it.

**The workflow when you hit this:** run `db:generate` as normal (you want its `meta/` snapshot and
journal entry), then **replace the SQL body** with equivalent additive statements — SQLite accepts
a column-level CHECK and a full FK clause on `ADD COLUMN`:

```sql
ALTER TABLE `claims` ADD `origin` text DEFAULT 'aeci' NOT NULL CONSTRAINT "claims_origin_check" CHECK("origin" IN ('aeci', 'vendor'));
ALTER TABLE `claims` ADD `created_by_vendor_id` text REFERENCES vendors(id) ON DELETE SET NULL;
```

This does not break the drift gate: drizzle-kit diffs `schema.ts` against
`meta/NNNN_snapshot.json`, never the database, so leaving the generated snapshot untouched keeps
`db:generate` a no-op. **Verify by re-running it and confirming `git status --porcelain` is clean**,
and leave a header comment in the migration saying it is hand-authored and why
(`0016_lyrical_leper_queen.sql` and `0017_slim_iron_lad.sql` are the references).
`0003_gray_eternity.sql` is the lighter precedent — a hand-appended backfill after the generated
statement.

#### Renumbering a migration (parallel epic branches)

Two long-lived epic branches that each add a migration will each generate the **same** next index,
because drizzle-kit numbers from the journal it can see. `aeci-514` and `aeci-515` both produced a
`0006_*.sql`; they collide at the `stage-2` merge and the second one in has to move. Renumbering is
three coordinated renames:

1. `migrations/NNNN_<name>.sql` → `MMMM_<name>.sql`
2. `migrations/meta/NNNN_snapshot.json` → `meta/MMMM_snapshot.json`
3. the matching `_journal.json` entry's `idx` **and** `tag`

**Leaving a gap is safe**, and is worth doing pre-emptively when you know a collision is coming —
AECI-607 shipped as `0008` to leave `0007` free for exactly that reconciliation. Verified: wrangler
applies unapplied migrations in filename order (gaps are irrelevant; it tracks applied names in
`d1_migrations`), the test harness sorts `*.sql`, and drizzle-kit reads `_journal.json` rather than
the file sequence, so `db:generate` still reports "No schema changes". Keep `_journal.json` in
drizzle's exact format — no trailing newline; it is `.prettierignore`d for that reason.

##### ⚠️ The three-rename recipe only holds for a SAME-GENERATION collision

It assumes both migrations were generated against the **same** parent snapshot — two branches both
sitting at `0006` off a shared `0005`. Then the snapshot content is already correct and only its
*name* is wrong.

**Across a multi-migration gap it is wrong, and silently so.** A drizzle snapshot is the FULL schema
state after its migration, so an epic's `0006_snapshot.json` describes "`0005` + this epic's change"
— it knows nothing about the ten migrations the other branch added meanwhile. Rename it to `0016`
and the newest snapshot in the chain is missing half the schema; the next `db:generate` diffs
`schema.ts` against it, decides every one of those tables is new, and `drift-check.yml` fails. The
files also *collide by name* (`meta/0006_snapshot.json` exists on both sides), so this shows up as a
real git conflict rather than a clean rename.

**What to do instead — regenerate the snapshot, keep the body.** This is the §0 hand-authored-body
workflow above, run once per migration being renumbered. AECI-619 did exactly this for
`0006`→`0016` and `0008`→`0017`:

1. Resolve `schema.ts` to the merged union, and stash a copy.
2. Delete the epic's `NNNN_*.sql` + `meta/NNNN_snapshot.json`; take the other branch's `meta/`
   (snapshots + `_journal.json`) wholesale.
3. Edit `schema.ts` down to the state *after the first* renumbered migration only (reverse-apply the
   later migration's schema commit: `git show <sha> -- apps/api/src/db/schema.ts | git apply -R`).
4. `pnpm --filter @aeci/api db:generate`. **Keep its `meta/` snapshot and journal entry; discard the
   SQL body it wrote** and drop the original hand-authored body in its place. Rename the file to
   preserve the original slug and set the journal entry's `tag` to match, so as-built notes and
   `d1_migrations` stay legible.
5. Restore the full `schema.ts` and repeat for the second migration.
6. Re-run `db:generate` and confirm it reports "No schema changes" with nothing unstaged.

**Renumber before the migration is applied anywhere remote**; once a tier has recorded the old
filename, renaming it makes the migration re-run.

##### Repairing a tier that already recorded the old filename

If you are past that point (AECI-619 was — remote `aeci-app-preview` had applied
`0006_lyrical_leper_queen.sql` on 2026-08-14), do **not** let `migrations apply` re-run the renamed
file: the `ALTER`s would hit existing columns and error. Rename the ledger rows instead, then apply:

```bash
cd apps/api
# 1. Point the recorded names at the new filenames. Same migration, same applied_at.
npx wrangler d1 execute aeci-app-preview --env preview --remote --command \
  "UPDATE d1_migrations SET name='0016_lyrical_leper_queen.sql' WHERE name='0006_lyrical_leper_queen.sql'"
npx wrangler d1 execute aeci-app-preview --env preview --remote --command \
  "UPDATE d1_migrations SET name='0017_slim_iron_lad.sql' WHERE name='0008_slim_iron_lad.sql'"

# 2. Now only genuinely-unapplied migrations run.
npx wrangler d1 migrations apply aeci-app-preview --env preview --remote

# 3. Confirm the ledger matches the files on disk.
npx wrangler d1 execute aeci-app-preview --env preview --remote --command \
  "SELECT name FROM d1_migrations ORDER BY id"
```

Wrangler compares recorded **names** against the `*.sql` filenames, so ordering in `d1_migrations`
is cosmetic — a migration applied out of sequence (the epic's, before the other branch's back-fill)
is fine as long as the two sets do not touch the same objects. Check that before you apply: for
AECI-619, `main`'s `0010`–`0015` touched `promote_jobs` / `metrics_daily` / `job_runs` /
`page_views` / `products.promoted_at` / `feedback` / `mailing_list` and never `claims` or
`attestations`, so the inversion was inert.

##### AECI-750 — the second, larger renumber (`0016`–`0022` → `0021`–`0027`)

The `main → stage-2` reconcile hit the same collision at **seven** migrations instead of two.
`main` had independently taken `0016`–`0020` and **those are applied in production**, so `main`
keeps its numbers and `stage-2`'s seven move up:

| was (`stage-2`) | now | | was (`stage-2`) | now |
|---|---|---|---|---|
| `0016_lyrical_leper_queen` | `0021` | | `0020_sad_the_professor` | `0025` |
| `0017_slim_iron_lad` | `0022` | | `0021_overconfident_selene` | `0026` |
| `0018_chilly_joseph` | `0023` | | `0022_powerful_killraven` | `0027` |
| `0019_easy_sandman` | `0024` | | | |

**The step-3 reverse-apply loop was not needed, and here is the test for when you can skip it.**
That loop exists to reconstruct each intermediate schema state. It is only skippable when the two
migration sets touch **disjoint objects**, which was checkable directly: `main`'s `0016`–`0020` add
seven columns and two indexes to `page_views` and create `asn_registry`, and **nothing else**;
`stage-2`'s seven touch `claims` / `attestations` / `integrations` / `connector_*` / `vendor_*` /
`profiles` / `products` and — verified against every snapshot — never touched `page_views` after
`0015`. So each `stage-2` snapshot could be recomposed by grafting `main`'s `page_views` and
`asn_registry` table definitions onto it and re-chaining `id`/`prevId`, with no schema-state
replay. Confirm the graft the same way as always: `db:generate` must report *"No schema changes"*.

Two things this also fixed for free: `meta/0006_snapshot.json` (dropped by `8ea629ce`, leaving
`0007_snapshot.json` pointing at a `prevId` with no file) came back with `main`'s `meta/`, and the
journal's seven re-stamped `when` values restored monotonicity — the originals interleave, because
four of `stage-2`'s seven predate `main`'s `0016`.

**Verify the bodies, not just the gate.** All seven SQL bodies are byte-identical to their
originals apart from an appended renumber note; the check that matters is that the *executable*
statements hash identically with comments stripped:

```bash
git show origin/stage-2:apps/api/migrations/0022_powerful_killraven.sql \
  | grep -v '^--' | shasum -a256
grep -v '^--' apps/api/migrations/0027_powerful_killraven.sql | shasum -a256
```

**PENDING — the two hand-applied tiers still record the old names.** `aeci-app-stage2` and remote
`aeci-app-preview` are not CI-migrated, so nothing has corrected them. **No data is at risk**: the
next `d1-apply-migrations.sh` simply fails, loudly, on the first renamed file rather than doing
anything destructive. Census first, then rewrite — **descending**, so no intermediate name collides
with one still in use (`0021`/`0022` are both an old name *and* a new name in this set):

```bash
cd apps/api
npx wrangler d1 execute aeci-app-stage2 --env stage2 --remote --command \
  "SELECT name FROM d1_migrations ORDER BY id"

for pair in \
  0022_powerful_killraven:0027_powerful_killraven \
  0021_overconfident_selene:0026_overconfident_selene \
  0020_sad_the_professor:0025_sad_the_professor \
  0019_easy_sandman:0024_easy_sandman \
  0018_chilly_joseph:0023_chilly_joseph \
  0017_slim_iron_lad:0022_slim_iron_lad \
  0016_lyrical_leper_queen:0021_lyrical_leper_queen ; do
  npx wrangler d1 execute aeci-app-stage2 --env stage2 --remote --command \
    "UPDATE d1_migrations SET name='${pair##*:}.sql' WHERE name='${pair%%:*}.sql'"
done

npx wrangler d1 migrations apply aeci-app-stage2 --env stage2 --remote
npx wrangler d1 execute aeci-app-stage2 --env stage2 --remote --command \
  "SELECT name FROM d1_migrations ORDER BY id"
```

Repeat for remote `aeci-app-preview` (`--env preview`), whose census may differ — it already
carries the AECI-619 rename. **staging / demo / production need nothing**: they only ever recorded
`main`'s `0016`–`0020`, whose numbers are unchanged. The out-of-order apply that follows (stage-2's
seven were applied before `main`'s back-fill) is inert by the same disjoint-objects check above.

##### Reserved numbers

**Settled — nothing is reserved.** `aeci-515` (Paid Tiers) generated `vendor_entitlements`
(AECI-609) as `0006_easy_sandman.sql`, colliding with `main`'s `0006_crazy_lockheed.sql`. AECI-622
first renumbered it to `0018`, which **also** collided once the AECI-514 epic landed (`0016`/`0017`
plus `0018_chilly_joseph`). It was then **`0019_easy_sandman.sql`**, renumbered at the
`stage-2 → aeci-515` merge by the regenerate-the-snapshot procedure above — and is now
**`0024_easy_sandman.sql`**, renumbered a third time by AECI-750.

That is twice this line went stale while being read as authoritative, which is the point worth
keeping: **check `apps/api/migrations/` rather than trusting a number written in prose.** The
regenerated body was verified byte-identical to the hand-authored original and emitted no
destructive statements — the check that matters, given the generator has previously re-emitted
`DROP TABLE claims` when a snapshot chain was renamed rather than regenerated.

### Read replication (D1 Sessions API — AECI-250)

The Worker reads/writes D1 through the **Sessions API**: `getDb(env, opts?)`
(`apps/api/src/db/client.ts`) wraps `env.DB.withSession(anchor)`. Reads use the
`'first-unconstrained'` anchor (served by the nearest replica — the read-latency
win); write handlers anchor `'first-primary'` and round-trip the `x-d1-bookmark`
header (inbound via `writeDb(c, dbFor)`, outbound via `bookmark-middleware.ts`) so
read-your-writes holds. This is **API-Worker-internal** — no schema/migration
change and no `wrangler.jsonc` change.

- **Enabling the win is an ops step, not code.** Read replication is turned on
  **per-database** in the Cloudflare dashboard (D1 → *your db* → Settings → Enable
  Read Replication) or the REST API (`read_replication: {"mode": "auto"}`). Enable
  it on the **staging + production** D1s; the code is inert-safe before that
  (`withSession` serves from primary when no replicas exist).
- **Local dev / tests are single-DB.** `wrangler dev`'s local SQLite and the
  in-memory test harness have no `withSession`, so `getDb` falls back to the plain
  binding (`getBookmark()` → `null`); read-your-writes is automatic there. The
  perf win is **prod-only** and appears only after the per-database flip above.

---

> **⚠️ Legacy — Supabase-CLI workflow (Supabase Auth project only).**
> Sections §§1–10 below predate the D1 cut-over. They **do not apply to the app
> database** (now D1 — see [§0](#0-d1--drizzle-the-target-workflow)), nor to the
> `feedback` / `mailing_list` lead-capture tables (moved to D1 in AECI-257), and
> Prisma is no longer involved anywhere (AECI-278). They are retained only as a
> record of the Supabase **Auth** project's migration history; the live
> `supabase/migrations/` is the single auth-only baseline, with the originals archived
> under `supabase/archive/migrations/`.

## 1. When to write a migration

Write a migration when any of these change in Postgres:

- A table, column, index, constraint, trigger, or sequence.
- A function, view, or extension.
- An RLS policy, PostgREST GRANT, or `is_admin()`/`is_active_user()`-style helper. As of AECI-87 the whole authorization surface lives in numbered migrations (see [§5](#5-rls-and-the-public-schema)); there is no separate apply step.
- A row in a config-shaped table that staging and production must both have (rare). Taxonomy vocabulary → the code-managed reference file `apps/api/seed/taxonomy.sql` (ADR 0008), applied to D1 via `wrangler d1 execute`, not a migration; other curator content → Airtable sync (`docs/DATABASE_SCHEMA.md` §13).

**Don't** write a migration for:

- Local test fixtures or seed data — those are the D1 seed SQL under `apps/api/seed/` (applied locally via `pnpm db:seed:local`). Cross-environment reference data (e.g. the taxonomy vocabulary) is `apps/api/seed/taxonomy.sql`, which *is* applied to every environment via `wrangler d1 execute` (ADR 0008).
- One-off data backfills — use a script under `apps/api/scripts/` and run it explicitly per environment.
- Anything Airtable owns (curator-managed content; vendors, products, integrations, reviews — see `docs/DATABASE_SCHEMA.md` §13). *(Taxonomy is no longer in this set — it's code-managed reference data per ADR 0008.)*

---

## 2. File naming

Migration files are named `YYYYMMDDHHMMSS_short_description.sql`. Generate the timestamp via the CLI rather than hand-typing it:

```bash
pnpm db:new add_vendor_logo_column
```

This produces `supabase/migrations/<utc-timestamp>_add_vendor_logo_column.sql` (empty). The CLI uses UTC. Don't rename the file after creation — the timestamp is the migration's identity in the `supabase_migrations.schema_migrations` history table.

`short_description` is snake_case, ≤6 words, describes the *what* (`add_vendor_logo_column`, `drop_unused_reviews_index`), not the why (the why belongs in a comment block at the top of the file).

---

## 3. Authoring rules

These constraints are non-negotiable.

### 3.1 Forward-only

No `down.sql`. No rollback migrations. If a migration is wrong:

- Catch it in the PR review.
- If it landed in staging and broke something, write a *new* migration that fixes it forward.
- Never edit a migration after it's been merged.

### 3.2 Backward-compatible during expand/contract

If the live API code can't tolerate the schema after the migration applies but before the new code deploys (and CI applies migrations *before* code deploys — see `docs/CICD_PLAN.md` §5), break the change into phases:

1. **Expand** migration — add the new column / table / column nullable.
2. Code change — start reading the new shape while still tolerating the old.
3. **Backfill** migration or script (if needed).
4. Code change — switch writes to the new shape.
5. **Contract** migration — drop the old column / constraint.

Each migration must leave the DB in a state the previously-deployed Worker code can still run against.

### 3.3 Destructive changes require explicit approval

`DROP TABLE`, `DROP COLUMN`, type-narrowing (`varchar(255)` → `varchar(64)`), `ADD COLUMN ... NOT NULL` without a backfill, and any change that loses data without a migration path — these require explicit approval in the issue **before** you write the SQL. Not in the PR. In the issue.

### 3.3a Dropping a column on SQLite/D1 may force a table recreate

SQLite refuses `ALTER TABLE … DROP COLUMN` when the column carries an **index** or appears in a **`FOREIGN KEY`** clause. drizzle-kit handles it by emitting a `__new_<table>` copy-and-rename instead of a `DROP COLUMN`, which on a large table is a full row copy — D1 bills rows *written*, and there is no undo.

Three rules when you hit this, all learned from `migrations/0014_careful_absorbing_man.sql` (AECI-585, the first table recreate in this repo — every `ALTER` before it is an `ADD`):

1. **Replace the pragma.** drizzle-kit wraps the swap in `PRAGMA foreign_keys=OFF` / `=ON`. That is **not** the lever D1 supports — [D1's migrations docs](https://developers.cloudflare.com/d1/reference/migrations/) specify `PRAGMA defer_foreign_keys = true`, which holds for the surrounding transaction and resets on commit (so it needs no matching re-enable). Regenerating the file reintroduces the wrong pragma; re-apply the edit and say so in a comment at the top of the migration.
2. **Check the copy lists the PK explicitly.** For an `AUTOINCREMENT` PK, an implicit copy would reassign ids. Anything paginating on `(created_at, id)` then repeats or skips rows.
3. **Verify against non-empty data, not just a fresh DB.** Apply to a seeded local D1 and assert the row count and `MAX(id)` before and after. A recreate that "applies cleanly" to an empty table proves nothing.

Splitting the work into two migrations — one additive (`ADD COLUMN`s, trivially safe) and one destructive (the recreate) — also keeps drizzle-kit from prompting for add-vs-rename disambiguation, which needs a TTY it does not have under `pnpm`.

### 3.4 Idempotency where cheap

Prefer `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS ... CREATE POLICY ...`, `CREATE OR REPLACE FUNCTION`. Postgres migrations don't *have* to be idempotent (the migration system tracks what ran), but idempotent SQL is easier to recover from when something goes wrong mid-apply.

### 3.5 (removed) Keep `schema.prisma` in sync

No longer applies. Prisma was removed entirely (AECI-278): there is no `apps/api/prisma/schema.prisma`, no `pnpm db:pull`, and no `docs/prisma.md`. The app database's schema source of truth is the Drizzle schema (`apps/api/src/db/schema.ts`), with drift gated by `drift-check.yml` — see [§0](#0-d1--drizzle-the-target-workflow).

---

## 4. Local test loop (auth-only Supabase project)

The **app-DB** local loop is §0 (D1 + Drizzle). This section covers the **auth-only**
Supabase project (`supabase/migrations/`) — it holds no application tables (those live
in D1, ADR 0016); its local stack issues real GoTrue tokens + a JWKS endpoint for the
auth integration spec.

```bash
# One-time: start local stack (Postgres + GoTrue + PostgREST + Storage + Studio)
pnpm db:start

# Create a new auth migration file
pnpm db:new add_auth_profile_trigger

# Open the new file under supabase/migrations/, write the SQL.

# Reset local DB to a clean state, apply ALL auth migrations + seed.sql
# (the auth-only baseline carries no GRANT/RLS surface — see §5)
pnpm db:reset

# Smoke-test the auth/JWKS integration spec against the now-baselined local stack
pnpm --filter @aeci/api test:integration
```

A migration is "ready" when `pnpm db:reset` applies it without errors *from scratch* (not just on top of the previous state), and the integration suite still passes.

---

## 5. RLS and the `public` schema

As of AECI-87, the **entire** PostgREST authorization surface lives in
`supabase/migrations/`, so `supabase db push` / `db reset` apply it to every
environment — there is no separate apply step:

- **`20260525064254_capture_rls_auto_enable.sql`** owns the `ensure_rls` event trigger and `public.rls_auto_enable()` function — they make every newly-created public table RLS-enabled by default.
- **`20260602051513_rls_grants_and_policies.sql`** owns the policy bodies, the PostgREST GRANTs, and the `public.is_admin()` / `public.is_active_user()` helpers. It is idempotent (`DROP POLICY IF EXISTS` + `CREATE POLICY`, `CREATE OR REPLACE FUNCTION`, idempotent REVOKE/GRANT).

This GRANT/RLS surface, and its `scripts/verify-rls.sql` verifier, were **removed with the
Postgres-app-DB decommission (AECI-278)** — the app tables now live in D1, which has no
PostgREST/GRANT/RLS, and the GRANT/RLS migrations were archived under
`supabase/archive/migrations/`. The historical three-layer model is in `docs/AUTH_AND_RLS.md`
§1 (§§5–6 there are flagged historical). App-table authorization is now app-layer only
(ADR 0016 §4).

---

## 6. Commit + PR rules

Single PR contains:

- The migration file(s) under `supabase/migrations/` (auth-only, for the Supabase Auth project).
- Any corresponding update to `docs/DATABASE_SCHEMA.md` (the source of truth for table inventory and column intent).

(The former GRANT/RLS-migration and `schema.prisma`-sync requirements no longer apply — Postgres GRANT/RLS and Prisma were removed in AECI-278.)

PR review verifies these are all aligned. CI applies the migration to staging at merge-to-main; production application requires a separate approval (see `docs/CICD_PLAN.md` §5 — wiring deferred to AECI-71).

---

## 7. What does not belong in a migration

- **Seed data**: for the app DB, the local D1 seed SQL under `apps/api/seed/` (applied via `pnpm db:seed:local`). (`supabase/seed.sql` is now Supabase-Auth-project-local only.)
- **Reference data** (applied to *all* environments): the taxonomy vocabulary lives in `apps/api/seed/taxonomy.sql`, the Stage 1.5 `data_object` vocabulary in `apps/api/seed/data-objects.sql`, and the `trade` vocabulary in `apps/api/seed/trades.sql` (all idempotent upserts), applied to D1 via `wrangler d1 execute` — locally via `pnpm db:seed:taxonomy:local` / `pnpm db:seed:data-objects:local` / `pnpm db:seed:trades:local`, in deploy/promote via the matching `wrangler d1 execute … --file=seed/<name>.sql` steps in `scripts/d1-apply-migrations.sh`. See ADR 0008.
- **Curator-managed data**: vendors, products, integrations, reviews come in via `POST /api/promote` (`docs/DATABASE_SCHEMA.md` §13).
- **One-off backfills**: write a script (`apps/api/scripts/<name>.ts`), run it explicitly per environment. Keep migrations declarative.
- **RLS policies**: see §5.

---

## 8. CI / CD

For the **app database (D1)** this is the live story, not this legacy section: CI applies migrations with `wrangler d1 migrations apply` on merge to `main` (staging) and on prod approval (production) — see [§0](#0-d1--drizzle-the-target-workflow) and `docs/CICD_PLAN.md` §5.

The legacy `supabase db push` flow described here applied to the Postgres app schema and is retired (AECI-278). Any remaining Supabase **Auth** baseline reconciliation is the manual `supabase migration repair` decommission step (§10), not a CI auto-apply.

---

## 9. Connection URLs

The former two-URL split (`DATABASE_URL` / `DIRECT_URL`) is **gone** — Prisma Accelerate was retired and Prisma removed entirely (AECI-278). The app database is reached by the API Worker through its native D1 `DB` binding (no `prisma://` URL, no `DATABASE_URL`); the schema source of truth is the Drizzle schema. See `docs/DATABASE_SCHEMA.md` §1a.

For the retained **Supabase Auth** project, the Supabase CLI (when used for the auth-only baseline / `migration repair`) authenticates via the linked project; its link state lives under `supabase/.temp/` and is gitignored.

---

## 10. Common pitfalls

- **Editing a migration after merge.** Never. Write a new forward migration.
- **Reaching for Prisma / `schema.prisma` / `pnpm db:pull`.** Gone (AECI-278). The app schema is the Drizzle schema (`apps/api/src/db/schema.ts`); run `pnpm --filter @aeci/api db:generate` after editing it and commit the generated `apps/api/migrations/*` — see [§0](#0-d1--drizzle-the-target-workflow).
- **Running `supabase migration repair`.** For the shared Supabase **Auth** project, reconciling its live migration history with the new auth-only baseline is a deliberate, coordinated decommission step (AECI-278) — don't repair against the shared project ad hoc.
