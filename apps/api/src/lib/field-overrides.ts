/**
 * AECi field locks, the vendor side (AECI-1237, ADR 0039,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5).
 *
 * An AECi admin correction writes one `field_overrides` row with `lifted_at` NULL.
 * While it stands, every vendor write that would change that field on that record
 * answers `409 FIELD_LOCKED_BY_AECI`. This module is the ONE place that rule lives,
 * so the four writers cannot drift:
 *
 *   - `PATCH /api/vendor/profile` and `PATCH /api/vendor/products/:id` (`vendor.ts`);
 *   - `PATCH /api/vendor/integrations/:id`, both anchor tables
 *     (`vendor-integration-edits.ts`, `vendor-evidenced-pair-edits.ts`);
 *   - the contest paths that write the same column: the owner accept
 *     (`vendor-contests.ts`), the AECi accept on a claimed row (`admin-contests.ts`),
 *     and the submit, which no owner could accept (`vendor-contests.ts`).
 *
 * Each writer does two things. It asks {@link lockedFieldsAmong} on its handler read
 * and throws {@link fieldLockedError}, and it puts {@link fieldsUnlockedSentinel} in
 * its batch, so a lock that lands between that read and the batch aborts the write
 * instead of being undone by it. The vendor reads ({@link lockedFieldsByEntity}) give
 * the portal the same list, so it can render those fields read-only.
 */

import {
  ApiErrorCode,
  type FieldOverrideEntityType,
  type FieldOverrideField,
  type IntegrationEditField,
  type LockedField,
  type ProductOverrideField,
  type VendorOverrideField,
} from '@aeci/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  fieldOverrides,
  integrations,
  products,
  vendors,
} from '../db/schema';
import { ApiError } from '../errors';
import { ONE_ROW } from './integration-claims';
import { EDIT_FIELD_COLUMNS } from './integration-contests';

/** The token the sentinel raises. Its presence in the error is how a handler knows. */
export const FIELD_LOCKED_TOKEN = 'field-locked-by-aeci';

/** Wire field → Drizzle column key on `vendors`. */
export const VENDOR_OVERRIDE_COLUMNS = {
  website: 'website',
  headquarters: 'headquarters',
  founded_year: 'foundedYear',
  public_private: 'publicPrivate',
  parent_company: 'parentCompany',
  contact_email: 'contactEmail',
  phone_number: 'phoneNumber',
  linkedin_url: 'linkedinUrl',
  x_url: 'xUrl',
  facebook_url: 'facebookUrl',
  instagram_url: 'instagramUrl',
  youtube_url: 'youtubeUrl',
  crunchbase_url: 'crunchbaseUrl',
  wiki_url: 'wikiUrl',
  github_org: 'githubOrg',
} as const satisfies Record<VendorOverrideField, keyof typeof vendors.$inferSelect>;

/** Wire field → Drizzle column key on `products`. */
export const PRODUCT_OVERRIDE_COLUMNS = {
  website: 'website',
  tool_integrations_url: 'toolIntegrationsUrl',
  api_docs_url: 'apiDocsUrl',
} as const satisfies Record<ProductOverrideField, keyof typeof products.$inferSelect>;

/** The Drizzle column key a lockable field writes on its entity's table. */
export function overrideColumn(
  entityType: FieldOverrideEntityType,
  field: FieldOverrideField,
): string {
  switch (entityType) {
    case 'vendor':
      return VENDOR_OVERRIDE_COLUMNS[field as VendorOverrideField];
    case 'product':
      return PRODUCT_OVERRIDE_COLUMNS[field as ProductOverrideField];
    case 'integration':
    case 'connector_evidenced_pair':
      return EDIT_FIELD_COLUMNS[field as IntegrationEditField];
  }
}

/** The table a lockable entity lives in. */
export function overrideTable(entityType: FieldOverrideEntityType) {
  switch (entityType) {
    case 'vendor':
      return vendors;
    case 'product':
      return products;
    case 'integration':
      return integrations;
    case 'connector_evidenced_pair':
      return connectorEvidencedPairs;
  }
}

/** Every active lock on one entity, as the vendor read shows it. Never the note. */
export async function activeLocksOn(
  db: Db,
  entityType: FieldOverrideEntityType,
  entityId: string,
): Promise<LockedField[]> {
  return (await lockedFieldsByEntity(db, entityType, [entityId])).get(entityId) ?? [];
}

/**
 * Active locks for many entities of one type, keyed by entity id: one read on the
 * partial unique index. An empty id list reads nothing (Drizzle's `inArray` with `[]`
 * emits degenerate SQL).
 */
export async function lockedFieldsByEntity(
  db: Db,
  entityType: FieldOverrideEntityType,
  entityIds: readonly string[],
): Promise<Map<string, LockedField[]>> {
  const out = new Map<string, LockedField[]>();
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      entityId: fieldOverrides.entityId,
      field: fieldOverrides.field,
      reason: fieldOverrides.reason,
      setAt: fieldOverrides.setAt,
    })
    .from(fieldOverrides)
    .where(
      and(
        eq(fieldOverrides.entityType, entityType),
        inArray(fieldOverrides.entityId, ids),
        isNull(fieldOverrides.liftedAt),
      ),
    )
    .orderBy(desc(fieldOverrides.setAt));
  for (const row of rows) {
    const list = out.get(row.entityId) ?? [];
    list.push({ field: row.field, reason: row.reason, set_at: row.setAt });
    out.set(row.entityId, list);
  }
  return out;
}

/** The subset of `fields` that carries an active lock on the entity. */
export async function lockedFieldsAmong(
  db: Db,
  entityType: FieldOverrideEntityType,
  entityId: string,
  fields: readonly string[],
): Promise<string[]> {
  if (fields.length === 0) return [];
  const locked = new Set((await activeLocksOn(db, entityType, entityId)).map((l) => l.field));
  return fields.filter((field) => locked.has(field));
}

/** `409 FIELD_LOCKED_BY_AECI`, naming the locked fields. */
export function fieldLockedError(fields: readonly string[]): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FIELD_LOCKED_BY_AECI,
    'AEC Integrations corrected this field and locked it, so it cannot be changed here. Contact AEC Integrations to dispute the correction.',
    { details: { fields: [...fields] } },
  );
}

/** The handler-side check: throws {@link fieldLockedError} when any field is locked. */
export async function assertFieldsUnlocked(
  db: Db,
  entityType: FieldOverrideEntityType,
  entityId: string,
  fields: readonly string[],
): Promise<void> {
  const locked = await lockedFieldsAmong(db, entityType, entityId, fields);
  if (locked.length > 0) throw fieldLockedError(locked);
}

/**
 * A batch statement that ABORTS the batch when any of `fields` carries an active lock
 * on the entity. The in-batch half of {@link assertFieldsUnlocked}: a lock that lands
 * between the handler's read and the batch must stop the write, or the vendor would
 * undo AECi's correction a moment after it was made. Same `json()` abort as every
 * sentinel here (`claimRaceSentinel`). Selects FROM a one-row constant so it is
 * evaluated exactly once. `null` for an empty field list, which needs no guard.
 */
export function fieldsUnlockedSentinel(
  db: Db,
  entityType: FieldOverrideEntityType,
  entityId: string,
  fields: readonly string[],
) {
  if (fields.length === 0) return null;
  const list = sql.join(
    fields.map((field) => sql`${field}`),
    sql`, `,
  );
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM "field_overrides"
          WHERE "entity_type" = ${entityType} AND "entity_id" = ${entityId}
            AND "lifted_at" IS NULL AND "field" IN (${list}))
        THEN json(${FIELD_LOCKED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/**
 * After a batch failed on a sentinel: re-read the locks and answer the 409 if one of
 * `fields` is now locked, else `null` so the caller answers its own race. The json
 * abort does not say which sentinel raised it, so the re-read decides.
 */
export async function lockRaceRefusal(
  db: Db,
  entityType: FieldOverrideEntityType,
  entityId: string,
  fields: readonly string[],
): Promise<ApiError | null> {
  const locked = await lockedFieldsAmong(db, entityType, entityId, fields);
  return locked.length > 0 ? fieldLockedError(locked) : null;
}

/** True when a batch error is a sentinel's `json()` abort, in D1 or SQLite. */
export function isSentinelJsonAbort(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(FIELD_LOCKED_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Screen a company or product PATCH body against the record's locks. A locked field
 * sent with the value already stored is dropped (it changes nothing, so it is not an
 * attempt to undo the correction); a locked field sent with a different value is
 * refused. Returns the body without the dropped fields, and the refused field names.
 */
export function screenLockedPatch<T extends Record<string, unknown>>(
  payload: T,
  locks: readonly LockedField[],
  stored: Record<string, unknown>,
  columns: Readonly<Record<string, string>>,
): { payload: T; refused: string[] } {
  const next: Record<string, unknown> = { ...payload };
  const refused: string[] = [];
  for (const lock of locks) {
    if (!(lock.field in next)) continue;
    const column = columns[lock.field];
    const current = column === undefined ? undefined : (stored[column] ?? null);
    if (current !== undefined && (next[lock.field] ?? null) === current) {
      delete next[lock.field];
    } else {
      refused.push(lock.field);
    }
  }
  return { payload: next as T, refused };
}
