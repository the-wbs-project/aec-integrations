/**
 * The `data_object` controlled vocabulary — find-only resolution, in one place
 * (Stage 1.5 §6.2 / `docs/DATA_OBJECT_VOCABULARY.md`).
 *
 * `taxonomy_data_objects` is a **frozen, closed** 27-term list, seeded from
 * `apps/api/seed/data-objects.sql`. A claim's `dataObject` resolves against it by
 * slug **or** alias, and **never** find-or-create: minting a term is an AECi
 * curation act, and neither promote nor a vendor may do it
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §5.2).
 *
 * This module exists because there are now **two** callers with the same matching
 * rule and different failure modes, and one shared rule is the only way they stay
 * in agreement:
 *
 *   - `POST /api/promote` is a **batch job**, so an unmatched term lands in
 *     `skipped[]` with `kind: 'claim'` and the rest of the payload still commits.
 *   - `POST /api/vendor/claims` (AECI-301) is an **interactive** caller, so an
 *     unmatched term is a `400 VALIDATION_FAILED` naming the field — a vendor
 *     that mistypes a term must be told, not silently ignored.
 *
 * The *matching* is identical in both; only what the caller does with a miss
 * differs. Resolution therefore lives here and the branch lives at the call site.
 */

import { slugify } from '@aeci/shared/slug';
import { asc, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { taxonomyDataObjects } from '../db/schema';

/**
 * Slugify for matching, never throwing.
 *
 * Term resolution looks an input `slug`/`name` up against existing rows; an input
 * that maps to a reserved or empty slug simply cannot match anything, so this
 * returns `null` (→ unresolvable) rather than 500-ing the caller the way a bare
 * `slugify` would. Promote's usefulness/facet resolution uses it for the same
 * reason.
 */
export function safeSlugify(value: string): string | null {
  try {
    return slugify(value);
  } catch {
    return null;
  }
}

/** The matched vocabulary term. `slug`/`name` ride along because the vendor
 *  authoring API echoes them on the created claim, and re-reading the row it just
 *  matched would be a second D1 hop for data already in memory. */
export interface DataObjectTerm {
  id: string;
  slug: string;
  name: string;
}

/** Resolve one `data_object` reference to its vocabulary term, or `undefined`
 *  when the vocabulary has no match. */
export type DataObjectResolver = (value: string) => DataObjectTerm | undefined;

/**
 * Load the vocabulary and return a synchronous resolver over it.
 *
 * One `SELECT` for the whole 27-row table rather than a query per lookup: the
 * aliases live in a JSON column, so slug-or-alias matching cannot be pushed into
 * SQL without a scan anyway, and promote resolves many terms per request.
 * Callers that may not need it at all (promote skips the load unless a claim is
 * actually present) should gate the call, not the resolver.
 *
 * Two matching rules, preserved exactly from the promote implementation this
 * replaces:
 *
 *   - **`safeSlugify` normalizes both sides**, so case and spacing do not matter
 *     — `"RFIs"`, `"rfis"` and `"  R F Is"` all reduce to the same key.
 *   - **First write wins**, and rows are read slug-before-aliases, so a term's
 *     own slug always beats another term's alias for the same key. The vocabulary
 *     is curated to avoid the collision; this makes the tie-break deterministic
 *     rather than dependent on row order.
 */
export async function loadDataObjectResolver(db: Db): Promise<DataObjectResolver> {
  const rows = await db
    .select({
      id: taxonomyDataObjects.id,
      slug: taxonomyDataObjects.slug,
      name: taxonomyDataObjects.name,
      aliases: taxonomyDataObjects.aliases,
    })
    .from(taxonomyDataObjects);

  const termByKey = new Map<string, DataObjectTerm>();
  const addKey = (value: string | null | undefined, term: DataObjectTerm) => {
    const key = value ? safeSlugify(value) : null;
    if (key && !termByKey.has(key)) termByKey.set(key, term);
  };
  for (const row of rows) {
    const term: DataObjectTerm = { id: row.id, slug: row.slug, name: row.name };
    addKey(row.slug, term);
    for (const alias of row.aliases ?? []) addKey(alias, term);
  }

  return (value: string) => {
    const key = safeSlugify(value);
    return key ? termByKey.get(key) : undefined;
  };
}

/** One vocabulary term as an enumeration, rather than as a matcher key. Shaped
 *  to `DataObjectOption` on the wire (`@aeci/shared`) — no `id`, no
 *  `display_order`, and deliberately no `aliases`; see that schema's doc comment
 *  for why each is excluded. */
export interface DataObjectListing {
  slug: string;
  name: string;
  description: string | null;
}

/**
 * The whole vocabulary as an ordered list, for `GET /api/vendor/data-objects`
 * (AECI-606 / §6 — the dashboard offers the closed list rather than free text).
 *
 * This is a second export rather than a second reader of `taxonomy_data_objects`
 * elsewhere: this module's job is to be the one place that knows the table, and
 * keeping the enumeration here is what stops a future editor from adding
 * `aliases` to a route's column list without seeing why they are withheld.
 *
 * `loadDataObjectResolver` cannot serve this. It returns a matcher closure over
 * an alias-folded `Map` keyed by `safeSlugify` output, drops `description` and
 * `display_order`, and applies a first-write-wins tie-break that is meaningless
 * for an enumeration — an ordered term list is not recoverable from it.
 *
 * **Ordering must match `createListVendorIntegrationsHandler`'s claim sort**
 * (`routes/vendor-attestations.ts`), which coerces a null `display_order` to
 * `Number.MAX_SAFE_INTEGER` in JS — i.e. **NULLs last**. SQLite sorts NULLs
 * *first* by default, so the `IS NULL` term below is load-bearing, not
 * decorative: without it this list and the tab's lanes would disagree on any
 * hand-inserted row. (All 27 seeded terms carry a `display_order`, which is
 * exactly what would make the divergence invisible until it wasn't.)
 *
 * Note that **today's only consumer does not observe this order.** The vendor
 * dashboard's picker re-sorts alphabetically by label client-side, on the
 * argument that finding a known term is a different job from reading a lane list
 * (`vendor-add-claim-form.ts`, `dataObjectOptions`). The wire order stays
 * lifecycle-ordered anyway, and is pinned by a spec: an endpoint returning a
 * documented list should have one defined order rather than whatever the planner
 * picks, and the next consumer that renders these rows *as lanes* — where the
 * lifecycle grouping is the point — needs it to already be right.
 *
 * No memoisation. Twenty rows off one indexed table, and a module-level isolate
 * cache would go stale across a re-seed with no invalidation path —
 * `loadDataObjectResolver` already reads the full table per `POST
 * /api/vendor/claims`, so this matches the posture beside it.
 */
export async function listDataObjectTerms(db: Db): Promise<DataObjectListing[]> {
  return db
    .select({
      slug: taxonomyDataObjects.slug,
      name: taxonomyDataObjects.name,
      description: taxonomyDataObjects.description,
    })
    .from(taxonomyDataObjects)
    .orderBy(
      sql`${taxonomyDataObjects.displayOrder} IS NULL`,
      asc(taxonomyDataObjects.displayOrder),
      asc(taxonomyDataObjects.slug),
    );
}
