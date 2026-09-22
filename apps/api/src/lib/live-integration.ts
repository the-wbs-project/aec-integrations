/**
 * The "live integration" predicate, Drizzle form (AECI-1010 /
 * `STAGE_1_5_SPEC.md` §13.5).
 *
 * An `integrations` row is live when `retired_at IS NULL`. The owner retires and
 * restores it through `routes/vendor-integration-retire.ts`. A retired row keeps its
 * claims and attestations (restore is lossless) but it counts nowhere, it is in no
 * Algolia id set, and it renders on no public surface. The owner and the other
 * endpoint vendor still see it in the portal, marked retired.
 *
 * The raw-SQL twin is `@aeci/shared/live-integration`. The rules in its header apply
 * here too, and the one that bites Drizzle users is rule 1: `eq(col, null)` compiles
 * to `= ?` with a bound NULL, which is never true. Only `isNull` is correct.
 *
 * Column-based ({@link liveIntegrationOn}) so it works over an `alias()` and inside a
 * nested relation `where`, where Drizzle re-aliases base-table columns. A raw `sql`
 * template with a literal alias is NOT re-aliased; those sites use
 * `sql.raw(liveIntegrationSql('bi'))` from the shared module.
 *
 * `connector_evidenced_pairs` has no `retired_at` and never takes this predicate.
 */

import { ApiErrorCode } from '@aeci/shared';
import { eq, isNotNull, isNull, sql, type Column, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrations } from '../db/schema';
import { ApiError } from '../errors';

/** Live over any table object carrying the column, including an `alias()`. */
export function liveIntegrationOn(t: { readonly retiredAt: Column }): SQL {
  return isNull(t.retiredAt);
}

/** Retired over any table object carrying the column. The exact complement. */
export function retiredIntegrationOn(t: { readonly retiredAt: Column }): SQL {
  return isNotNull(t.retiredAt);
}

/** `integrations.retired_at IS NULL`, for the unaliased table. */
export const liveIntegrationWhere: SQL = liveIntegrationOn(integrations);

/** `integrations.retired_at IS NOT NULL`, for the unaliased table. */
export const retiredIntegrationWhere: SQL = retiredIntegrationOn(integrations);

/** The in-memory twin, for rows already loaded. */
export function isLiveIntegration(row: { readonly retiredAt: string | null | undefined }): boolean {
  return row.retiredAt === null || row.retiredAt === undefined;
}

/**
 * Refuse a vendor write on a retired row: `409 INTEGRATION_RETIRED`. The owner's
 * restore is the only write a retired row accepts. Called after the ownership and
 * connector-powered checks, so a caller that could not write the row anyway gets
 * that answer first.
 *
 * Withdrawing an existing attestation (`DELETE …/attestation`) is deliberately not
 * gated, for the reason AECI-705 gave for not gating it on connector-powered rows:
 * withdrawing a position is always allowed.
 */
export function assertIntegrationLive(row: { readonly retiredAt?: string | null }): void {
  if (isLiveIntegration({ retiredAt: row.retiredAt })) return;
  throw integrationRetiredError();
}

/** The `409 INTEGRATION_RETIRED` a write on a retired row answers. */
export function integrationRetiredError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.INTEGRATION_RETIRED,
    'This integration has been retired by its owner. It can be changed again once the owner restores it.',
  );
}

/**
 * A batch statement that ABORTS the batch when the integration is retired at commit
 * time. For writes whose pre-check read the row live but which can commit after a
 * retire landed (a contest submit). Same `json()` abort as the claim and contest
 * sentinels: D1 has no interactive transactions, so a batch cannot branch.
 * {@link isIntegrationRetiredRaceError} recognises it.
 */
export function integrationLiveSentinel(db: Db, integrationId: string) {
  return db
    .select({
      guard: sql`CASE WHEN ${integrations.retiredAt} IS NOT NULL THEN json('integration-retired') END`,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
}

/** True for the error {@link integrationLiveSentinel} raises, in D1 or SQLite. Use it
 *  only in a batch whose other statements call `json()` nowhere else. */
export function isIntegrationRetiredRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes('integration-retired')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
